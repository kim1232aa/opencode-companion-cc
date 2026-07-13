// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Long prompts must NOT go through global fetch(): Node's bundled undici
// enforces a hidden 300_000 ms default bodyTimeout that kills the socket
// mid-response (surfacing as an opaque "fetch failed" / "terminated")
// well before any AbortSignal.timeout we set — so a >5 min task on a slow
// model dies at exactly 5m00s. node:http has no such default, so the
// prompt POST goes through httpPostJson() below and is bounded only by the
// explicit wall-clock timer we pass. (Approach harvested from the
// JohnnyVicious/opencode-plugin-cc fork, which hit the same bug.)
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

function resolvePromptTimeoutMs() {
  const fromEnv = Number(process.env.OPENCODE_COMPANION_PROMPT_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_PROMPT_TIMEOUT_MS;
}

/**
 * POST a JSON body via node:http/https (NOT fetch) and return the raw
 * response, bounded only by an explicit wall-clock timer.
 * @param {string} urlString
 * @param {Record<string,string>} headers
 * @param {unknown} bodyObj
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, body: string }>}
 */
function httpPostJson(urlString, headers, bodyObj, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : resolvePromptTimeoutMs();
  const url = new URL(urlString);
  const lib = url.protocol === "https:" ? https : http;
  const payload = Buffer.from(JSON.stringify(bodyObj), "utf8");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        method: "POST",
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, "Content-Length": payload.length },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => finish(resolve, { status: res.statusCode ?? 0, body: data }));
        res.on("error", (err) => finish(reject, err));
      }
    );

    req.on("error", (err) => finish(reject, err));
    timer = setTimeout(() => {
      finish(reject, new Error(
        `OpenCode prompt exceeded ${Math.round(timeoutMs / 1000)}s wall-clock timeout ` +
          `(raise OPENCODE_COMPANION_PROMPT_TIMEOUT_MS to allow longer tasks)`
      ));
      req.destroy();
    }, timeoutMs);

    req.write(payload);
    req.end();
  });
}

/**
 * Check if an OpenCode server is already running on the given port.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://${host}:${port}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the OpenCode server if not already running.
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean }>}
 */
export async function ensureServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://${host}:${port}`;

  if (await isServerRunning(host, port)) {
    return { url, alreadyRunning: true };
  }

  // Start the server
  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd: opts.cwd,
    // websearch is otherwise a no-op on custom (non-"opencode/*") providers
    // unless this is set — see https://opencode.ai/docs/tools/
    env: { ...process.env, OPENCODE_ENABLE_EXA: "1" },
  });

  // Drain stdout/stderr into a bounded tail buffer. Two reasons: (1) leaving
  // "pipe" without a reader lets the OS pipe buffer fill and BLOCK the child
  // (a latent hang); (2) capturing the tail lets us surface *why* startup
  // failed instead of an opaque timeout.
  let diagTail = "";
  const drain = (chunk) => {
    diagTail = (diagTail + chunk.toString()).slice(-2000);
  };
  proc.stdout?.on("data", drain);
  proc.stderr?.on("data", drain);
  let spawnError = null;
  proc.on("error", (err) => { spawnError = err; });
  proc.unref();

  // Wait for the server to become ready
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Failed to spawn 'opencode serve': ${spawnError.message}`);
    }
    if (await isServerRunning(host, port)) {
      return { url, pid: proc.pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const detail = diagTail.trim() ? `\nLast output:\n${diagTail.trim()}` : "";
  throw new Error(`OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s${detail}`);
}

/**
 * Convert a CLI-style "provider/model" string into the {providerID, modelID}
 * object the OpenCode REST API requires. Only the first slash is significant
 * so custom-provider model IDs that themselves contain slashes still round-trip.
 * @param {string} modelRef
 * @returns {{ providerID: string, modelID: string }}
 */
function parseModelRef(modelRef) {
  const idx = modelRef.indexOf("/");
  if (idx === -1) {
    throw new Error(`--model must be in the form provider/model, got: ${modelRef}`);
  }
  return { providerID: modelRef.slice(0, idx), modelID: modelRef.slice(idx + 1) };
}

const PERMISSION_POLL_INTERVAL_MS = 3000;

/**
 * Poll GET /permission and auto-reject any pending request for this session.
 *
 * OpenCode's permission gate (e.g. "external_directory" for paths outside the
 * session's own workspace) defaults to asking for interactive approval. This
 * companion runtime has no human attached to answer that ask, so left alone
 * the session hangs until the outer request's own timeout (5-10 min) finally
 * fails it with an opaque error. Since nothing can ever answer the prompt in
 * this headless context, reject on first sighting instead of waiting — the
 * agent gets a normal tool-error it can react to (retry differently, or just
 * report the limitation) rather than the whole dispatch dying silently.
 *
 * @param {string} baseUrl
 * @param {Record<string,string>} headers
 * @param {string} sessionId
 * @returns {{ stop: () => void }}
 */
function watchAndRejectPermissions(baseUrl, headers, sessionId) {
  let stopped = false;
  const handled = new Set();

  (async () => {
    while (!stopped) {
      try {
        const res = await fetch(`${baseUrl}/permission`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const pending = await res.json();
          for (const p of pending) {
            if (p.sessionID !== sessionId || handled.has(p.id)) continue;
            handled.add(p.id);
            const patterns = Array.isArray(p.patterns) ? p.patterns.join(", ") : "";
            await fetch(`${baseUrl}/permission/${p.id}/reply`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                reply: "reject",
                message: `Auto-rejected by opencode-companion: this is a headless dispatch with no one able to approve a "${p.permission}" prompt${patterns ? ` (${patterns})` : ""}.`,
              }),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
          }
        }
      } catch {
        // Transient poll failure — try again next tick.
      }
      await new Promise((r) => setTimeout(r, PERMISSION_POLL_INTERVAL_MS));
    }
  })();

  return { stop: () => { stopped = true; } };
}

/**
 * Create an API client bound to a running OpenCode server.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory for x-opencode-directory header
 * @returns {OpenCodeClient}
 */
export function createClient(baseUrl, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (opts.directory) {
    headers["x-opencode-directory"] = opts.directory;
  }
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const cred = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }

  async function request(method, path, body, timeoutMs = 300_000) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl,

    // Health
    health: () => request("GET", "/global/health"),

    // Sessions
    listSessions: () => request("GET", "/session"),
    // On a busy shared daemon (multiple Claude Code windows dispatching
    // concurrently), session creation itself can queue behind other work
    // for longer than the generic 5-minute default — well before the
    // prompt's own 10-minute budget (below) even starts. Give it the same
    // ceiling so it doesn't fail out from under a request that hasn't
    // actually begun yet.
    createSession: (opts = {}) => request("POST", "/session", opts, 600_000),
    getSession: (id) => request("GET", `/session/${id}`),
    deleteSession: (id) => request("DELETE", `/session/${id}`),
    abortSession: (id) => request("POST", `/session/${id}/abort`),
    getSessionStatus: () => request("GET", "/session/status"),
    getSessionDiff: (id) => request("GET", `/session/${id}/diff`),

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.before) params.set("before", opts.before);
      const qs = params.toString();
      return request("GET", `/session/${sessionId}/message${qs ? "?" + qs : ""}`);
    },

    /**
     * Send a prompt (synchronous / streaming).
     * Returns the full response text from SSE stream.
     */
    sendPrompt: async (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = parseModelRef(opts.model);
      if (opts.system) body.system = opts.system;

      const permissionWatcher = watchAndRejectPermissions(baseUrl, headers, sessionId);
      let status, responseText;
      try {
        // node:http, not fetch — see httpPostJson / undici bodyTimeout note above.
        ({ status, body: responseText } = await httpPostJson(
          `${baseUrl}/session/${sessionId}/message`,
          headers,
          body
        ));
      } finally {
        permissionWatcher.stop();
      }

      if (status < 200 || status >= 300) {
        throw new Error(`OpenCode prompt failed ${status}: ${responseText}`);
      }

      try {
        return JSON.parse(responseText);
      } catch (err) {
        throw new Error(`OpenCode prompt returned non-JSON response (${status}): ${err.message}`);
      }
    },

    /**
     * Send a prompt asynchronously (returns immediately).
     */
    sendPromptAsync: (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = parseModelRef(opts.model);
      return request("POST", `/session/${sessionId}/prompt_async`, body);
    },

    // Agents
    listAgents: () => request("GET", "/agent"),

    // Providers
    listProviders: () => request("GET", "/provider"),
    getProviderAuth: () => request("GET", "/provider/auth"),

    // Config
    getConfig: () => request("GET", "/config"),

    // Events (SSE) - returns a ReadableStream
    subscribeEvents: async () => {
      const res = await fetch(`${baseUrl}/event`, {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      return res.body;
    },
  };
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const { url } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd });
  return { ...client, serverInfo: { url } };
}

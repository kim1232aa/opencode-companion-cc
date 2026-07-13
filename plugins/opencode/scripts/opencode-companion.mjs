#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached } from "./lib/process.mjs";
import { isServerRunning, ensureServer, createClient, connect } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, generateJobId, jobDataPath } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveCancelableJob, enrichJob, reconcileStrandedJobs, pidStartTime, isOwnedProcessAlive } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderSetup, formatUsage } from "./lib/render.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { withWorktree } from "./lib/worktree.mjs";
import { getDiff, getStatus as getGitStatus } from "./lib/git.mjs";
import { readJson } from "./lib/fs.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

// Single source for the loopback daemon URL (was hardcoded at several sites).
function defaultServerUrl() {
  const port = Number(process.env.OPENCODE_SERVER_PORT) || 4096;
  return `http://127.0.0.1:${port}`;
}

// ------------------------------------------------------------------
// Subcommand dispatch
// ------------------------------------------------------------------

const [subcommand, ...argv] = process.argv.slice(2);

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "wait-and-result": handleWaitAndResult,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  result: handleResult,
  cancel: handleCancel,
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler(argv).catch((err) => {
  console.error(`Error in ${subcommand}: ${err.message}`);
  process.exit(1);
});

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;

  let serverRunning = false;
  let providers = [];

  if (installed) {
    serverRunning = await isServerRunning();

    if (serverRunning) {
      try {
        const client = createClient(defaultServerUrl());
        const providerList = await client.listProviders();
        // /provider returns { all, default, connected }, not a bare array.
        const list = Array.isArray(providerList) ? providerList : (providerList?.all ?? []);
        providers = list.map((p) => p.id ?? p.name).filter(Boolean);
      } catch {
        // Server may not be fully ready
      }
    }
  }

  // Handle review gate toggle
  const workspace = await resolveWorkspace();
  let reviewGate = false;

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    console.error("Pass only one of --enable-review-gate or --disable-review-gate.");
    process.exit(1);
  }

  if (options["enable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = true;
    });
    reviewGate = true;
  } else if (options["disable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = false;
    });
    reviewGate = false;
  } else {
    const state = loadState(workspace);
    reviewGate = state.config?.reviewGate ?? false;
  }

  const status = { installed, version, serverRunning, providers, reviewGate };

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(renderSetup(status));
  }
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

async function handleReview(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["base", "model"],
    booleanOptions: ["wait", "background"],
  });

  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "review", { base: options.base, model: options.model });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating review session...");
      const session = await client.createSession({ title: `Code Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: false,
      }, PLUGIN_ROOT);

      report("reviewing", "Running review...");
      log(`Prompt length: ${prompt.length} chars${options.model ? `, model: ${options.model}` : ""}`);

      const response = await client.sendPrompt(session.id, prompt, {
        agent: "plan", // read-only agent for reviews
        model: options.model,
      });

      report("finalizing", "Processing review output...");

      // Try to parse structured output
      const text = extractResponseText(response);
      let structured = tryParseJson(text);
      const usage = await client.getSessionUsage(session.id).catch(() => null);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
        usage,
      };
    });

    console.log(result.rendered);
    const usageLine = formatUsage(result.usage);
    if (usageLine) console.log(`\n---\n${usageLine}`);
  } catch (err) {
    console.error(`Review failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleAdversarialReview(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["base", "model"],
    booleanOptions: ["wait", "background"],
  });

  const focus = positional.join(" ").trim();
  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "adversarial-review", {
    base: options.base,
    focus,
    model: options.model,
  });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating adversarial review session...");
      const session = await client.createSession({ title: `Adversarial Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: true,
        focus,
      }, PLUGIN_ROOT);

      report("reviewing", "Running adversarial review...");
      log(`Prompt length: ${prompt.length} chars, focus: ${focus || "(none)"}${options.model ? `, model: ${options.model}` : ""}`);

      const response = await client.sendPrompt(session.id, prompt, {
        agent: "plan",
        model: options.model,
      });

      report("finalizing", "Processing review output...");

      const text = extractResponseText(response);
      let structured = tryParseJson(text);
      const usage = await client.getSessionUsage(session.id).catch(() => null);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
        usage,
      };
    });

    console.log(result.rendered);
    const usageLine = formatUsage(result.usage);
    if (usageLine) console.log(`\n---\n${usageLine}`);
  } catch (err) {
    console.error(`Adversarial review failed: ${err.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Task (rescue delegation)
// ------------------------------------------------------------------

async function handleTask(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["model", "agent"],
    booleanOptions: ["write", "background", "wait", "resume-last", "fresh", "worktree"],
  });

  const taskText = extractTaskText(argv, ["model", "agent"], [
    "write", "background", "wait", "resume-last", "fresh", "worktree",
  ]);

  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  // parseArgs can only ever produce options.write === true or undefined
  // (booleans have no negation syntax), so deriving isWrite from it can
  // never yield false — derive it from the resolved agent instead, since
  // --agent plan is the only mechanism that actually toggles read-only.
  const agentName = options.agent ?? "build";
  const isWrite = agentName !== "plan";
  const useWorktree = !!options.worktree;

  // Check for resume
  let resumeSessionId = null;
  if (options["resume-last"]) {
    const state = loadState(workspace);
    const sessionId = getClaudeSessionId();
    const lastTask = state.jobs
      ?.filter((j) => j.type === "task" && j.opencodeSessionId)
      ?.filter((j) => !sessionId || j.sessionId === sessionId)
      ?.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))?.[0];

    if (lastTask?.opencodeSessionId) {
      resumeSessionId = lastTask.opencodeSessionId;
    }
  }

  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
  });

  // Background mode: spawn a detached worker
  if (options.background) {
    const workerArgs = [
      path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"),
      "task-worker",
      "--job-id", job.id,
      "--workspace", workspace,
      "--task-text", taskText,
      "--agent", agentName,
    ];
    if (isWrite) workerArgs.push("--write");
    if (useWorktree) workerArgs.push("--worktree");
    if (resumeSessionId) workerArgs.push("--resume-session", resumeSessionId);
    if (options.model) workerArgs.push("--model", options.model);

    const bgChild = spawnDetached("node", workerArgs, { cwd: workspace });
    if (bgChild?.pid) {
      upsertJob(workspace, { id: job.id, pid: bgChild.pid, pidStart: pidStartTime(bgChild.pid) });
    }
    console.log(`OpenCode task started in background: ${job.id}`);
    console.log("Check `/opencode:status` for progress.");
    return;
  }

  // Foreground mode
  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) =>
      withWorktree({ dir: workspace, jobId: job.id, useWorktree, isWrite }, async (effectiveCwd) => {
        report("starting", "Connecting to OpenCode server...");
        const client = await connect({ cwd: effectiveCwd });

        let sessionId;
        if (resumeSessionId) {
          report("starting", `Resuming OpenCode session ${resumeSessionId}...`);
          sessionId = resumeSessionId;
        } else {
          report("starting", "Creating new OpenCode session...");
          const session = await client.createSession({ title: `Task ${job.id}` });
          sessionId = session.id;
        }
        upsertJob(workspace, { id: job.id, opencodeSessionId: sessionId });

        const prompt = buildTaskPrompt(taskText, { write: isWrite });

        report("investigating", "Sending task to OpenCode...");
        log(`Agent: ${agentName}, Write: ${isWrite}, Prompt: ${prompt.length} chars, Model: ${options.model ?? "(provider default)"}`);

        const response = await client.sendPrompt(sessionId, prompt, {
          agent: agentName,
          model: options.model,
        });

        report("finalizing", "Processing task output...");

        const text = extractResponseText(response);
        const usage = await client.getSessionUsage(sessionId).catch(() => null);

        // Get changed files if write mode
        let changedFiles = [];
        if (isWrite) {
          try {
            const diff = await client.getSessionDiff(sessionId);
            if (diff?.files) {
              changedFiles = diff.files.map((f) => f.path || f.name).filter(Boolean);
            }
          } catch {
            // diff endpoint may not be available
          }
        }

        return {
          rendered: text,
          messages: response,
          changedFiles,
          usage,
          summary: text.slice(0, 500),
        };
      }, log));

    console.log(result.rendered);
    const usageLine = formatUsage(result.usage);
    if (usageLine) console.log(`\n---\n${usageLine}`);
    if (result.changedFiles?.length) {
      console.log(`\nChanged files:\n${result.changedFiles.map((f) => `- ${f}`).join("\n")}`);
    }
  } catch (err) {
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}

// Dispatch a task on a detached worker (so it is tracked, survivable, and
// visible to status/result/cancel) but BLOCK until it reaches a terminal
// state and then print the full result. This is the reliable "delegate AND
// get the result back in one call" path — the caller never has to poll a
// job-id or guess which session/cwd the result landed under (the exact pain
// that made background review results so hard to collect).
async function handleWaitAndResult(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["model", "agent", "timeout-ms"],
    booleanOptions: ["write", "resume-last", "fresh", "worktree"],
  });
  const taskText = extractTaskText(argv, ["model", "agent", "timeout-ms"], [
    "write", "resume-last", "fresh", "worktree",
  ]);
  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const agentName = options.agent ?? "build";
  const isWrite = agentName !== "plan";
  const useWorktree = !!options.worktree;

  let resumeSessionId = null;
  if (options["resume-last"]) {
    const state = loadState(workspace);
    const sid = getClaudeSessionId();
    const lastTask = state.jobs
      ?.filter((j) => j.type === "task" && j.opencodeSessionId)
      ?.filter((j) => !sid || j.sessionId === sid)
      ?.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))?.[0];
    if (lastTask?.opencodeSessionId) resumeSessionId = lastTask.opencodeSessionId;
  }

  const job = createJobRecord(workspace, "task", { agent: agentName, resumeSessionId });

  const workerArgs = [
    path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"),
    "task-worker",
    "--job-id", job.id,
    "--workspace", workspace,
    "--task-text", taskText,
    "--agent", agentName,
  ];
  if (isWrite) workerArgs.push("--write");
  if (useWorktree) workerArgs.push("--worktree");
  if (resumeSessionId) workerArgs.push("--resume-session", resumeSessionId);
  if (options.model) workerArgs.push("--model", options.model);

  const child = spawnDetached("node", workerArgs, { cwd: workspace });
  if (child?.pid) upsertJob(workspace, { id: job.id, pid: child.pid, pidStart: pidStartTime(child.pid) });

  const timeoutMs = Number(options["timeout-ms"]) > 0
    ? Number(options["timeout-ms"])
    : Number(process.env.OPENCODE_COMPANION_WAIT_TIMEOUT_MS) || 35 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1500;

  const printTerminal = (st) => {
    if (st.status === "completed") {
      const data = readJson(jobDataPath(workspace, job.id));
      console.log(data?.rendered ?? st.result ?? "(task completed with no output)");
      return true;
    }
    if (st.status === "failed") {
      console.error(`Task ${job.id} failed: ${st.errorMessage ?? "unknown error"}`);
      process.exit(1);
    }
    return false;
  };

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const st = loadState(workspace).jobs?.find((j) => j.id === job.id);
    if (!st) continue;
    if (printTerminal(st)) return;

    // Fail fast if the detached worker died without writing a terminal status.
    // Ownership-aware: a recycled pid (different start-time) counts as gone.
    if (st.pid && !isOwnedProcessAlive(st.pid, st.pidStart)) {
      const again = loadState(workspace).jobs?.find((j) => j.id === job.id);
      if (again && printTerminal(again)) return;
      console.error(`Task ${job.id} worker (pid ${st.pid}) exited without completing.`);
      process.exit(1);
    }
  }

  console.error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${job.id}. ` +
    `It may still finish — check \`/opencode:status\` and \`/opencode:result ${job.id}\`.`
  );
  process.exit(1);
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["job-id", "workspace", "task-text", "agent", "model", "resume-session"],
    booleanOptions: ["write", "worktree"],
  });

  const workspace = options.workspace;
  const jobId = options["job-id"];
  const taskText = options["task-text"];
  const agentName = options.agent ?? "build";
  const isWrite = !!options.write;
  const useWorktree = !!options.worktree;
  const resumeSessionId = options["resume-session"];

  if (!workspace || !jobId || !taskText) {
    process.exit(1);
  }

  try {
    await runTrackedJob(workspace, { id: jobId }, async ({ report, log }) =>
      withWorktree({ dir: workspace, jobId, useWorktree, isWrite }, async (effectiveCwd) => {
        report("starting", "Background worker connecting to OpenCode...");
        const client = await connect({ cwd: effectiveCwd });

        let sessionId;
        if (resumeSessionId) {
          sessionId = resumeSessionId;
          report("starting", `Resuming session ${resumeSessionId}...`);
        } else {
          const session = await client.createSession({ title: `Task ${jobId}` });
          sessionId = session.id;
          report("starting", `Created session ${sessionId}`);
        }
        upsertJob(workspace, { id: jobId, opencodeSessionId: sessionId });

        const prompt = buildTaskPrompt(taskText, { write: isWrite });
        report("investigating", "Running task...");

        const response = await client.sendPrompt(sessionId, prompt, {
          agent: agentName,
          model: options.model,
        });

        const text = extractResponseText(response);
        const usage = await client.getSessionUsage(sessionId).catch(() => null);
        report("finalizing", "Done");

        return { rendered: text, usage, summary: text.slice(0, 500) };
      }, log));
  } catch (err) {
    // Error is already logged by runTrackedJob
    process.exit(1);
  }
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  const lastTask = state.jobs
    ?.filter((j) => j.type === "task" && j.opencodeSessionId)
    ?.filter((j) => j.status === "completed" || j.status === "running")
    ?.filter((j) => !sessionId || j.sessionId === sessionId)
    ?.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))?.[0];

  const result = {
    available: !!lastTask,
    jobId: lastTask?.id ?? null,
    opencodeSessionId: lastTask?.opencodeSessionId ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.available ? `Resumable session: ${result.opencodeSessionId}` : "No resumable session.");
  }
}

// ------------------------------------------------------------------
// Status / Result / Cancel
// ------------------------------------------------------------------

async function handleStatus(argv) {
  const workspace = await resolveWorkspace();
  const sessionId = getClaudeSessionId();

  // Recover any job whose worker died without writing a terminal status, so a
  // crashed background task stops showing as a phantom "running" forever.
  const jobs = reconcileStrandedJobs(workspace, loadState(workspace).jobs ?? []);

  const snapshot = buildStatusSnapshot(jobs, workspace, { sessionId });
  console.log(renderStatus(snapshot));
}

// Job references come from slash-command $ARGUMENTS; keep them to a safe
// id/prefix shape so nothing surprising flows into lookups or output.
function isSafeJobRef(ref) {
  return typeof ref === "string" && /^[A-Za-z0-9._:-]+$/.test(ref);
}

async function handleResult(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];
  if (ref && !isSafeJobRef(ref)) {
    console.error("Invalid job reference. Use a job ID or safe ID prefix.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const sessionId = getClaudeSessionId();
  const jobs = reconcileStrandedJobs(workspace, loadState(workspace).jobs ?? []);

  const { job, ambiguous } = resolveResultJob(jobs, ref, { sessionId });

  if (ambiguous) {
    console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
    process.exit(1);
  }

  if (!job) {
    const anyRunning = jobs.some((j) => j.status === "running" || j.status === "pending");
    console.log(anyRunning
      ? "No finished job yet — a job is still running. Try `/opencode:status`."
      : "No finished job found.");
    return;
  }

  const enriched = enrichJob(job, workspace);

  // Try to load detailed result data
  const dataFile = jobDataPath(workspace, job.id);
  const resultData = readJson(dataFile);

  console.log(renderResult(enriched, resultData));
}

async function handleCancel(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];
  if (ref && !isSafeJobRef(ref)) {
    console.error("Invalid job reference. Use a job ID or safe ID prefix.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const sessionId = getClaudeSessionId();
  const jobs = reconcileStrandedJobs(workspace, loadState(workspace).jobs ?? []);

  const { job, ambiguous } = resolveCancelableJob(jobs, ref, { sessionId });

  if (ambiguous) {
    console.error("Multiple running jobs. Please specify a job ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No active job to cancel.");
    return;
  }

  // Abort the OpenCode session if we have one
  if (job.opencodeSessionId) {
    try {
      const client = createClient(defaultServerUrl());
      await client.abortSession(job.opencodeSessionId);
    } catch {
      // Server may not be running
    }
  }

  // Kill the worker only if its pid is still alive AND still the process we
  // spawned. isOwnedProcessAlive compares the recorded kernel start-time
  // fingerprint, so a pid recycled by an unrelated process is not signalled.
  // (When the fingerprint is unavailable — non-Linux — it degrades to a bare
  // liveness check, matching the old best-effort behavior.)
  if (job.pid && isOwnedProcessAlive(job.pid, job.pidStart)) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // race: gone between the liveness check and the signal
    }
  }

  upsertJob(workspace, {
    id: job.id,
    status: "canceled",
    completedAt: new Date().toISOString(),
    errorMessage: "Canceled by user",
  });

  console.log(`Canceled job: ${job.id}`);
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Extract text from an OpenCode API response.
 * @param {any} response
 * @returns {string}
 */
function extractResponseText(response) {
  if (typeof response === "string") return response;

  // Response shape: { info: { ... }, parts: [ { type: "text", text: "..." }, ... ] }
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  // Fallback: try info.content or just stringify
  if (response?.info?.content) {
    if (typeof response.info.content === "string") return response.info.content;
    if (Array.isArray(response.info.content)) {
      return response.info.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  }

  return JSON.stringify(response, null, 2);
}

/**
 * Try to parse a string as JSON, returning null on failure.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  if (typeof text !== "string") return null;
  const candidates = [];

  // All fenced blocks — prefer ```json-tagged ones, then any fenced block.
  const fences = [...text.matchAll(/```(json)?\s*\n([\s\S]*?)```/g)];
  for (const m of fences) {
    if (m[1]) candidates.push(m[2]); // json-tagged first
  }
  for (const m of fences) {
    if (!m[1]) candidates.push(m[2]);
  }
  // Bare object/array spanning the first "{"/"[" to the last "}"/"]".
  const braceStart = text.search(/[[{]/);
  if (braceStart !== -1) {
    const braceEnd = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (braceEnd > braceStart) candidates.push(text.slice(braceStart, braceEnd + 1));
  }
  candidates.push(text); // last resort: the whole thing

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      // try the next candidate
    }
  }
  return null;
}

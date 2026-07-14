// File-system-based persistent state for the OpenCode companion.
// Mirrors the codex-plugin-cc state.mjs pattern: SHA-256 hash of workspace path,
// JSON state file, per-job files and logs.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readJson, writeJson, withFileLock } from "./fs.mjs";

const MAX_JOBS = 50;

/**
 * Derive THIS plugin's own data dir from the script's install path, instead of
 * blindly trusting process.env.CLAUDE_PLUGIN_DATA. That env var is exported by
 * whichever plugin's shell wrapper last ran, so if another companion plugin
 * (e.g. codex) set it, our job state would silently be written into *their*
 * data dir — where our own status/result/cancel can never find it again.
 * Claude Code installs plugins at
 *   <root>/plugins/cache/<owner>-<repo>/<plugin>/<version>/scripts/lib/state.mjs
 * and gives each plugin its own data dir at
 *   <root>/plugins/data/<plugin>-<owner>-<repo>/
 * Returns null when the path layout doesn't match (dev/source checkout).
 * @returns {string|null}
 */
function deriveOwnDataDir() {
  try {
    const parts = fileURLToPath(import.meta.url).split(path.sep);
    const cacheIdx = parts.lastIndexOf("cache");
    if (cacheIdx < 1 || cacheIdx + 3 >= parts.length) return null;
    const ownerRepo = parts[cacheIdx + 1];
    const pluginName = parts[cacheIdx + 2];
    const rootBase = parts.slice(0, cacheIdx).join(path.sep);
    return path.join(rootBase, "data", `${pluginName}-${ownerRepo}`);
  } catch {
    return null;
  }
}

/**
 * The directory that holds EVERY workspace's state dir (one hashed subdir each).
 * Data-dir priority:
 *   1. OPENCODE_COMPANION_DATA (explicit opt-in override)
 *   2. our own install-derived data dir
 *   3. CLAUDE_PLUGIN_DATA — ONLY if it actually names an opencode dir (guards
 *      against inheriting another plugin's exported value)
 *   4. os.tmpdir()/opencode-companion  (fixes the old hardcoded "/tmp")
 * @returns {string}
 */
export function stateBase() {
  const override = process.env.OPENCODE_COMPANION_DATA;
  const own = deriveOwnDataDir();
  const envData = process.env.CLAUDE_PLUGIN_DATA;
  if (override) return path.join(override, "state");
  if (own) return path.join(own, "state");
  if (envData && /opencode/i.test(path.basename(envData))) return path.join(envData, "state");
  return path.join(os.tmpdir(), "opencode-companion");
}

/**
 * Compute the state directory root for a workspace: <base>/<sha256(path)>.
 * @param {string} workspacePath
 * @returns {string}
 */
export function stateRoot(workspacePath) {
  const hash = crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  return path.join(stateBase(), hash);
}

/**
 * Remember WHICH workspace a hashed state dir belongs to.
 *
 * The dir name is a one-way sha256 of the workspace path, so a cross-workspace
 * reader (`watch`, which aggregates every repo's jobs) could otherwise only ever
 * label a job with a meaningless hash. A tiny sidecar next to state.json is the
 * whole index — state.json's own {config, jobs} contract stays untouched, and a
 * corrupt/missing sidecar just degrades the LABEL, never the jobs.
 *
 * Best-effort and idempotent: it rewrites only when the path actually changed.
 * @param {string} root
 * @param {string} workspacePath
 */
function stampWorkspace(root, workspacePath) {
  if (!workspacePath) return;
  const file = path.join(root, "workspace.json");
  try {
    if (readJson(file)?.workspace === workspacePath) return;
    writeJson(file, { workspace: workspacePath });
  } catch {
    // A label is a nicety; never fail a state write over it.
  }
}

/**
 * Every workspace this data dir knows about, with its jobs.
 *
 * Read-only and crash-proof BY DESIGN: this backs the live `watch` panel, which
 * must never mutate the state it is observing (a background delegation is
 * writing to these same files while we read) and must never die because ONE
 * repo's state.json is half-written or corrupt — that repo is skipped, the rest
 * of the board still paints.
 *
 * @param {{ base?: string }} [opts]
 * @returns {{ hash: string, workspace: string|null, jobs: object[], corrupt: boolean }[]}
 */
export function listWorkspaceStates(opts = {}) {
  const base = opts.base ?? stateBase();

  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return []; // no data dir yet ⇒ no workspaces, not an error
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(base, entry.name);

    // readJson swallows both "missing" and "unparseable" into null, which is
    // exactly the semantics we want: a torn write is a skipped repo, not a crash.
    const state = readJson(path.join(root, "state.json"));
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    const workspace = readJson(path.join(root, "workspace.json"))?.workspace ?? null;

    out.push({
      hash: entry.name,
      workspace: typeof workspace === "string" ? workspace : null,
      jobs,
      corrupt: state === null,
    });
  }
  return out;
}

/**
 * Path to the main state.json file.
 * @param {string} root
 * @returns {string}
 */
function stateFile(root) {
  return path.join(root, "state.json");
}

/**
 * Load the state for a workspace.
 * @param {string} workspacePath
 * @returns {{ config: object, jobs: object[] }}
 */
export function loadState(workspacePath) {
  const root = stateRoot(workspacePath);
  const data = readJson(stateFile(root));
  return data ?? { config: {}, jobs: [] };
}

/**
 * Save the state for a workspace.
 * @param {string} workspacePath
 * @param {object} state
 */
export function saveState(workspacePath, state) {
  const root = stateRoot(workspacePath);
  writeJson(stateFile(root), state);
  stampWorkspace(root, workspacePath);
}

/**
 * Update the state atomically using a mutator function.
 * Serialized via a filesystem lock so concurrent background jobs writing
 * to the same workspace's state.json don't clobber each other's updates.
 * @param {string} workspacePath
 * @param {(state: object) => void} mutator
 * @returns {object} the updated state
 */
export function updateState(workspacePath, mutator) {
  const root = stateRoot(workspacePath);
  const lockPath = path.join(root, ".state.lock");
  return withFileLock(lockPath, () => {
    const state = loadState(workspacePath);
    mutator(state);
    saveState(workspacePath, state);
    return state;
  });
}

/**
 * Generate a unique job ID.
 * @param {string} prefix - e.g. "review", "task"
 * @returns {string}
 */
export function generateJobId(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Insert or update a job in the state.
 * @param {string} workspacePath
 * @param {object} job
 */
export function upsertJob(workspacePath, job) {
  updateState(workspacePath, (state) => {
    if (!state.jobs) state.jobs = [];
    const idx = state.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      state.jobs[idx] = { ...state.jobs[idx], ...job, updatedAt: new Date().toISOString() };
    } else {
      state.jobs.push({ ...job, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    // Prune old jobs beyond MAX_JOBS — but NEVER evict a non-terminal job.
    // A long-running/pending job whose updatedAt ages behind 50 newer jobs
    // would otherwise be dropped mid-flight, losing its status/pid/metadata
    // and becoming invisible to status/result/cancel.
    if (state.jobs.length > MAX_JOBS) {
      const terminal = (j) =>
        j.status === "completed" || j.status === "failed" || j.status === "canceled";
      const active = state.jobs.filter((j) => !terminal(j));
      const done = state.jobs
        .filter(terminal)
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const keepDone = Math.max(0, MAX_JOBS - active.length);
      // Keep active jobs + the newest terminal ones, then re-sort the whole
      // set newest-first so array order stays a valid recency proxy.
      state.jobs = [...active, ...done.slice(0, keepDone)].sort(
        (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
      );
    }
  });
}

/**
 * Get the path for a job's log file.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobLogPath(workspacePath, jobId) {
  return path.join(stateRoot(workspacePath), "jobs", `${jobId}.log`);
}

/**
 * Get the path for a job's data file.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobDataPath(workspacePath, jobId) {
  return path.join(stateRoot(workspacePath), "jobs", `${jobId}.json`);
}

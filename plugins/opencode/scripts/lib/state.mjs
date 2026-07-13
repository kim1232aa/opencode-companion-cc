// File-system-based persistent state for the OpenCode companion.
// Mirrors the codex-plugin-cc state.mjs pattern: SHA-256 hash of workspace path,
// JSON state file, per-job files and logs.

import crypto from "node:crypto";
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
 * Compute the state directory root for a workspace. Data-dir priority:
 *   1. OPENCODE_COMPANION_DATA (explicit opt-in override)
 *   2. our own install-derived data dir
 *   3. CLAUDE_PLUGIN_DATA — ONLY if it actually names an opencode dir (guards
 *      against inheriting another plugin's exported value)
 *   4. os.tmpdir()/opencode-companion  (fixes the old hardcoded "/tmp")
 * @param {string} workspacePath
 * @returns {string}
 */
export function stateRoot(workspacePath) {
  let base;
  const override = process.env.OPENCODE_COMPANION_DATA;
  const own = deriveOwnDataDir();
  const envData = process.env.CLAUDE_PLUGIN_DATA;
  if (override) {
    base = path.join(override, "state");
  } else if (own) {
    base = path.join(own, "state");
  } else if (envData && /opencode/i.test(path.basename(envData))) {
    base = path.join(envData, "state");
  } else {
    base = path.join(os.tmpdir(), "opencode-companion");
  }
  const hash = crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  return path.join(base, hash);
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

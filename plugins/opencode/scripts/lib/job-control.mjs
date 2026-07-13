// Job control: query, sort, enrich, and build status snapshots.

import { tailLines } from "./fs.mjs";
import { jobLogPath, upsertJob, loadState } from "./state.mjs";

/**
 * True if the given pid is currently alive. Missing/invalid pid ⇒ dead.
 * @param {number|undefined|null} pid
 */
function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but not signalable by us
  }
}

/**
 * Reconcile jobs whose worker process is gone but whose status is still
 * non-terminal — they were stranded (SIGKILL/OOM/reboot before runTrackedJob
 * could mark them). Marks them failed so status/result/cancel stop showing a
 * phantom "running" job forever. Returns the refreshed job list.
 * @param {string} workspacePath
 * @param {object[]} jobs
 * @returns {object[]}
 */
export function reconcileStrandedJobs(workspacePath, jobs) {
  let changed = false;
  for (const j of jobs ?? []) {
    const terminal = j.status === "completed" || j.status === "failed" || j.status === "canceled";
    if (terminal || !j.pid) continue;
    if (!isPidAlive(j.pid)) {
      upsertJob(workspacePath, {
        id: j.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: `Worker process (pid ${j.pid}) exited without completing.`,
      });
      changed = true;
    }
  }
  return changed ? (loadState(workspacePath).jobs ?? jobs) : jobs;
}

/**
 * Sort jobs newest first by updatedAt.
 * @param {object[]} jobs
 * @returns {object[]}
 */
export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Enrich a job with computed fields: elapsed time, progress preview, phase.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {object}
 */
export function enrichJob(job, workspacePath) {
  const enriched = { ...job };

  // Elapsed time
  if (job.createdAt) {
    const start = new Date(job.createdAt).getTime();
    const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
    enriched.elapsedMs = end - start;
    enriched.elapsed = formatDuration(enriched.elapsedMs);
  }

  // Progress preview from log tail
  if (job.status === "running") {
    const logFile = jobLogPath(workspacePath, job.id);
    const lines = tailLines(logFile, 3);
    if (lines.length > 0) {
      enriched.progressPreview = lines.join("\n");
    }
  }

  // Infer phase from log
  if (job.status === "running" && !job.phase) {
    enriched.phase = inferPhase(job, workspacePath);
  }

  return enriched;
}

/**
 * Infer the current phase of a running job from its log.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {string}
 */
function inferPhase(job, workspacePath) {
  const logFile = jobLogPath(workspacePath, job.id);
  const lines = tailLines(logFile, 20);
  const text = lines.join("\n").toLowerCase();

  // NOTE: a running job is never "failed" here — a genuinely failed job has
  // status "failed" (set by runTrackedJob) and doesn't reach inferPhase. We
  // must NOT infer "failed" from the word "error"/"failed" appearing in a log
  // line like "checking for errors... none found", which would mislabel a
  // healthy running job as crashed.
  if (text.includes("finalizing") || text.includes("complete")) return "finalizing";
  if (text.includes("editing") || text.includes("writing")) return "editing";
  if (text.includes("verifying") || text.includes("testing")) return "verifying";
  if (text.includes("investigating") || text.includes("analyzing")) return "investigating";
  if (text.includes("reviewing")) return "reviewing";
  if (text.includes("starting") || text.includes("initializing")) return "starting";
  return "running";
}

/**
 * Build a status snapshot for display.
 * @param {object[]} jobs
 * @param {string} workspacePath
 * @param {{ sessionId?: string }} opts
 * @returns {{ running: object[], latestFinished: object|null, recent: object[] }}
 */
export function buildStatusSnapshot(jobs, workspacePath, opts = {}) {
  let filtered = jobs;
  if (opts.sessionId) {
    filtered = jobs.filter((j) => j.sessionId === opts.sessionId);
  }

  const sorted = sortJobsNewestFirst(filtered);
  const enriched = sorted.map((j) => enrichJob(j, workspacePath));

  const running = enriched.filter((j) => j.status === "running" || j.status === "pending");
  const finished = enriched.filter(
    (j) => j.status === "completed" || j.status === "failed" || j.status === "canceled"
  );
  const latestFinished = finished[0] ?? null;
  const recent = finished.slice(0, 5);

  return { running, latestFinished, recent };
}

/**
 * Find a single job by ID or prefix match.
 * @param {object[]} jobs
 * @param {string} ref
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function matchJobReference(jobs, ref) {
  if (!ref) return { job: null, ambiguous: false };

  // Exact match first
  const exact = jobs.find((j) => j.id === ref);
  if (exact) return { job: exact, ambiguous: false };

  // Prefix match
  const matches = jobs.filter((j) => j.id.startsWith(ref));
  if (matches.length === 1) return { job: matches[0], ambiguous: false };
  if (matches.length > 1) return { job: null, ambiguous: true };

  return { job: null, ambiguous: false };
}

/**
 * Resolve a job that has finished (completed or failed).
 * @param {object[]} jobs
 * @param {string} [ref]
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function resolveResultJob(jobs, ref, opts = {}) {
  let pool = jobs.filter(
    (j) => j.status === "completed" || j.status === "failed" || j.status === "canceled"
  );
  // Without an explicit ref, scope to this Claude session (like status does)
  // so `result` doesn't silently return another session's newest job.
  if (!ref && opts.sessionId) {
    const scoped = pool.filter((j) => j.sessionId === opts.sessionId);
    if (scoped.length) pool = scoped;
  }
  if (!ref) {
    const sorted = sortJobsNewestFirst(pool);
    return { job: sorted[0] ?? null, ambiguous: false };
  }
  return matchJobReference(pool, ref);
}

/**
 * Resolve a job that can be canceled (running).
 * @param {object[]} jobs
 * @param {string} [ref]
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function resolveCancelableJob(jobs, ref, opts = {}) {
  const running = jobs.filter((j) => j.status === "running" || j.status === "pending");
  if (!ref) {
    const scoped = opts.sessionId
      ? running.filter((j) => j.sessionId === opts.sessionId)
      : running;
    return { job: scoped[0] ?? null, ambiguous: scoped.length > 1 };
  }
  return matchJobReference(running, ref);
}

/**
 * Format a duration in milliseconds to human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

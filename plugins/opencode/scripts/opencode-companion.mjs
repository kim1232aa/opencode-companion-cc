#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached } from "./lib/process.mjs";
import { isServerRunning, ensureServer, createClient, connect, suggestModelRefs } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, generateJobId, jobDataPath } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveCancelableJob, enrichJob, reconcileStrandedJobs, recoverStrandedResults, pidStartTime, isOwnedProcessAlive } from "./lib/job-control.mjs";
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

// Validate a --model ref against the server's real model list; throw a helpful
// suggestion (missing provider prefix is the usual mistake) instead of letting
// a wrong ref fail mid-run with an opaque 500.
async function resolveModelAvailable(client, model) {
  if (!model) return model;
  const refs = await client.listModelRefs().catch(() => null);
  if (!refs || !refs.size || refs.has(model)) return model;
  // Unambiguous dropped-provider-prefix ref ⇒ auto-fix (the token line then
  // shows what actually ran). OpenCode's UI shows the provider NAME (e.g.
  // "freeapi"), not the ID (e.g. "volcano-coding"), so this is a common slip.
  const exact = suggestModelRefs(refs, model, 50).filter((r) => r.endsWith(`/${model}`));
  if (exact.length === 1) return exact[0];
  const sugg = suggestModelRefs(refs, model);
  throw new Error(
    `Model "${model}" is not available on the OpenCode server.` +
    (sugg.length ? ` Did you mean: ${sugg.join("  |  ")} ?` : "") +
    ` A ref is <providerID>/<modelID>; the provider ID (e.g. volcano-coding) is NOT the name shown in OpenCode's UI (e.g. freeapi). Run \`/opencode:setup\` to list provider IDs.`
  );
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
    const usageLine = formatUsage(result.usage, { requestedModel: options.model });
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
    const usageLine = formatUsage(result.usage, { requestedModel: options.model });
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
  if (options["resume-last"] && !options.fresh) { // --fresh explicitly overrides --resume-last
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
    if (!bgChild?.pid) {
      const msg = "Failed to start the OpenCode worker process.";
      upsertJob(workspace, { id: job.id, status: "failed", completedAt: new Date().toISOString(), errorMessage: msg });
      console.error(`OpenCode task ${job.id}: ${msg}`);
      process.exit(1);
    }
    upsertJob(workspace, { id: job.id, pid: bgChild.pid, pidStart: pidStartTime(bgChild.pid), detachedWorker: true });
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
        options.model = await resolveModelAvailable(client, options.model);

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

        // Same token-progress heartbeat as the background worker: lets `status`
        // (from another window) distinguish "generating" from "stuck".
        const heartbeat = setInterval(async () => {
          const u = await client
            .getSessionUsage(sessionId, { timeoutMs: 8_000 })
            .catch(() => null);
          // Log every beat (even at 0 tokens) so log freshness tracks worker
          // liveness: fresh + 0 tokens = connected but the model is silent (a
          // hung turn); stale = the worker itself is gone.
          if (u) {
            log(u.total > 0
              ? `heartbeat: ${u.total.toLocaleString()} tokens so far (${u.turns} turn${u.turns === 1 ? "" : "s"})`
              : `heartbeat: connected, 0 tokens yet (model has not emitted)`);
          }
        }, 30_000);
        heartbeat.unref?.();

        let response;
        try {
          response = await client.sendPrompt(sessionId, prompt, {
            agent: agentName,
            model: options.model,
          });
        } finally {
          clearInterval(heartbeat);
        }

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
    const usageLine = formatUsage(result.usage, { requestedModel: options.model });
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
  if (options["resume-last"] && !options.fresh) { // --fresh explicitly overrides --resume-last
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
  if (!child?.pid) {
    // Spawn failed (e.g. node missing, ARG_MAX exceeded by a huge task-text).
    // Without a pid the polling loop can't detect the dead worker and would
    // block for the full timeout — fail fast instead.
    const msg = "Failed to start the OpenCode worker process.";
    upsertJob(workspace, { id: job.id, status: "failed", completedAt: new Date().toISOString(), errorMessage: msg });
    console.error(`Task ${job.id}: ${msg}`);
    process.exit(1);
  }
  upsertJob(workspace, { id: job.id, pid: child.pid, pidStart: pidStartTime(child.pid), detachedWorker: true });

  // Announce the job id on stderr up front. This is a blocking call: the full
  // result prints to stdout when the worker finishes. But if the wrapper's Bash
  // call is cut off (its own timeout) before that, this line is still captured,
  // so the result can be recovered later with `result <id>` instead of lost.
  process.stderr.write(`[opencode] job ${job.id} dispatched; blocking until it finishes. If this call is cut off, retrieve the result later with: result ${job.id}\n`);

  const timeoutMs = Number(options["timeout-ms"]) > 0
    ? Number(options["timeout-ms"])
    : Number(process.env.OPENCODE_COMPANION_WAIT_TIMEOUT_MS) || 35 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1500;

  const printTerminal = (st) => {
    if (st.status === "completed") {
      const data = readJson(jobDataPath(workspace, job.id));
      console.log(data?.rendered ?? st.result ?? "(task completed with no output)");
      const usageLine = formatUsage(data?.usage, { requestedModel: data?.requestedModel });
      if (usageLine) console.log(`\n---\n${usageLine}`);
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

    // The detached worker died without writing a terminal status. Before giving
    // up, try to salvage the result from the server — the session often finished
    // there. Ownership-aware: a recycled pid (different start-time) counts as gone.
    if (st.pid && !isOwnedProcessAlive(st.pid, st.pidStart)) {
      const healed = await recoverStrandedResults(
        workspace,
        loadState(workspace).jobs ?? [],
        defaultServerUrl()
      );
      const again = healed.find((j) => j.id === job.id);
      if (again && printTerminal(again)) return;
      // Server still generating our answer ⇒ keep waiting instead of failing.
      if (again?.awaitingServer) continue;
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
        options.model = await resolveModelAvailable(client, options.model);

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

        // Heartbeat: while sendPrompt blocks (often 15-30+ min), poll the
        // server's live token count into the job log every 30s. `status` shows
        // the log tail, so a user can tell "still generating" (tokens climbing)
        // from "actually stuck" (frozen across polls) — the job log otherwise
        // only changes on phase transitions.
        const heartbeat = setInterval(async () => {
          const u = await client
            .getSessionUsage(sessionId, { timeoutMs: 8_000 })
            .catch(() => null);
          // Log every beat (even at 0 tokens) so log freshness tracks worker
          // liveness: fresh + 0 tokens = connected but the model is silent (a
          // hung turn); stale = the worker itself is gone.
          if (u) {
            log(u.total > 0
              ? `heartbeat: ${u.total.toLocaleString()} tokens so far (${u.turns} turn${u.turns === 1 ? "" : "s"})`
              : `heartbeat: connected, 0 tokens yet (model has not emitted)`);
          }
        }, 30_000);
        heartbeat.unref?.();

        let response;
        try {
          response = await client.sendPrompt(sessionId, prompt, {
            agent: agentName,
            model: options.model,
          });
        } finally {
          clearInterval(heartbeat);
        }

        const text = extractResponseText(response);
        const usage = await client.getSessionUsage(sessionId).catch(() => null);
        report("finalizing", "Done");

        return { rendered: text, usage, requestedModel: options.model, summary: text.slice(0, 500) };
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

  // For any job whose worker died mid-run: first try to salvage its result from
  // the OpenCode server (the session often finished server-side), then reconcile
  // whatever couldn't be recovered to "failed" so nothing shows as a phantom
  // "running" forever.
  let jobs = loadState(workspace).jobs ?? [];
  jobs = await recoverStrandedResults(workspace, jobs, defaultServerUrl());
  jobs = reconcileStrandedJobs(workspace, jobs);

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
  // Salvage a dead worker's result from the server before reconciling to failed.
  let jobs = loadState(workspace).jobs ?? [];
  jobs = await recoverStrandedResults(workspace, jobs, defaultServerUrl());
  jobs = reconcileStrandedJobs(workspace, jobs);

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

  // Signal ONLY a detached background worker. A foreground job's recorded pid
  // is the dispatcher process itself (the user's live Bash call) — SIGTERMing
  // it from another session would kill that call mid-output; abortSession above
  // already makes its sendPrompt return. Ownership is verified via the kernel
  // start-time fingerprint so a recycled pid is never signalled.
  if (job.detachedWorker && job.pid && isOwnedProcessAlive(job.pid, job.pidStart)) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // race: gone between the liveness check and the signal
    }
  }

  // Compare-and-set INSIDE the state lock: the worker may finish (completed/
  // failed) during the abortSession round-trip, and a check-then-write outside
  // the lock could still clobber that terminal result with "canceled".
  let finalStatus = null;
  updateState(workspace, (state) => {
    const j = state.jobs?.find((x) => x.id === job.id);
    if (!j) return;
    if (j.status !== "running" && j.status !== "pending") {
      finalStatus = j.status; // already terminal — leave it
      return;
    }
    j.status = "canceled";
    j.completedAt = new Date().toISOString();
    j.errorMessage = "Canceled by user";
    j.updatedAt = new Date().toISOString();
    finalStatus = "canceled";
  });

  if (finalStatus && finalStatus !== "canceled") {
    console.log(`Job ${job.id} already ${finalStatus}; nothing to cancel.`);
    return;
  }
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
  if (response == null) return "";
  if (typeof response === "string") return response;

  // Response shape: { info: { ... }, parts: [ { type: "text", text: "..." }, ... ] }
  // Guard Array.isArray so a non-array `parts` (API anomaly) falls through to
  // the info.content / stringify fallbacks instead of throwing on `.filter`.
  if (Array.isArray(response.parts)) {
    return response.parts
      .filter((p) => p?.type === "text")
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n");
  }

  // Fallback: try info.content or just stringify
  if (response?.info?.content) {
    if (typeof response.info.content === "string") return response.info.content;
    if (Array.isArray(response.info.content)) {
      return response.info.content
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .filter(Boolean)
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

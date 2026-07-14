#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, parseTaskArgv, classifyWaitTarget } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached } from "./lib/process.mjs";
import { isServerRunning, createClient, connect, suggestModelRefs, dispatchWithRetry } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, jobDataPath, jobLogPath } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveCancelableJobs, matchJobReference, enrichJob, reconcileStrandedJobs, recoverStrandedResults, pidStartTime, isOwnedProcessAlive } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId, isJobCanceled, recordJobRequest, readJobRequest } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderSetup, formatUsage, formatTrailer } from "./lib/render.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { withWorktree } from "./lib/worktree.mjs";
import { readJson, appendLine } from "./lib/fs.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

// Single source for the loopback daemon URL (was hardcoded at several sites).
function defaultServerUrl() {
  const port = Number(process.env.OPENCODE_SERVER_PORT) || 4096;
  return `http://127.0.0.1:${port}`;
}

// Print the delegate/result stdout tail. Default: a single concise trailer line
// (✓ out tokens · model · session). The full multi-line breakdown still lives in
// `/opencode:result`; set OPENCODE_COMPANION_VERBOSE_TRAILER=1 to get it inline
// here too. A model mismatch / empty usage still surfaces via the trailer's own
// ⚠️ handling, so no correctness signal is lost by the concise default.
function printTrailer(usage, { requestedModel, sessionId } = {}) {
  if (/^(1|true|yes|on)$/i.test(process.env.OPENCODE_COMPANION_VERBOSE_TRAILER || "")) {
    const full = formatUsage(usage, { requestedModel });
    if (full) console.log(`\n---\n${full}`);
    return;
  }
  const line = formatTrailer(usage, { requestedModel, sessionId });
  if (line) console.log(`\n${line}`);
}

// Validate a --model ref against the server's real model list; throw a helpful
// suggestion (missing provider prefix is the usual mistake) instead of letting
// a wrong ref fail mid-run with an opaque 500.
async function resolveModelAvailable(client, model) {
  if (!model) return model;
  const refs = await client.listModelRefs().catch(() => null);
  if (!refs || !refs.size || refs.has(model)) return model;
  // Unambiguous dropped-provider-prefix ref ⇒ auto-fix (the token line then
  // shows what actually ran). OpenCode's UI can show a provider display NAME
  // that differs from the ID a ref needs, so dropping the prefix is a common slip.
  const exact = suggestModelRefs(refs, model, 50).filter((r) => r.endsWith(`/${model}`));
  if (exact.length === 1) return exact[0];
  const sugg = suggestModelRefs(refs, model);
  throw new Error(
    `Model "${model}" is not available on the OpenCode server.` +
    (sugg.length ? ` Did you mean: ${sugg.join("  |  ")} ?` : "") +
    ` A ref is <providerID>/<modelID>; the providerID is the id from your opencode config (not necessarily the display name OpenCode's UI shows), and the modelID may itself contain slashes. Run \`/opencode:setup\` to list the exact provider IDs.`
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

// Flags that route the run; everything else on task-style commands is TASK TEXT.
// `task`/`prompt`/`task-file` are ACCEPTED sources for the task text (so the
// natural `--task "…"` spelling works instead of exploding), on top of the
// positional form and piped stdin.
const TASK_VALUE_OPTIONS = ["model", "agent", "task", "prompt", "task-file"];
const TASK_BOOLEAN_OPTIONS = ["write", "background", "wait", "resume-last", "fresh", "worktree"];
const WAIT_VALUE_OPTIONS = [...TASK_VALUE_OPTIONS, "timeout-ms"];
const WAIT_BOOLEAN_OPTIONS = ["write", "resume-last", "fresh", "worktree"];

const USAGE = `opencode-companion — delegate tasks and reviews to OpenCode.

Usage: opencode-companion <subcommand> [options] [task text...]

DISPATCH vs. RETRIEVE:
  task / wait-and-result   dispatch work (they create a job)
  status / result / cancel act on an EXISTING job id — they never dispatch

The task text is POSITIONAL (plain words). It may also be given with
--task/--prompt, with --task-file <path>, or piped on stdin. An undeclared
--flag inside the text is forwarded verbatim (e.g. git commit --no-verify).

Subcommands:
  task [options] <task text...>
      Dispatch a task. Blocks and prints the result unless --background.
      --background            spawn a detached worker, print the job id, return now
      --task/--prompt <text>  task text as an option instead of positional words
      --task-file <path>      read the task text from a file ("-" = stdin)
      --model <provider/model>  model ref (e.g. anthropic/claude-sonnet-4-5)
      --agent <build|plan>    build = can write (default), plan = read-only
      --worktree              run writes in an isolated git worktree
      --resume-last | --fresh continue this session's last OpenCode session / force a new one

  wait-and-result [options] <task text... | existing job id>
      With TASK TEXT: dispatch a NEW job on a tracked detached worker and BLOCK
      until it finishes, then print the full result.
      With an existing JOB ID: wait for THAT job and print its result — nothing
      new is dispatched. An unknown job id is an error (use \`result <id>\`).
      --timeout-ms <ms>       max wait (default 35m; OPENCODE_COMPANION_WAIT_TIMEOUT_MS)
      plus every \`task\` option except --background.

  status [<job id>] [--wait] [--timeout-ms <ms>]
      No id: list this session's jobs. With an id: show that job.
      --wait blocks until that job reaches a terminal state (requires a job id).
  result [<job id or prefix>]            print a finished job's result (never dispatches)
  cancel [<job id or prefix>]            cancel one job / all of this session's
  review [--base <ref>] [--model <ref>]  review the working diff
  adversarial-review [--base <ref>] [--model <ref>] [focus text...]
  setup [--json] [--enable-review-gate|--disable-review-gate]
  task-resume-candidate [--json]         report a resumable session
  task-worker --job-id <id> --workspace <dir>            (internal; reads the job's request file)

Task text and dashes:
  A task text that starts with a dashed word is fine — quote it as ONE argument
  ("--no-verify 这参数啥意思"), pass it with --task, or put it after \`--\`:
      task -- --no-verify what does this flag do?
  Dispatch fails fast only when the task text ends up EMPTY.

Env: OPENCODE_SERVER_PORT, OPENCODE_COMPANION_DATA, OPENCODE_COMPANION_WAIT_TIMEOUT_MS,
     OPENCODE_COMPANION_VERBOSE_TRAILER`;

function printUsage(stream = process.stdout) {
  stream.write(`${USAGE}\n`);
}

if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  printUsage();
  process.exit(0);
}

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}\n`);
  printUsage(process.stderr);
  process.exit(1);
}

if (argv[0] === "--help" || argv[0] === "-h") {
  printUsage();
  process.exit(0);
}

handler(argv).catch((err) => {
  console.error(`Error in ${subcommand}: ${err.message}`);
  process.exit(1);
});

/**
 * Read piped stdin, if and only if stdin really is a pipe or a redirected file.
 * (A TTY or /dev/null must never be read — that would block or return junk.)
 * @returns {string}
 */
function readStdinIfPiped() {
  if (process.stdin.isTTY) return "";
  try {
    const st = fs.fstatSync(0);
    if (!st.isFIFO() && !st.isFile()) return "";
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve the task text from every accepted source, in priority order:
 *   --task-file <path>  (or "-" for stdin) > --task/--prompt > positional words > piped stdin
 * Accepting `--task` is deliberate: a user writing
 * `task --background --model … --task "中文任务"` gets the task they asked for
 * instead of a mangled/empty one.
 * @param {Record<string, string|boolean>} options
 * @param {string} positionalText
 * @returns {{ taskText: string, errors: string[] }}
 */
function resolveTaskText(options, positionalText) {
  const errors = [];
  const optionText = options.task ?? options.prompt;
  const file = options["task-file"];

  const sources = [];
  if (file) sources.push("--task-file");
  if (typeof optionText === "string" && optionText.trim()) sources.push("--task/--prompt");
  if (positionalText) sources.push("positional text");
  if (sources.length > 1) {
    process.stderr.write(`[opencode] several task sources given (${sources.join(", ")}); using ${sources[0]}.\n`);
  }

  if (file) {
    if (file === "-") return { taskText: readStdinIfPiped().trim(), errors };
    try {
      return { taskText: fs.readFileSync(path.resolve(process.cwd(), String(file)), "utf8").trim(), errors };
    } catch (err) {
      errors.push(`could not read --task-file ${file}: ${err.message}`);
      return { taskText: "", errors };
    }
  }
  if (typeof optionText === "string" && optionText.trim()) {
    return { taskText: optionText.trim(), errors };
  }
  if (positionalText) return { taskText: positionalText, errors };

  return { taskText: readStdinIfPiped().trim(), errors };
}

/**
 * Fail fast on an invocation that has no usable task — BEFORE a job record
 * exists or a worker is spawned. The old code only warned and ran anyway, which
 * burned a whole delegation on an empty task and then reported it, minutes
 * later, as a mysterious "worker exited without completing".
 * @param {string[]} errors
 * @param {string} taskText
 */
function requireValidTaskArgs(errors, taskText) {
  const problems = [...errors];
  if (!taskText || !taskText.trim()) problems.push("no task text provided");
  if (!problems.length) return;

  console.error(`Invalid arguments for \`${subcommand}\`:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  console.error("Give the task as positional words, with --task/--prompt, with --task-file <path>, or on piped stdin:");
  console.error(`  ${subcommand} --background --model openai/gpt-5 "重构 X 模块"`);
  console.error(`  ${subcommand} --background --model openai/gpt-5 --task "重构 X 模块"`);
  console.error(`\nRun \`${subcommand} --help\` for the full usage.`);
  process.exit(1);
}

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

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: false,
      }, PLUGIN_ROOT);

      report("reviewing", "Running review...");
      log(`Prompt length: ${prompt.length} chars${options.model ? `, model: ${options.model}` : ""}`);

      // Retry a transient 500 / hang on a fresh session; an empty (deterministic)
      // turn fails honestly. dispatchWithRetry owns the heartbeat + stall watchdog.
      const dispatch = await dispatchWithRetry({
        client, prompt, agent: "plan", model: options.model, // read-only agent for reviews
        extract: extractResponseText, log,
        makeSession: () => client.createSession({ title: `Code Review ${job.id}` }),
        onSession: (sid) => upsertJob(workspace, { id: job.id, opencodeSessionId: sid }),
        shouldStop: () => isJobCanceled(workspace, job.id),
      });
      const response = dispatch.response;
      const sessionId = dispatch.sessionId;
      if (dispatch.attempts > 1) log(`Succeeded on attempt ${dispatch.attempts}.`);

      report("finalizing", "Processing review output...");

      // Try to parse structured output
      const text = extractResponseText(response);
      let structured = tryParseJson(text);
      const usage = await client.getSessionUsage(sessionId).catch(() => null);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
        usage,
        opencodeSessionId: sessionId,
      };
    });

    console.log(result.rendered);
    printTrailer(result.usage, { requestedModel: options.model, sessionId: result.opencodeSessionId });
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

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: true,
        focus,
      }, PLUGIN_ROOT);

      report("reviewing", "Running adversarial review...");
      log(`Prompt length: ${prompt.length} chars, focus: ${focus || "(none)"}${options.model ? `, model: ${options.model}` : ""}`);

      const dispatch = await dispatchWithRetry({
        client, prompt, agent: "plan", model: options.model,
        extract: extractResponseText, log,
        makeSession: () => client.createSession({ title: `Adversarial Review ${job.id}` }),
        onSession: (sid) => upsertJob(workspace, { id: job.id, opencodeSessionId: sid }),
        shouldStop: () => isJobCanceled(workspace, job.id),
      });
      const response = dispatch.response;
      const sessionId = dispatch.sessionId;
      if (dispatch.attempts > 1) log(`Succeeded on attempt ${dispatch.attempts}.`);

      report("finalizing", "Processing review output...");

      const text = extractResponseText(response);
      let structured = tryParseJson(text);
      const usage = await client.getSessionUsage(sessionId).catch(() => null);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
        usage,
        opencodeSessionId: sessionId,
      };
    });

    console.log(result.rendered);
    printTrailer(result.usage, { requestedModel: options.model, sessionId: result.opencodeSessionId });
  } catch (err) {
    console.error(`Adversarial review failed: ${err.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Task (rescue delegation)
// ------------------------------------------------------------------

async function handleTask(argv) {
  const { options, taskText: positionalText, errors } = parseTaskArgv(argv, {
    valueOptions: TASK_VALUE_OPTIONS,
    booleanOptions: TASK_BOOLEAN_OPTIONS,
  });
  const resolved = resolveTaskText(options, positionalText);
  const taskText = resolved.taskText;

  // Empty/unusable task ⇒ stop here: no job record, no worker, no burned call.
  requireValidTaskArgs([...errors, ...resolved.errors], taskText);

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

  // createJobRecord persists the task text into the job's REQUEST FILE (0600),
  // so the worker is spawned with nothing but a job id.
  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
    model: options.model,
    write: isWrite,
    worktree: useWorktree,
    taskText,
  });

  // Background mode: spawn a detached worker
  if (options.background) {
    const workerArgs = buildWorkerArgs({ jobId: job.id, workspace });

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

        const prompt = buildTaskPrompt(taskText, { write: isWrite });
        report("investigating", "Sending task to OpenCode...");
        log(`Agent: ${agentName}, Write: ${isWrite}, Prompt: ${prompt.length} chars, Model: ${options.model ?? "(provider default)"}`);

        // Retry a transient 500 / empty turn / hang on a fresh session.
        const dispatch = await dispatchWithRetry({
          client, prompt, agent: agentName, model: options.model,
          extract: extractResponseText, log, resumeSessionId,
          makeSession: () => client.createSession({ title: `Task ${job.id}` }),
          onSession: (sid) => upsertJob(workspace, { id: job.id, opencodeSessionId: sid }),
          shouldStop: () => isJobCanceled(workspace, job.id),
        });
        const response = dispatch.response;
        const sessionId = dispatch.sessionId;
        if (dispatch.attempts > 1) log(`Succeeded on attempt ${dispatch.attempts}.`);

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
          opencodeSessionId: sessionId,
        };
      }, log));

    console.log(result.rendered);
    printTrailer(result.usage, { requestedModel: options.model, sessionId: result.opencodeSessionId });
    if (result.changedFiles?.length) {
      console.log(`\nChanged files:\n${result.changedFiles.map((f) => `- ${f}`).join("\n")}`);
    }
  } catch (err) {
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Build the argv for a detached task-worker. The worker gets ONLY a job id and
 * workspace: the task text and routing live in the job's request file (0600).
 * Nothing sensitive is on the command line (`ps` / /proc/<pid>/cmdline), and an
 * option-shaped task text ("--task 中文任务") can no longer be eaten by the
 * worker's own arg parser — the bug that made the worker start with an EMPTY
 * task and die before its first log line.
 * @param {{ jobId: string, workspace: string }} spec
 * @returns {string[]}
 */
function buildWorkerArgs({ jobId, workspace }) {
  return [
    path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"),
    "task-worker",
    "--job-id", jobId,
    "--workspace", workspace,
  ];
}

// Dispatch a task on a detached worker (so it is tracked, survivable, and
// visible to status/result/cancel) but BLOCK until it reaches a terminal
// state and then print the full result. This is the reliable "delegate AND
// get the result back in one call" path — the caller never has to poll a
// job-id or guess which session/cwd the result landed under (the exact pain
// that made background review results so hard to collect).
//
// It ALSO accepts an existing job id, in which case it waits for that job and
// dispatches nothing (the name finally matches the behavior).
async function handleWaitAndResult(argv) {
  const { options, taskText: positionalText, errors } = parseTaskArgv(argv, {
    valueOptions: WAIT_VALUE_OPTIONS,
    booleanOptions: WAIT_BOOLEAN_OPTIONS,
  });
  const resolved = resolveTaskText(options, positionalText);
  const taskText = resolved.taskText;
  requireValidTaskArgs([...errors, ...resolved.errors], taskText);

  const workspace = await resolveWorkspace();
  const timeoutMs = resolveTimeoutMs(options["timeout-ms"]);

  // Is the argument an EXISTING job rather than task text? It used to be taken
  // as task text unconditionally: `wait-and-result task-abc-123` dispatched a
  // NEW job whose task was that opaque id, which then hunted the repo for the
  // string and hung asking what the task was.
  const target = classifyWaitTarget(taskText, loadState(workspace).jobs ?? []);

  if (target.kind === "await") {
    process.stderr.write(`[opencode] waiting for EXISTING job ${target.jobId}; dispatching nothing.\n`);
    await awaitJobResult(workspace, target.jobId, timeoutMs);
    return;
  }

  if (target.kind === "missing") {
    console.error(
      target.ambiguous
        ? `Ambiguous job reference "${target.jobId}" — several jobs share that prefix. Pass the full job id.`
        : `No such job: ${target.jobId}. Did you mean \`result ${target.jobId}\`? (Check \`status\` for live job ids.)`
    );
    console.error("Refusing to dispatch a job id as task text. To dispatch a NEW task, pass the task text as plain words.");
    process.exit(1);
  }

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

  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
    model: options.model,
    write: isWrite,
    worktree: useWorktree,
    taskText,
  });

  const workerArgs = buildWorkerArgs({ jobId: job.id, workspace });

  // Say plainly that this is a NEW dispatch, so a caller who *meant* to wait on
  // an existing job sees immediately that it isn't what happened.
  process.stderr.write(`[opencode] dispatching a NEW job for the given task text (not waiting on an existing job).\n`);

  const child = spawnDetached("node", workerArgs, { cwd: workspace });
  if (!child?.pid) {
    // Spawn failed (e.g. node missing). Without a pid the polling loop can't
    // detect the dead worker and would block for the full timeout — fail fast.
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

  await awaitJobResult(workspace, job.id, timeoutMs);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

/**
 * Resolve the wait budget for the blocking paths.
 * @param {string|boolean|undefined} raw
 * @returns {number}
 */
function resolveTimeoutMs(raw) {
  return Number(raw) > 0
    ? Number(raw)
    : Number(process.env.OPENCODE_COMPANION_WAIT_TIMEOUT_MS) || 35 * 60 * 1000;
}

/**
 * Poll an EXISTING tracked job until it reaches a terminal state. Shared by
 * `wait-and-result` (both of its branches) and `status <job-id> --wait`.
 * @param {string} workspace
 * @param {string} jobId
 * @param {number} timeoutMs
 * @returns {Promise<object|null>} the terminal job record, or null on timeout
 */
async function waitForTerminalJob(workspace, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1500;

  const initial = loadState(workspace).jobs?.find((j) => j.id === jobId);
  if (initial && TERMINAL_STATUSES.has(initial.status)) return initial;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const st = loadState(workspace).jobs?.find((j) => j.id === jobId);
    if (!st) continue;
    if (TERMINAL_STATUSES.has(st.status)) return st;

    // The detached worker died without writing a terminal status. Before giving
    // up, try to salvage the result from the server — the session often finished
    // there. Ownership-aware: a recycled pid (different start-time) counts as gone.
    if (st.pid && !isOwnedProcessAlive(st.pid, st.pidStart)) {
      const healed = await recoverStrandedResults(
        workspace,
        loadState(workspace).jobs ?? [],
        defaultServerUrl()
      );
      const again = healed.find((j) => j.id === jobId);
      if (again && TERMINAL_STATUSES.has(again.status)) return again;
      // Server still generating our answer ⇒ keep waiting instead of failing.
      if (again?.awaitingServer) continue;
      const dead = again ?? st;
      return {
        ...dead,
        status: "failed",
        errorMessage: dead.errorMessage ?? `worker (pid ${st.pid}) exited without completing`,
      };
    }
  }
  return null;
}

/**
 * Wait for a job and print its RESULT. Exits the process on failure/cancel/timeout.
 * @param {string} workspace
 * @param {string} jobId
 * @param {number} timeoutMs
 */
async function awaitJobResult(workspace, jobId, timeoutMs) {
  const st = await waitForTerminalJob(workspace, jobId, timeoutMs);

  if (!st) {
    console.error(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${jobId}. ` +
      `It may still finish — check \`/opencode:status\` and \`/opencode:result ${jobId}\`.`
    );
    process.exit(1);
  }

  if (st.status === "completed") {
    const data = readJson(jobDataPath(workspace, jobId));
    console.log(data?.rendered ?? st.result ?? "(task completed with no output)");
    printTrailer(data?.usage, {
      requestedModel: data?.requestedModel ?? st.requestedModel,
      sessionId: data?.opencodeSessionId ?? st.opencodeSessionId,
    });
    return;
  }

  if (st.status === "canceled") {
    console.error(`Task ${jobId} was canceled.`);
    process.exit(1);
  }

  console.error(`Task ${jobId} failed: ${st.errorMessage ?? "unknown error"}`);
  process.exit(1);
}

/**
 * Abort a worker that was started with unusable arguments. The old worker just
 * called process.exit(1) BEFORE writing any log line, so the job had no .log at
 * all and only surfaced ~4.5 min later as a misleading "Worker process exited
 * without completing". Now: log the real reason first, then mark the job failed
 * with that reason as its errorMessage.
 * @param {string|undefined} workspace
 * @param {string|undefined} jobId
 * @param {string[]} problems
 */
function failWorkerStartup(workspace, jobId, problems) {
  const reason = problems.join("; ");
  const line = `[${new Date().toISOString()}] [failed] task-worker startup aborted: ${reason}`;
  process.stderr.write(`${line}\n`);

  if (workspace && jobId) {
    try {
      appendLine(jobLogPath(workspace, jobId), line);
    } catch { /* state dir unwritable — the stderr line above is still the record */ }
    try {
      updateState(workspace, (state) => {
        const j = state.jobs?.find((x) => x.id === jobId);
        if (!j) return;
        if (j.status !== "running" && j.status !== "pending") return; // already terminal
        j.status = "failed";
        j.completedAt = new Date().toISOString();
        j.errorMessage = reason;
        j.updatedAt = new Date().toISOString();
      });
    } catch { /* best effort */ }
  }
  process.exit(1);
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["job-id", "workspace", "task-file", "task-text", "agent", "model", "resume-session"],
    booleanOptions: ["write", "worktree"],
  });

  const workspace = options.workspace;
  const jobId = options["job-id"];

  // Validate BEFORE anything else, and never start on an empty task.
  const problems = [];
  if (!workspace) problems.push("missing --workspace");
  if (!jobId) problems.push("missing --job-id");
  if (problems.length) failWorkerStartup(workspace, jobId, problems);

  // The task text and routing come from the job's request file — argv carries
  // only the job id. The legacy argv transports are still honored so an older
  // caller (or a hand-run worker) keeps working.
  const request = readJobRequest(workspace, jobId) ?? {};
  let taskText = typeof request.taskText === "string" ? request.taskText : "";
  if (!taskText && options["task-file"]) {
    try {
      taskText = fs.readFileSync(String(options["task-file"]), "utf8");
    } catch (err) {
      problems.push(`could not read --task-file ${options["task-file"]}: ${err.message}`);
    }
  }
  if (!taskText && typeof options["task-text"] === "string") {
    taskText = options["task-text"];
  }

  const agentName = options.agent ?? request.agent ?? "build";
  const isWrite = options.write ?? (request.write ?? agentName !== "plan");
  const useWorktree = !!(options.worktree ?? request.worktree);
  const resumeSessionId = options["resume-session"] ?? request.resumeSessionId ?? null;
  options.model = options.model ?? request.model;

  if (!problems.length && !taskText.trim()) {
    problems.push("empty task text — nothing to dispatch");
  }
  if (problems.length) failWorkerStartup(workspace, jobId, problems);

  // Persist what this worker was actually asked to do, so a post-mortem can
  // answer "which model / which task was this?" from state alone.
  recordJobRequest(workspace, jobId, { model: options.model, taskText });

  try {
    await runTrackedJob(workspace, { id: jobId }, async ({ report, log }) =>
      withWorktree({ dir: workspace, jobId, useWorktree, isWrite }, async (effectiveCwd) => {
        report("starting", "Background worker connecting to OpenCode...");
        const client = await connect({ cwd: effectiveCwd });
        options.model = await resolveModelAvailable(client, options.model);

        const prompt = buildTaskPrompt(taskText, { write: isWrite });
        report("investigating", resumeSessionId ? `Resuming session ${resumeSessionId}...` : "Running task...");

        // Dispatch with retries: a transient 500 or a hang (no token progress)
        // is retried on a fresh session; an empty (deterministic) turn fails
        // honestly. dispatchWithRetry owns the token heartbeat + stall watchdog,
        // and onSession keeps the job's opencodeSessionId pointed at the live
        // session across retries.
        const dispatch = await dispatchWithRetry({
          client, prompt, agent: agentName, model: options.model,
          extract: extractResponseText, log, resumeSessionId,
          makeSession: () => client.createSession({ title: `Task ${jobId}` }),
          onSession: (sid) => upsertJob(workspace, { id: jobId, opencodeSessionId: sid }),
          shouldStop: () => isJobCanceled(workspace, jobId),
        });
        const response = dispatch.response;
        const sessionId = dispatch.sessionId;
        if (dispatch.attempts > 1) log(`Succeeded on attempt ${dispatch.attempts}.`);

        const text = extractResponseText(response);
        const usage = await client.getSessionUsage(sessionId).catch(() => null);
        report("finalizing", "Done");

        return { rendered: text, usage, requestedModel: options.model, summary: text.slice(0, 500), opencodeSessionId: sessionId };
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
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["timeout-ms"],
    booleanOptions: ["wait"],
  });
  const ref = positional[0];
  if (ref && !isSafeJobRef(ref)) {
    console.error("Invalid job reference. Use a job ID or safe ID prefix.");
    process.exit(1);
  }
  // Never guess which job to wait for — an unscoped `--wait` would silently
  // block on the wrong job.
  if (options.wait && !ref) {
    console.error("`status --wait` requires a job id. Run `status` to list jobs, then `status <job-id> --wait`.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const sessionId = getClaudeSessionId();

  // For any job whose worker died mid-run: first try to salvage its result from
  // the OpenCode server (the session often finished server-side), then reconcile
  // whatever couldn't be recovered to "failed" so nothing shows as a phantom
  // "running" forever.
  let jobs = loadState(workspace).jobs ?? [];
  jobs = await recoverStrandedResults(workspace, jobs, defaultServerUrl());
  jobs = reconcileStrandedJobs(workspace, jobs);

  if (ref) {
    const { job, ambiguous } = matchJobReference(jobs, ref);
    if (ambiguous) {
      console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
      process.exit(1);
    }
    if (!job) {
      console.error(`No such job: ${ref}. Run \`status\` to list jobs.`);
      process.exit(1);
    }

    if (options.wait) {
      process.stderr.write(`[opencode] waiting for job ${job.id} to finish...\n`);
      const timeoutMs = resolveTimeoutMs(options["timeout-ms"]);
      const terminal = await waitForTerminalJob(workspace, job.id, timeoutMs);
      if (!terminal) {
        console.error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${job.id}. ` +
          `It may still finish — check \`status ${job.id}\`.`
        );
        process.exit(1);
      }
      const fresh = loadState(workspace).jobs?.find((j) => j.id === job.id) ?? terminal;
      console.log(renderStatus(buildStatusSnapshot([fresh], workspace, {})));
      console.log(`\nRetrieve the full output with: result ${job.id}`);
      return;
    }

    console.log(renderStatus(buildStatusSnapshot([job], workspace, {})));
    return;
  }

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

  // No ref ⇒ cancel EVERY running job for this Claude session (cancel-all),
  // strictly session-scoped so another session's jobs are never touched. A ref
  // still targets exactly that one job.
  const { jobs: targets, ambiguous } = resolveCancelableJobs(jobs, ref, { sessionId });

  if (ambiguous) {
    console.error("Ambiguous job reference — multiple running jobs match that prefix. Specify a full job ID.");
    process.exit(1);
  }

  if (!targets.length) {
    console.log("No active job to cancel.");
    return;
  }

  const client = createClient(defaultServerUrl());
  const canceled = [];
  const alreadyDone = [];

  for (const job of targets) {
    // Abort the OpenCode session if we have one.
    if (job.opencodeSessionId) {
      try {
        await client.abortSession(job.opencodeSessionId);
      } catch {
        // Server may not be running.
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

    if (finalStatus === "canceled") canceled.push(job.id);
    else if (finalStatus) alreadyDone.push(`${job.id} (${finalStatus})`);
  }

  if (canceled.length) {
    console.log(`Canceled ${canceled.length} job${canceled.length === 1 ? "" : "s"}: ${canceled.join(", ")}`);
  }
  if (alreadyDone.length) {
    console.log(`Already finished (not canceled): ${alreadyDone.join(", ")}`);
  }
  if (!canceled.length && !alreadyDone.length) {
    console.log("No active job to cancel.");
  }
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

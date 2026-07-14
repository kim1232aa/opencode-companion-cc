#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { parseArgs, parseTaskArgv, classifyWaitTarget, matchOption, formatUnknownOptionError } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached } from "./lib/process.mjs";
import { isServerRunning, createClient, connect, ensureServer, suggestModelRefs, dispatchWithRetry } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, jobDataPath, jobLogPath, listWorkspaceStates, stateRoot } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveCancelableJobs, matchJobReference, enrichJob, sortJobsNewestFirst, reconcileStrandedJobs, recoverStrandedResults, pidStartTime, isOwnedProcessAlive } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId, isJobCanceled, recordJobRequest, readJobRequest, writeJobRequest } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderSetup, formatUsage, formatTrailer, liveSignal, recentActivity } from "./lib/render.mjs";
import { installCli, uninstallCli, DEFAULT_CLI_NAME } from "./lib/cli-install.mjs";
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
  batch: cliBatch,
  "wait-and-result": handleWaitAndResult,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  watch: handleWatch,
  result: handleResult,
  cancel: handleCancel,
};

// ------------------------------------------------------------------
// Strict options — for the subcommands that have NO task text
// ------------------------------------------------------------------

// The option sets of the RETRIEVAL subcommands. These commands take a job id and
// flags and nothing else, so anything else option-shaped on their command line
// is a typo, and the only useful thing to do with a typo is refuse it loudly.
//
// The bug: `status --watc` (a dropped "h") printed `warning: unknown option
// --watc`, treated it as `true`, and then ran a perfectly ordinary one-shot
// `status` — so the user saw a normal status board, concluded the live panel was
// broken, and had no way to discover the real cause. It now exits 1 and names the
// flag it thinks you meant.
//
// This is deliberately NOT done for `task` / `wait-and-result` / `batch`: their
// command line carries FREE-FORM TASK TEXT, in which `--no-verify` is a perfectly
// legal word that we promise to forward byte-for-byte. See the big comment on
// parseArgs in lib/args.mjs.
const STRICT_OPTIONS = {
  setup: {
    valueOptions: ["cli-name"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "install-cli", "uninstall-cli"],
  },
  status: {
    valueOptions: ["timeout-ms", "interval", "probe-ms"],
    booleanOptions: ["wait", "watch", "exit-when-idle"],
  },
  watch: {
    valueOptions: ["interval", "workspace"],
    // `--all` is accepted as an explicit spelling of the DEFAULT (aggregate every
    // workspace). It is a no-op, but rejecting it as a "typo" would be obnoxious:
    // it is the first thing a user reaches for, and it asks for what already happens.
    booleanOptions: ["exit-when-idle", "all"],
  },
  result: { valueOptions: [], booleanOptions: [] },
  cancel: { valueOptions: [], booleanOptions: [] },
};

/**
 * Parse a retrieval subcommand's argv and FAIL FAST on an unknown option.
 *
 * Lives here, once, rather than as hand-written validation in each handler —
 * that is how the old code drifted into tolerating a typo'd flag in the first
 * place.
 *
 * @param {string} name - the subcommand (for the error message + its option set)
 * @param {string[]} argv
 * @returns {{ options: Record<string, string|boolean>, positional: string[] }}
 */
function parseStrictArgs(name, argv) {
  const schema = STRICT_OPTIONS[name] ?? { valueOptions: [], booleanOptions: [] };
  const parsed = parseArgs(argv, { ...schema, strict: true });

  if (parsed.unknown.length) {
    const known = [...(schema.valueOptions ?? []), ...(schema.booleanOptions ?? [])];
    console.error(formatUnknownOptionError(name, parsed.unknown, known));
    process.exit(1);
  }
  return parsed;
}

// Flags that route the run; everything else on task-style commands is TASK TEXT.
// `task`/`prompt`/`task-file` are ACCEPTED sources for the task text (so the
// natural `--task "…"` spelling works instead of exploding), on top of the
// positional form and piped stdin.
// `brief`/`no-brief`/`max-words` route the OUTPUT BUDGET (see resolveOutputBudget).
const TASK_VALUE_OPTIONS = ["model", "agent", "task", "prompt", "task-file", "max-words"];
const TASK_BOOLEAN_OPTIONS = ["write", "background", "wait", "resume-last", "fresh", "worktree", "brief", "no-brief", "full"];
const WAIT_VALUE_OPTIONS = [...TASK_VALUE_OPTIONS, "timeout-ms"];
const WAIT_BOOLEAN_OPTIONS = ["write", "resume-last", "fresh", "worktree", "brief", "no-brief", "full"];

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

  batch [options] <shared task text...>      dispatch N tasks in ONE call
      Runs every task in PARALLEL (one tracked job + OpenCode session each),
      blocks until all finish, and prints one compact section per task. Beats N
      separate \`task --background\` calls: one command, one wait, one summary.
      Same question to several models (the fan-out form):
          batch --model p/m-a --model p/m-b --model p/m-c "为什么 X 会挂?"
      Different tasks (each --task starts an item; the flags after it are ITS
      flags, and flags before the first --task are defaults for every item):
          batch --agent plan --task "审计 auth" --model p/m-a \\
                             --task "审计 billing" --model p/m-b
      --file <tasks.json>     items as JSON: [{task, model?, agent?, label?, worktree?,
                              brief?, maxWords?}, …] (or { "tasks": [ … ] })
      --label <text>          short label for the current item (default: its model)
      --timeout-ms <ms>       max wait for the whole batch (default 35m)
      Partial failure is fine: finished tasks still print, failed ones are named.
      Every item is a normal job — \`status\`/\`result\`/\`cancel <job id>\` still work.

  wait-and-result [options] <task text... | existing job id>
      With TASK TEXT: dispatch a NEW job on a tracked detached worker and BLOCK
      until it finishes, then print the full result.
      With an existing JOB ID: wait for THAT job and print its result — nothing
      new is dispatched. An unknown job id is an error (use \`result <id>\`).
      --timeout-ms <ms>       max wait (default 35m; OPENCODE_COMPANION_WAIT_TIMEOUT_MS)
      plus every \`task\` option except --background.

Output budget (task / batch / wait-and-result):
  A delegated answer is returned into the CALLER's context and re-read on every
  later turn, so it is billed again and again while the delegated work itself is
  free. The worker is therefore told to report SHORT by default: conclusion +
  locators (file:line / command), no whole-file dumps, no filler.
      (default)               brief mode ON
      --no-brief | --full     turn it OFF — ask for this when you want the long form
      --max-words <N>         hard cap on the final answer
  It constrains the ANSWER, never the work, and never the forwarded task text.

  status [<job id>] [--wait] [--watch] [--interval <sec>] [--timeout-ms <ms>]
      No id: list this session's jobs. With an id: show that job.
      --wait blocks until that job reaches a terminal state (requires a job id).
      --watch is a LIVE PANEL: it repaints in place (like top) until Ctrl-C.
          --interval <sec>    repaint every N seconds (default 3, min 1)
          --exit-when-idle    stop once nothing is running (default: keep watching)
      Run it in a SECOND TERMINAL while a delegation is in flight. It costs ZERO
      Claude tokens — it reads the local job state and never goes near Claude —
      so it is the cheap way to watch a 4-model fan-out instead of asking Claude
      "are we there yet". Piped (non-TTY) it degrades to plain appended frames,
      with no escape codes.
      NOTE: every token number this command prints is OPENCODE-side usage — the
      work you delegated. It is NOT charged to your Claude context or quota. (The
      "↓ N tokens" a Claude Code agent row shows is Claude's OWN overhead and says
      nothing about how the delegated job is doing.)
  watch [--all] [--workspace <path>] [--interval <sec>] [--exit-when-idle]
      The live panel for EVERY workspace at once — no \`cd\` required (--all is the
      default, and spelling it out is allowed).
      \`status --watch\` only sees the CURRENT repo (job state is per-workspace),
      so a delegation dispatched from another repo simply never showed up. This
      aggregates them all and tags each row with the repo it belongs to.
      --workspace <path>      narrow it back down to a single repo
      Read-only: it reads local job state, never probes the server, never writes.
      Like \`status --watch\`, it costs ZERO Claude tokens.

  result [<job id or prefix>]            print a finished job's result (never dispatches)
  cancel [<job id or prefix>]            cancel one job / all of this session's
  review [--base <ref>] [--model <ref>]  review the working diff
  adversarial-review [--base <ref>] [--model <ref>] [focus text...]
  setup [--json] [--enable-review-gate|--disable-review-gate]
       [--install-cli|--uninstall-cli] [--cli-name <name>]
      --install-cli writes a short launcher (default: \`occ\`) into ~/.local/bin, so
      you can run \`occ status\` / \`occ watch\` instead of a 90-character
      \`node …/cache/…/<version>/scripts/opencode-companion.mjs\`. The launcher
      resolves the NEWEST installed version at run time, so a plugin upgrade never
      breaks it. It refuses to shadow an existing command — use --cli-name then.
  task-resume-candidate [--json]         report a resumable session
  task-worker --job-id <id> --workspace <dir>            (internal; reads the job's request file)

Unknown options:
  status / result / cancel / setup / watch carry no task text, so an unknown
  --flag there is a TYPO and is REJECTED (with a "did you mean"): \`status --watc\`
  used to warn and then quietly run a plain \`status\`. On task / wait-and-result /
  batch an undeclared --flag is TASK TEXT and is forwarded verbatim — that is a
  promise, not an oversight.

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

function main() {
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
}

// Only dispatch when this file is the entry script (same guard as the sibling
// MCP frontend). That lets tests import handleBatch/parseBatchArgv and drive
// them with injected seams, instead of only ever being able to shell out.
//
// main() is INVOKED AT THE BOTTOM OF THE FILE, not here: a handler that touches
// a `const` declared further down (batch's option tables) would otherwise hit
// its temporal dead zone, because the module body has not finished evaluating
// when this line runs.
function isEntryPoint() {
  try {
    return !!process.argv[1]
      && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

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

/**
 * Resolve the OUTPUT BUDGET from parsed flags.
 *
 * Brief mode is ON unless it is explicitly switched off. The asymmetry that
 * justifies the default: the delegated WORK is paid for on the OpenCode side and
 * costs the caller nothing, while the ANSWER is copied back into the caller's
 * context and re-read on every subsequent turn — so an unbounded answer is the
 * one part of a delegation that keeps costing. `--no-brief` / `--full` is the
 * escape hatch for the cases that genuinely want the long form.
 *
 * `brief: undefined` means "caller said nothing" and is passed through as such,
 * so the default lives in ONE place (prompts.mjs DEFAULT_BRIEF) rather than
 * being re-decided per call site.
 *
 * @param {Record<string, string|boolean>} options
 * @returns {{ brief: boolean|undefined, maxWords: number|undefined }}
 */
function resolveOutputBudget(options = {}) {
  const off = options["no-brief"] === true || options.full === true;
  const brief = off ? false : (options.brief === true ? true : undefined);

  let maxWords;
  const raw = options["max-words"];
  if (raw !== undefined && raw !== "") {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n > 0) {
      maxWords = n;
    } else {
      process.stderr.write(`[opencode] ignoring --max-words ${raw}: expected a positive number.\n`);
    }
  }
  // An explicit opt-out drops the cap with the budget — never smuggle a word
  // limit back into a run the caller asked to be long.
  return { brief, maxWords: off ? undefined : maxWords };
}

/**
 * Persist the output budget into a job's REQUEST file.
 *
 * createJobRecord writes the request file with the routing keys it knows about;
 * the budget is not one of them, and a DETACHED worker reads its entire dispatch
 * from that file (argv carries only a job id). Without this the budget would be
 * silently dropped on every `--background` / `wait-and-result` / `batch` run —
 * i.e. on exactly the paths that fan out and cost the most context.
 *
 * @param {string} workspace
 * @param {string} jobId
 * @param {object} request - the FULL request payload (writeJobRequest overwrites)
 */
function persistJobRequest(workspace, jobId, request) {
  if (request.brief === undefined && request.maxWords === undefined) return; // nothing extra to carry
  writeJobRequest(workspace, jobId, request);
}

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseStrictArgs("setup", argv);

  // The CLI launcher is a local, filesystem-only concern: it must not need the
  // OpenCode server (or even OpenCode) to be up, so it is handled before any
  // probing and returns on its own.
  if (options["install-cli"] || options["uninstall-cli"]) {
    handleCliInstall(options);
    return;
  }

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

/**
 * `setup --install-cli` / `--uninstall-cli`: put a short `occ` on PATH.
 *
 * Without it the only way to reach this tool is the full
 * `node ~/.claude/plugins/cache/<owner>/<plugin>/<version>/scripts/opencode-companion.mjs …`
 * — which is unusable by hand AND pins a version that dies at the next upgrade.
 * The installed launcher resolves the newest version at RUN time (see
 * lib/cli-install.mjs); nothing here or in it ever writes a version number down.
 *
 * @param {Record<string, string|boolean>} options
 */
function handleCliInstall(options) {
  if (options["install-cli"] && options["uninstall-cli"]) {
    console.error("Pass only one of --install-cli or --uninstall-cli.");
    process.exit(1);
  }

  const name = typeof options["cli-name"] === "string" && options["cli-name"].trim()
    ? options["cli-name"].trim()
    : DEFAULT_CLI_NAME;
  const scriptPath = fileURLToPath(import.meta.url);

  try {
    if (options["uninstall-cli"]) {
      const res = uninstallCli({ name });
      console.log(res.action === "removed"
        ? `Removed the \`${name}\` launcher: ${res.path}`
        : `Nothing to remove: ${res.path} does not exist.`);
      return;
    }

    const res = installCli({ name, scriptPath });
    const verb = res.action === "updated" ? "Updated" : "Installed";
    console.log(`${verb} the \`${res.name}\` launcher: ${res.path}`);
    console.log(res.source.kind === "plugin"
      ? `It resolves the newest installed version at run time (scanning ${res.source.pluginDir}), so it keeps working after a plugin upgrade.`
      : `It points at this source checkout: ${res.source.scriptPath}`);

    if (!res.onPath) {
      console.log(`\n⚠️  ${path.dirname(res.path)} is not on your PATH. Add it (copy-paste this line):`);
      console.log(`  ${res.hint}`);
    }

    console.log(`\nTry it:\n  ${res.name} status\n  ${res.name} watch\n  ${res.name} result <job id>`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
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

  const { brief, maxWords } = resolveOutputBudget(options);

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
  persistJobRequest(workspace, job.id, {
    taskText, model: options.model, agent: agentName,
    write: isWrite, worktree: useWorktree, resumeSessionId, brief, maxWords,
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

        const prompt = buildTaskPrompt(taskText, { write: isWrite, brief, maxWords });
        report("investigating", "Sending task to OpenCode...");
        log(`Agent: ${agentName}, Write: ${isWrite}, Prompt: ${prompt.length} chars, Model: ${options.model ?? "(provider default)"}, Brief: ${brief === false ? "off" : "on"}${maxWords ? `, MaxWords: ${maxWords}` : ""}`);

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

// ------------------------------------------------------------------
// Batch (fan-out delegation)
// ------------------------------------------------------------------

// The batch grammar. `--task` (or --prompt/--task-file) OPENS an item; every
// flag after it belongs to THAT item. Flags before the first item are defaults
// for all items — except a repeated `--model`, which is the fan-out list ("same
// question, N models"). Bare words are the shared task text.
const BATCH_VALUE_KEYS = new Set(["task", "prompt", "task-file", "file", "model", "agent", "label", "max-words", "timeout-ms"]);
const BATCH_BOOLEAN_KEYS = new Set(["worktree", "brief", "no-brief", "full"]);

/** Whether an option bag carries any explicit output-budget flag. */
function hasBudgetFlag(o = {}) {
  return o.brief !== undefined || o["no-brief"] !== undefined
    || o.full !== undefined || o["max-words"] !== undefined;
}

/**
 * Normalize one item of a --file tasks.json into the internal item shape, so a
 * JSON item and a `--task …` item go through exactly the same resolution.
 * @param {object} t
 * @returns {{ opts: object, words: string[], taskText: string }}
 */
function batchItemFromJson(t) {
  const opts = {};
  if (typeof t?.model === "string") opts.model = t.model;
  if (typeof t?.agent === "string") opts.agent = t.agent;
  if (typeof t?.label === "string") opts.label = t.label;
  if (t?.worktree === true) opts.worktree = true;
  if (t?.brief === true) opts.brief = true;
  if (t?.brief === false) opts["no-brief"] = true;
  if (t?.maxWords !== undefined) opts["max-words"] = t.maxWords;
  const taskText = typeof t?.task === "string" ? t.task : (typeof t?.prompt === "string" ? t.prompt : "");
  return { opts, words: [], taskText: taskText.trim() };
}

/**
 * Parse `batch` argv into concrete items. Pure (the file reader is injectable),
 * so the grammar is unit-testable without dispatching anything.
 *
 * @param {string[]} argv
 * @param {{ readFile?: (p: string) => string }} [io]
 * @returns {{ items: object[], globals: object, errors: string[] }}
 */
export function parseBatchArgv(argv, io = {}) {
  const readFile = io.readFile ?? ((p) => fs.readFileSync(p, "utf8"));

  const errors = [];
  const globals = {};
  const fanoutModels = [];   // repeated --model BEFORE the first item
  const sharedWords = [];    // bare words BEFORE the first item
  const items = [];
  let cur = null;            // the item currently open

  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!endOfOptions && arg === "--") { endOfOptions = true; continue; }

    const opt = endOfOptions ? null : matchOption(arg);
    if (!opt) {
      // Bare word (or, after `--`, anything at all): task text for whatever item
      // is open — or the shared fan-out task when none is.
      (cur ? cur.words : sharedWords).push(arg);
      continue;
    }

    const { key, inlineValue } = opt;
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || matchOption(next)) {
        errors.push(`--${key} expects a value but none was given`);
        return undefined;
      }
      return argv[++i];
    };

    // --task / --prompt / --task-file OPEN a new item.
    if (key === "task" || key === "prompt" || key === "task-file") {
      const v = takeValue();
      if (v === undefined) continue;
      let taskText = v;
      if (key === "task-file") {
        try {
          taskText = readFile(path.resolve(process.cwd(), v));
        } catch (err) {
          errors.push(`could not read --task-file ${v}: ${err.message}`);
          continue;
        }
      }
      cur = { opts: {}, words: [], taskText: String(taskText).trim() };
      items.push(cur);
      continue;
    }

    // --file <tasks.json>: a whole list of items at once.
    if (key === "file") {
      const v = takeValue();
      if (v === undefined) continue;
      let list;
      try {
        const doc = JSON.parse(readFile(path.resolve(process.cwd(), v)));
        list = Array.isArray(doc) ? doc : (Array.isArray(doc?.tasks) ? doc.tasks : null);
        if (!list) throw new Error('expected a JSON array of tasks, or { "tasks": [ … ] }');
      } catch (err) {
        errors.push(`could not read --file ${v}: ${err.message}`);
        continue;
      }
      for (const t of list) items.push(batchItemFromJson(t));
      cur = null; // flags after --file are defaults again, not "the last item's"
      continue;
    }

    if (BATCH_VALUE_KEYS.has(key)) {
      const v = takeValue();
      if (v === undefined) continue;
      // A repeated --model in the GLOBAL scope is the fan-out list; inside an
      // item it is simply that item's model.
      if (key === "model" && !cur) fanoutModels.push(v);
      else (cur ? cur.opts : globals)[key] = v;
      continue;
    }

    if (BATCH_BOOLEAN_KEYS.has(key)) {
      (cur ? cur.opts : globals)[key] = true;
      continue;
    }

    // Undeclared: task text, verbatim (same promise as `task`).
    (cur ? cur.words : sharedWords).push(arg);
  }

  const sharedTask = sharedWords.join(" ").trim();

  if (!items.length) {
    // Fan-out form: one shared task, one item per --model (or a single item).
    if (!sharedTask) {
      errors.push("no tasks given — pass a shared task text (with one --model per fan-out target), one or more --task, or --file <tasks.json>");
    } else {
      const models = fanoutModels.length ? fanoutModels : [undefined];
      for (const m of models) items.push({ opts: m ? { model: m } : {}, words: [], taskText: sharedTask });
    }
  } else {
    if (sharedTask) {
      errors.push(`stray task text before the first --task/--file ("${sharedTask.slice(0, 40)}") — put it in a --task, or drop the --task flags to fan one shared task out across the --model list`);
    }
    if (fanoutModels.length > 1) {
      errors.push("several --model flags were given before the first --task — that is the fan-out spelling (one shared task, N models). With explicit --task items, give each item its own --model.");
    }
  }

  const resolved = items.map((it, idx) => {
    const o = it.opts;
    // A --task value and trailing bare words concatenate: neither is ever
    // silently dropped (`--task "fix X" and also Y` → "fix X and also Y").
    const taskText = [it.taskText, it.words.join(" ")].filter(Boolean).join(" ").trim();
    const model = o.model ?? (fanoutModels.length === 1 ? fanoutModels[0] : undefined) ?? globals.model;
    const agent = o.agent ?? globals.agent ?? "build";
    const worktree = !!(o.worktree ?? globals.worktree);
    // Item budget flags REPLACE the global ones wholesale (so an item's --brief
    // beats a global --no-brief instead of colliding with it).
    const { brief, maxWords } = resolveOutputBudget(hasBudgetFlag(o) ? o : globals);
    const label = (typeof o.label === "string" && o.label.trim())
      ? o.label.trim()
      : (model ?? `task ${idx + 1}`);

    if (!taskText) errors.push(`task ${idx + 1} (${label}) has no task text`);
    if (agent !== "build" && agent !== "plan") {
      errors.push(`task ${idx + 1} (${label}): --agent must be build or plan, got "${agent}"`);
    }

    return { taskText, model, agent, label, worktree, brief, maxWords, write: agent !== "plan" };
  });

  return { items: resolved, globals, errors };
}

/**
 * Render a finished batch: one compact section per task (label + result + the
 * single-line trailer), plus an explicit roll-call of what failed.
 *
 * Compactness is the point. The whole summary lands in the caller's context and
 * is re-read on every later turn, so N results must not become N essays — that
 * is what the output budget on each dispatch is for, and this format assumes it.
 *
 * @param {object[]} entries
 * @returns {string}
 */
export function formatBatchSummary(entries) {
  const okCount = entries.filter((e) => e.status === "completed").length;
  const failed = entries.filter((e) => e.status !== "completed");

  const head = `Batch: ${okCount}/${entries.length} succeeded${failed.length ? ` · ${failed.length} failed` : ""}`;

  const sections = entries.map((e, i) => {
    const tag = `[${i + 1}] ${e.label} · ${e.jobId}`;
    if (e.status !== "completed") {
      return `### ${tag} — ${String(e.status).toUpperCase()}\n${e.error ?? "unknown error"}`;
    }
    const body = (e.rendered ?? "").trim() || "(task completed with no output)";
    const trailer = formatTrailer(e.usage, { requestedModel: e.requestedModel, sessionId: e.sessionId });
    return `### ${tag}\n${body}${trailer ? `\n${trailer}` : ""}`;
  });

  const parts = [head, "", sections.join("\n\n")];
  if (failed.length) {
    parts.push(
      "",
      `Failed: ${failed.map((e) => `${e.label} (${e.jobId})`).join(", ")} — inspect with \`status <job id>\`, re-run one with \`task\`.`
    );
  }
  return parts.join("\n");
}

/**
 * Dispatch N tasks in ONE call, in parallel, and block until all are done.
 *
 * Why this exists: fanning out used to cost the caller N `task --background`
 * round-trips, then repeated `status` polls, then N `result` calls — and every
 * one of those tool calls is itself context the caller pays for on every later
 * turn. This is one call in, one compact summary out.
 *
 * Semantics copied from the sibling MCP frontend's oc_delegate_batch, because
 * they were learned the hard way:
 *   - PRE-WARM the OpenCode server exactly once before fanning out. Otherwise N
 *     workers all call connect()→ensureServer() at once and, on a cold start,
 *     race to spawn `opencode serve` on the same port; every loser dies.
 *   - one task's failure NEVER takes down its siblings; a partial batch still
 *     returns everything that did succeed, and names what did not.
 * Each item is an ordinary tracked job, so status/result/cancel still address
 * them individually.
 *
 * @param {string[]} argv
 * @param {object} [deps] - injectable seams (tests pass fakes; production passes nothing)
 * @returns {Promise<{ summary: string, entries: object[], okCount: number, total: number }>}
 */
export async function handleBatch(argv, deps = {}) {
  const ensureServerFn = deps.ensureServer ?? ensureServer;
  const spawnFn = deps.spawnDetached ?? spawnDetached;
  const waitFn = deps.waitForTerminalJob ?? waitForTerminalJob;
  const readResult = deps.readResult ?? ((ws, id) => readJson(jobDataPath(ws, id)));

  const parsed = parseBatchArgv(argv);
  if (parsed.errors.length) {
    throw new Error(
      `Invalid arguments for \`batch\`:\n  - ${parsed.errors.join("\n  - ")}\n\n` +
      "Fan one task out across models:  batch --model p/m-a --model p/m-b \"<task>\"\n" +
      "Or give each task its own flags: batch --task \"A\" --model p/m-a --task \"B\" --model p/m-b\n" +
      "Run `batch --help` for the full usage."
    );
  }

  const workspace = deps.workspace ?? await resolveWorkspace();
  const timeoutMs = resolveTimeoutMs(parsed.globals["timeout-ms"]);

  // Warm the server ONCE, before the fan-out (see the doc comment above). Its
  // failure is swallowed: each worker then surfaces its own connect error
  // instead of the whole batch dying on a shared pre-flight.
  await ensureServerFn({ cwd: workspace }).catch(() => {});

  const dispatched = parsed.items.map((item) => {
    const job = createJobRecord(workspace, "task", {
      agent: item.agent,
      model: item.model,
      write: item.write,
      worktree: item.worktree,
      taskText: item.taskText,
    });
    persistJobRequest(workspace, job.id, {
      taskText: item.taskText, model: item.model, agent: item.agent,
      write: item.write, worktree: item.worktree, resumeSessionId: null,
      brief: item.brief, maxWords: item.maxWords,
    });

    const child = spawnFn("node", buildWorkerArgs({ jobId: job.id, workspace }), { cwd: workspace });
    if (!child?.pid) {
      // This item is dead, but its siblings are not: record the failure and
      // keep dispatching.
      const msg = "Failed to start the OpenCode worker process.";
      upsertJob(workspace, {
        id: job.id, status: "failed",
        completedAt: new Date().toISOString(), errorMessage: msg,
      });
      return { ...item, jobId: job.id, spawned: false, error: msg };
    }
    upsertJob(workspace, {
      id: job.id, pid: child.pid, pidStart: pidStartTime(child.pid), detachedWorker: true,
    });
    return { ...item, jobId: job.id, spawned: true };
  });

  // Announce the ids BEFORE blocking: if the caller's Bash call is cut off by
  // its own timeout, the results are still retrievable instead of lost.
  process.stderr.write(
    `[opencode] batch dispatched ${dispatched.length} job(s): ${dispatched.map((e) => e.jobId).join(", ")}\n` +
    "[opencode] blocking until all finish. If this call is cut off, retrieve each with: result <job id>\n"
  );

  const entries = await Promise.all(dispatched.map(async (e) => {
    if (!e.spawned) return { ...e, status: "failed" };
    try {
      const st = await waitFn(workspace, e.jobId, timeoutMs);
      if (!st) {
        return {
          ...e, status: "timeout",
          error: `still running after ${Math.round(timeoutMs / 1000)}s — retrieve later with: result ${e.jobId}`,
        };
      }
      if (st.status !== "completed") {
        return { ...e, status: st.status, error: st.errorMessage ?? "unknown error" };
      }
      const data = readResult(workspace, e.jobId);
      return {
        ...e,
        status: "completed",
        rendered: data?.rendered ?? st.result ?? "",
        usage: data?.usage,
        requestedModel: data?.requestedModel ?? st.requestedModel ?? e.model,
        sessionId: data?.opencodeSessionId ?? st.opencodeSessionId,
      };
    } catch (err) {
      // A sibling's bookkeeping blowing up must not reject the whole Promise.all
      // and take the successful results down with it.
      return { ...e, status: "failed", error: err.message };
    }
  }));

  return {
    summary: formatBatchSummary(entries),
    entries,
    okCount: entries.filter((e) => e.status === "completed").length,
    total: entries.length,
  };
}

// CLI wrapper: print the summary, and exit non-zero only when EVERY task failed
// (a partial batch is a success — its results are real).
async function cliBatch(argv) {
  const res = await handleBatch(argv);
  console.log(res.summary);
  if (res.total > 0 && res.okCount === 0) process.exit(1);
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

  const { brief, maxWords } = resolveOutputBudget(options);

  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
    model: options.model,
    write: isWrite,
    worktree: useWorktree,
    taskText,
  });
  persistJobRequest(workspace, job.id, {
    taskText, model: options.model, agent: agentName,
    write: isWrite, worktree: useWorktree, resumeSessionId, brief, maxWords,
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
    valueOptions: ["job-id", "workspace", "task-file", "task-text", "agent", "model", "resume-session", "max-words"],
    booleanOptions: ["write", "worktree", "brief", "no-brief", "full"],
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

  // The output budget travels in the request file (the worker's whole dispatch
  // does). An explicit worker flag still wins, so a hand-run worker can override
  // what the parent recorded. `undefined` stays undefined: it means "not
  // specified", and the single default lives in prompts.mjs.
  const argvBudget = resolveOutputBudget(options);
  const brief = argvBudget.brief ?? request.brief;
  const maxWords = argvBudget.maxWords ?? (brief === false ? undefined : request.maxWords);

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

        const prompt = buildTaskPrompt(taskText, { write: isWrite, brief, maxWords });
        report("investigating", resumeSessionId ? `Resuming session ${resumeSessionId}...` : "Running task...");
        log(`Brief: ${brief === false ? "off" : "on"}${maxWords ? `, MaxWords: ${maxWords}` : ""}`);

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

// ------------------------------------------------------------------
// Status --watch (a live panel, outside Claude entirely)
// ------------------------------------------------------------------

// In-place repaint, like top(1): clear the screen AND the scrollback, home the
// cursor. Only ever emitted to a TTY — piping the panel into a file or a log
// must not spray escape codes into it.
const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const WATCH_DEFAULT_INTERVAL_MS = 3000;
const WATCH_MIN_INTERVAL_MS = 1000;
const WATCH_MAX_INTERVAL_MS = 300000;
// The state file is cheap to re-read every tick; the SERVER probe inside
// recoverStrandedResults is not (it is an HTTP round-trip per stranded job).
// So the probe runs on its own, slower clock instead of on every repaint.
const WATCH_DEFAULT_PROBE_MS = 15000;

/**
 * Resolve `status --watch` flags into a concrete watch config.
 * @param {Record<string, string|boolean>} options
 * @param {{ isTTY?: boolean }} [env]
 * @returns {{ intervalMs: number, probeEveryMs: number, exitWhenIdle: boolean, isTTY: boolean }}
 */
export function resolveWatchOptions(options = {}, env = {}) {
  let intervalMs = WATCH_DEFAULT_INTERVAL_MS;
  const raw = options.interval;
  if (raw !== undefined && raw !== "") {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) {
      // Clamp rather than reject: a 0.1s panel would hammer the state file, and
      // a 2h one is not a live panel at all.
      intervalMs = Math.min(WATCH_MAX_INTERVAL_MS, Math.max(WATCH_MIN_INTERVAL_MS, Math.round(secs * 1000)));
    } else {
      process.stderr.write(`[opencode] ignoring --interval ${raw}: expected a positive number of seconds.\n`);
    }
  }

  const probeRaw = Number(options["probe-ms"]);
  const probeEveryMs = Number.isFinite(probeRaw) && probeRaw >= 0 ? probeRaw : WATCH_DEFAULT_PROBE_MS;

  return {
    intervalMs,
    // Never probe more often than we repaint.
    probeEveryMs: Math.max(probeEveryMs, intervalMs),
    exitWhenIdle: options["exit-when-idle"] === true,
    isTTY: env.isTTY ?? !!process.stdout.isTTY,
  };
}

/**
 * One frame's worth of status: the rendered panel plus whether anything is
 * still alive. `probe` gates the (network) server salvage, so a fast repaint
 * interval never turns into a fast polling loop against the OpenCode server.
 *
 * @param {string} workspace
 * @param {{ sessionId?: string, ref?: string, probe?: boolean }} [opts]
 * @returns {Promise<{ text: string, running: number }>}
 */
async function collectStatus(workspace, opts = {}) {
  const { sessionId, ref, probe = true } = opts;

  let jobs = loadState(workspace).jobs ?? [];
  if (probe) {
    jobs = await recoverStrandedResults(workspace, jobs, defaultServerUrl());
    jobs = reconcileStrandedJobs(workspace, jobs);
  }

  const running = jobs.filter((j) => j.status === "running" || j.status === "pending").length;

  if (ref) {
    const { job } = matchJobReference(jobs, ref);
    const text = job
      ? renderStatus(buildStatusSnapshot([job], workspace, {}))
      : `No such job: ${ref}.`;
    return { text, running };
  }

  return { text: renderStatus(buildStatusSnapshot(jobs, workspace, { sessionId })), running };
}

/**
 * The panel's header. It states the two things a user watching a 13-minute
 * fan-out actually needs to know: that the panel is alive (timestamp + interval),
 * and whose tokens the numbers below are.
 *
 * @param {{ at: Date, intervalMs: number, running: number, workspace: string }} f
 * @returns {string}
 */
export function renderWatchHeader({ at, intervalMs, running, workspace }) {
  const clock = at.toTimeString().slice(0, 8);
  const every = `${Math.round(intervalMs / 100) / 10}s`;
  return [
    `OpenCode delegations · live — refreshed ${clock}, every ${every} · Ctrl-C to exit`,
    `${running} running · ${workspace}`,
    "Token counts below are OPENCODE-side usage. This panel costs 0 Claude tokens:",
    "it talks to the local job state, not to Claude. Run it in a second terminal.",
    "─".repeat(72),
  ].join("\n");
}

/**
 * The watch loop.
 *
 * Every seam a test needs is injectable — `maxTicks` above all, so the loop can
 * be driven a bounded number of frames instead of a test having to race a real
 * `setInterval` and hope.
 *
 * @param {object} cfg - from resolveWatchOptions, plus workspace/sessionId/ref
 * @param {object} [deps]
 * @returns {Promise<{ ticks: number, idle: boolean }>}
 */
export async function runStatusWatch(cfg, deps = {}) {
  const snapshot = deps.snapshot ?? collectStatus;
  const write = deps.write ?? ((s) => process.stdout.write(s));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const now = deps.now ?? (() => new Date());
  const shouldStop = deps.shouldStop ?? (() => false);
  const maxTicks = deps.maxTicks ?? Infinity;

  const { workspace, sessionId, ref, intervalMs, probeEveryMs, exitWhenIdle, isTTY } = cfg;

  let ticks = 0;
  let lastProbeAt = -Infinity;
  let idle = false;

  while (ticks < maxTicks && !shouldStop()) {
    const t = nowMs();
    const probe = t - lastProbeAt >= probeEveryMs;
    const snap = await snapshot(workspace, { sessionId, ref, probe });
    if (probe) lastProbeAt = t;

    // `scope` lets a snapshot rename the board it is showing (the cross-workspace
    // panel says "all workspaces · 3 repos" where the single-repo one says a
    // path). A snapshot that doesn't set it keeps the configured workspace.
    const header = renderWatchHeader({
      at: now(), intervalMs, running: snap.running, workspace: snap.scope ?? workspace,
    });
    // An empty board is a legitimate frame, not a reason to quit: the user may
    // be about to dispatch the next round and wants the panel to stay up.
    const frame = `${header}\n${snap.text}\n`;

    // A pipe gets plain appended frames: no clear, no cursor codes — the panel
    // stays greppable and a log file stays readable.
    write(isTTY ? `${CLEAR_SCREEN}${frame}` : `\n${frame}`);

    ticks++;
    idle = snap.running === 0;
    if (exitWhenIdle && idle) break;
    if (ticks >= maxTicks || shouldStop()) break;
    await sleep(intervalMs);
  }

  return { ticks, idle };
}

// ------------------------------------------------------------------
// watch — the same live panel, but across EVERY workspace
// ------------------------------------------------------------------

// `status --watch` only ever shows the CURRENT cwd's workspace, because job
// state is stored per workspace (hashed path). So watching a delegation you
// dispatched from another repo meant `cd`-ing there first — and if you didn't,
// the panel was simply, silently empty.
//
// `watch` aggregates every workspace in the data dir instead, and tags each row
// with the repo it belongs to. It is STRICTLY READ-ONLY: no server probe, no
// state write. That is not laziness, it is the contract — a panel must not
// mutate the state of jobs it is only observing (`status` keeps its own probe on
// its own slow clock), and a repaint must stay cheap enough to run every 3s.

/**
 * Short, unambiguous label for each workspace: the repo's directory name, or the
 * hash prefix when we don't know the path (a state dir written before the
 * workspace sidecar existed). Two repos with the SAME basename get their parent
 * dir folded in, so `a/api` and `b/api` never render as the same thing — a long
 * absolute path per row would just flood the panel.
 *
 * @param {{ hash: string, workspace: string|null }[]} groups
 * @returns {Map<string, string>} hash → label
 */
export function labelWorkspaces(groups = []) {
  const base = new Map();
  const counts = new Map();

  for (const g of groups) {
    const name = g.workspace ? path.basename(g.workspace) : `#${g.hash.slice(0, 8)}`;
    base.set(g.hash, name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const labels = new Map();
  for (const g of groups) {
    const name = base.get(g.hash);
    if (counts.get(name) > 1 && g.workspace) {
      const parent = path.basename(path.dirname(g.workspace));
      labels.set(g.hash, parent ? `${parent}/${name}` : name);
    } else {
      labels.set(g.hash, name);
    }
  }
  return labels;
}

/**
 * Build one cross-workspace snapshot: every repo's jobs, enriched, repo-tagged,
 * newest first. A corrupt state.json is skipped upstream (listWorkspaceStates),
 * so one unreadable repo can never blank the whole board.
 *
 * @param {{ base?: string, only?: string|null }} [opts] - `only` = a single workspace path
 * @returns {{ text: string, running: number, scope: string }}
 */
export function collectAggregateStatus(opts = {}) {
  const groups = listWorkspaceStates({ base: opts.base });
  const labels = labelWorkspaces(groups);

  // Match a --workspace by its hashed dir, not just by the stamped path: a state
  // dir written before the sidecar existed has no path to compare against, but
  // its directory name is still sha256(that path) — so it resolves anyway.
  const onlyHash = opts.only ? path.basename(stateRoot(opts.only)) : null;

  const tagged = [];
  for (const g of groups) {
    if (opts.only && g.workspace !== opts.only && g.hash !== onlyHash) continue;
    for (const job of g.jobs) {
      // enrichJob needs the workspace path to find the job's log (it re-derives
      // the same hashed dir). An unlabeled legacy dir therefore loses only the
      // live progress preview — and only for jobs that are still running, which
      // in practice are always freshly stamped.
      tagged.push({ ...enrichJob(job, g.workspace ?? ""), repo: labels.get(g.hash) });
    }
  }

  const sorted = sortJobsNewestFirst(tagged);
  const running = sorted.filter((j) => j.status === "running" || j.status === "pending");
  const finished = sorted.filter(
    (j) => j.status === "completed" || j.status === "failed" || j.status === "canceled"
  );

  const repos = opts.only ? 1 : groups.length;
  const scope = opts.only
    ? opts.only
    : `all workspaces · ${repos} repo${repos === 1 ? "" : "s"}`;

  return {
    text: renderAggregateStatus({ running, recent: finished.slice(0, 8) }),
    running: running.length,
    scope,
  };
}

/**
 * Render the cross-workspace board. Same information as `renderStatus` (and the
 * same log parsing — liveSignal/recentActivity are imported, not re-implemented),
 * plus a `[repo]` tag on every row, which is the entire point of this view.
 *
 * @param {{ running: object[], recent: object[] }} snapshot
 * @returns {string}
 */
export function renderAggregateStatus(snapshot) {
  const running = snapshot.running ?? [];
  const recent = snapshot.recent ?? [];
  const icon = { running: "🟢", pending: "🟡", completed: "✅", failed: "❌", canceled: "⛔" };
  const tag = (j) => (j.repo ? `[${j.repo}] ` : "");
  const lines = [];

  if (running.length) {
    lines.push(`## Running Jobs (${running.length})\n`);
    for (const job of running) {
      const { tokens, ageSec } = liveSignal(job.progressPreview);
      const bits = [
        `${icon[job.status] ?? "🟢"} ${tag(job)}**${job.id}** (${job.type})`,
        job.phase ?? "running",
        job.elapsed ?? "just started",
      ];
      if (tokens) bits.push(`${tokens} OpenCode tokens`);
      if (ageSec != null) bits.push(`updated ${ageSec}s ago${ageSec > 120 ? " ⚠️ possibly stuck" : ""}`);
      lines.push(`- ${bits.join(" · ")}`);
      for (const a of recentActivity(job.progressPreview, 2)) lines.push(`  ↳ ${a}`);
    }
    lines.push("");
  }

  const failed = recent.filter((j) => j.status === "failed");
  if (failed.length) {
    lines.push(`## ❌ Failed (${failed.length})\n`);
    for (const j of failed) {
      lines.push(`- ❌ ${tag(j)}**${j.id}** (${j.type}) — failed — ${j.elapsed ?? "just started"}`);
      if (j.errorMessage) lines.push(`  Error: ${j.errorMessage}`);
    }
    lines.push("");
  }

  const done = recent.filter((j) => j.status !== "failed");
  if (done.length) {
    lines.push(`## Recently Finished (${done.length})\n`);
    for (const j of done) {
      const empty = j.emptyResult && j.status === "completed" ? " ⚠️ no output" : "";
      lines.push(
        `- ${icon[j.status] ?? "•"} ${tag(j)}**${j.id}** (${j.type}) — ${j.status}${empty} — ${j.elapsed ?? "just started"}`
      );
    }
    lines.push("");
  }

  if (!running.length && !recent.length) {
    lines.push("No jobs in any workspace yet.");
    lines.push("");
  }

  lines.push("_Retrieve a result from any repo with:_ `result <job id>` _(run it in that repo)._");
  return lines.join("\n");
}

async function handleWatch(argv) {
  const { options } = parseStrictArgs("watch", argv);

  // --workspace narrows the aggregate board back down to ONE repo without
  // needing to cd into it. (`status --watch` keeps its old cwd-scoped behavior.)
  const only = typeof options.workspace === "string" && options.workspace
    ? await resolveWorkspace(path.resolve(options.workspace))
    : null;

  const cfg = { ...resolveWatchOptions(options), workspace: only ?? "all workspaces" };

  let stopped = false;
  const cleanup = () => {
    if (cfg.isTTY) process.stdout.write(SHOW_CURSOR);
  };
  const onSigint = () => {
    stopped = true;
    cleanup();
    process.stdout.write("\n");
    process.exit(0); // a watcher exits 0: being stopped is not a failure
  };
  process.on("SIGINT", onSigint);
  if (cfg.isTTY) process.stdout.write(HIDE_CURSOR);

  try {
    await runStatusWatch(cfg, {
      shouldStop: () => stopped,
      snapshot: async () => collectAggregateStatus({ only }),
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
    cleanup();
  }
}

async function handleStatus(argv) {
  const { options, positional } = parseStrictArgs("status", argv);
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
  if (options.wait && options.watch) {
    console.error("Pass either --wait (block until one job finishes, then print it) or --watch (a live panel), not both.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const sessionId = getClaudeSessionId();

  // --watch: repaint the panel in place until Ctrl-C. This runs entirely outside
  // Claude — no model call, no context, no tokens — which is the whole point:
  // a user watching a long fan-out should not have to pay Claude to look at it.
  if (options.watch) {
    const cfg = { ...resolveWatchOptions(options), workspace, sessionId, ref };

    let stopped = false;
    const cleanup = () => {
      if (cfg.isTTY) process.stdout.write(SHOW_CURSOR);
    };
    const onSigint = () => {
      stopped = true;      // let the loop finish its current frame and return
      cleanup();
      process.stdout.write("\n");
      process.exit(0);     // a watcher exits 0: being stopped is not a failure
    };
    process.on("SIGINT", onSigint);
    if (cfg.isTTY) process.stdout.write(HIDE_CURSOR);

    try {
      await runStatusWatch(cfg, { shouldStop: () => stopped });
    } finally {
      process.removeListener("SIGINT", onSigint);
      cleanup();
    }
    return;
  }

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
  const { positional } = parseStrictArgs("result", argv);
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
  const { positional } = parseStrictArgs("cancel", argv);
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

// ------------------------------------------------------------------
// Entry point (LAST: every module-level const above is initialized by now)
// ------------------------------------------------------------------

if (isEntryPoint()) main();

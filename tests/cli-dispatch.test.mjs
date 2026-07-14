// CLI argument parsing + dispatch correctness.
//
// Covers the three field-reported bugs:
//   1. task text starting with "--" reached the worker EMPTY (it travelled on
//      argv, where the worker's parser refused an option-shaped value), and the
//      worker then died before writing its first log line. The task text now
//      travels in the job's request file; the worker gets only --job-id.
//   2. `wait-and-result <job-id>` dispatched a NEW job whose "task" was the
//      opaque job id instead of waiting for that job.
//   3. `--task "…"` was an unknown option: it was dropped with a warning and the
//      job ran with an EMPTY task, burning a whole delegation.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseTaskArgv, classifyWaitTarget, looksLikeJobId } from "../plugins/opencode/scripts/lib/args.mjs";

const CLI = fileURLToPath(new URL("../plugins/opencode/scripts/opencode-companion.mjs", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("../plugins/opencode", import.meta.url));

// A port nothing listens on: a worker under test must fail to reach a server
// fast instead of ever talking to a real OpenCode daemon.
const DEAD_PORT = "45999";

let tmpRoot;
let dataDir;
let workspace;
let gitOnlyBin; // a PATH with git but no node ⇒ spawnDetached("node") fails fast

// state.mjs reads OPENCODE_COMPANION_DATA at call time, so the test process and
// the CLI children must agree on it.
before(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-cli-test-")));
  dataDir = path.join(tmpRoot, "data");
  workspace = path.join(tmpRoot, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  process.env.OPENCODE_COMPANION_DATA = dataDir;
  process.env.OPENCODE_COMPANION_SESSION_ID = "test-session-cli";

  gitOnlyBin = path.join(tmpRoot, "bin");
  fs.mkdirSync(gitOnlyBin, { recursive: true });
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  if (gitPath) fs.symlinkSync(gitPath, path.join(gitOnlyBin, "git"));
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

const state = await import("../plugins/opencode/scripts/lib/state.mjs");
const trackedJobs = await import("../plugins/opencode/scripts/lib/tracked-jobs.mjs");

function jobs() {
  return state.loadState(workspace).jobs ?? [];
}

function resetState() {
  try { fs.rmSync(state.stateRoot(workspace), { recursive: true, force: true }); } catch { /* nothing there */ }
}

function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        OPENCODE_COMPANION_DATA: dataDir,
        OPENCODE_SERVER_PORT: DEAD_PORT,
        ...opts.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ------------------------------------------------------------------
// Task-argv scanning: routing flags vs. verbatim task text
// ------------------------------------------------------------------

describe("parseTaskArgv — routing flags vs. verbatim task text", () => {
  const schema = {
    valueOptions: ["model", "agent", "task", "prompt", "task-file"],
    booleanOptions: ["write", "background", "wait", "resume-last", "fresh", "worktree"],
  };

  it("accepts --task as a task-text source instead of choking on it", () => {
    const { options, errors, taskText } = parseTaskArgv(
      ["--background", "--model", "openai/gpt-5", "--task", "中文任务"],
      schema
    );
    assert.deepEqual(errors, []);
    assert.equal(options.task, "中文任务");
    assert.equal(options.background, true);
    assert.equal(taskText, ""); // it is not positional; resolveTaskText folds it in
  });

  it("keeps an undeclared --flag in the task text verbatim (git commit --no-verify)", () => {
    const { errors, taskText } = parseTaskArgv(
      ["run", "git", "commit", "--no-verify", "then", "push"],
      schema
    );
    assert.deepEqual(errors, []);
    assert.equal(taskText, "run git commit --no-verify then push");
  });

  it("demotes an undeclared option to task text instead of erroring (upstream rule)", () => {
    const { errors, taskText } = parseTaskArgv(["--tsak", "fix", "the", "build"], schema);
    assert.deepEqual(errors, []);
    assert.equal(taskText, "--tsak fix the build");
  });

  it("treats a quoted dashed sentence as task text, not an option", () => {
    const { errors, taskText } = parseTaskArgv(["--no-verify 这参数啥意思"], schema);
    assert.deepEqual(errors, []);
    assert.equal(taskText, "--no-verify 这参数啥意思");
  });

  it("keeps everything after the -- sentinel as task text", () => {
    const { options, errors, taskText } = parseTaskArgv(
      ["--model", "x/y", "--", "--no-verify", "what", "does", "this", "do?"],
      schema
    );
    assert.deepEqual(errors, []);
    assert.equal(options.model, "x/y");
    assert.equal(taskText, "--no-verify what does this do?");
  });

  it("errors when a declared value option is missing its value (never silently defaults)", () => {
    const { errors, options } = parseTaskArgv(["--model", "--write", "fix", "it"], schema);
    assert.deepEqual(errors, ["--model expects a value but none was given"]);
    assert.equal(options.model, undefined);
    assert.equal(options.write, true); // --write is NOT eaten as the model value
  });

  it("parses routing flags and leaves the positional text intact", () => {
    const { options, taskText, errors } = parseTaskArgv(
      ["--background", "--agent", "plan", "调查", "这个", "bug"],
      schema
    );
    assert.deepEqual(errors, []);
    assert.equal(options.background, true);
    assert.equal(options.agent, "plan");
    assert.equal(taskText, "调查 这个 bug");
  });
});

// ------------------------------------------------------------------
// wait-and-result target classification
// ------------------------------------------------------------------

describe("classifyWaitTarget", () => {
  const existing = [{ id: "task-mrkyzulu-fy4ojt" }, { id: "review-mrkza1b2-zz9911" }];

  it("waits for an existing job when given its id", () => {
    assert.deepEqual(classifyWaitTarget("task-mrkyzulu-fy4ojt", existing), {
      kind: "await", jobId: "task-mrkyzulu-fy4ojt",
    });
  });

  it("waits for an existing job when given an unambiguous id prefix", () => {
    assert.deepEqual(classifyWaitTarget("task-mrkyzulu", existing), {
      kind: "await", jobId: "task-mrkyzulu-fy4ojt",
    });
  });

  it("errors (never dispatches) on a job-id-shaped ref that is not in state", () => {
    assert.deepEqual(classifyWaitTarget("task-mrkyzulu-fy4ojt", []), {
      kind: "missing", jobId: "task-mrkyzulu-fy4ojt",
    });
  });

  it("flags an ambiguous prefix instead of dispatching it", () => {
    const res = classifyWaitTarget("task-mrky", [{ id: "task-mrkya-aaaa11" }, { id: "task-mrkyb-bbbb22" }]);
    assert.equal(res.kind, "missing");
    assert.equal(res.ambiguous, true);
  });

  it("dispatches genuine task text", () => {
    assert.equal(classifyWaitTarget("重构 X 模块并补测试", existing).kind, "dispatch");
    assert.equal(classifyWaitTarget("refactor", existing).kind, "dispatch");
    // A dashed English phrase that is not a known job id is still task text.
    assert.equal(classifyWaitTarget("fix-the-build", existing).kind, "dispatch");
  });

  it("recognizes generated job-id shapes only", () => {
    assert.equal(looksLikeJobId("task-mrkyzulu-fy4ojt"), true);
    assert.equal(looksLikeJobId("adversarial-review-mrkyzulu-fy4ojt"), true);
    assert.equal(looksLikeJobId("refactor"), false);
    assert.equal(looksLikeJobId("重构模块"), false);
  });
});

// ------------------------------------------------------------------
// tracked-jobs: request file + persisted model/preview
// ------------------------------------------------------------------

describe("createJobRecord — request file, requested model, task preview", () => {
  beforeEach(() => resetState());

  it("persists the task text in a 0600 request file the worker can read back", () => {
    const job = trackedJobs.createJobRecord(workspace, "task", {
      agent: "build", model: "p/m", taskText: "--task 中文任务",
    });
    const file = trackedJobs.jobRequestPath(workspace, job.id);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const req = trackedJobs.readJobRequest(workspace, job.id);
    assert.equal(req.taskText, "--task 中文任务"); // survives the leading "--"
    assert.equal(req.model, "p/m");
    assert.equal(req.agent, "build");
  });

  it("stores requestedModel + a truncated taskPreview in state, never the raw text", () => {
    const job = trackedJobs.createJobRecord(workspace, "task", {
      agent: "build", model: "someprovider/some-model", taskText: "重".repeat(300),
    });
    const rec = jobs().find((j) => j.id === job.id);
    assert.equal(rec.requestedModel, "someprovider/some-model");
    assert.equal(rec.taskPreview.length, 101); // 100 chars + ellipsis
    assert.ok(rec.taskPreview.endsWith("…"));
    assert.equal(rec.taskText, undefined);
  });

  it("collapses whitespace in the preview and omits it when there is no task text", () => {
    const job = trackedJobs.createJobRecord(workspace, "review", { model: "p/m" });
    const rec = jobs().find((j) => j.id === job.id);
    assert.equal(rec.taskPreview, undefined);
    assert.equal(rec.requestedModel, "p/m");
    assert.equal(trackedJobs.readJobRequest(workspace, job.id), null); // no request file

    const job2 = trackedJobs.createJobRecord(workspace, "task", { taskText: "  fix\n  the   build " });
    const rec2 = jobs().find((j) => j.id === job2.id);
    assert.equal(rec2.taskPreview, "fix the build");
    assert.equal(rec2.requestedModel, undefined);
  });
});

// ------------------------------------------------------------------
// --help / usage
// ------------------------------------------------------------------

describe("CLI usage", () => {
  it("--help lists every subcommand, the task-text sources, and dispatch vs. retrieve", async () => {
    const { code, stdout } = await runCli(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /task text is POSITIONAL/);
    assert.match(stdout, /--task\/--prompt/);
    assert.match(stdout, /--task-file/);
    assert.match(stdout, /DISPATCH vs\. RETRIEVE/);
    for (const sub of ["task", "wait-and-result", "review", "adversarial-review", "status", "result", "cancel", "setup"]) {
      assert.match(stdout, new RegExp(`\\b${sub}\\b`));
    }
  });

  it("no subcommand prints usage instead of 'Unknown subcommand: undefined'", async () => {
    const { code, stdout } = await runCli([]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: opencode-companion <subcommand>/);
  });

  it("an unknown subcommand exits 1 and shows the usage", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown subcommand: frobnicate/);
    assert.match(stderr, /Usage: opencode-companion/);
  });
});

// ------------------------------------------------------------------
// task: task-text sources + fail fast on an empty task
// ------------------------------------------------------------------

describe("task — task text sources and empty-task fail-fast", () => {
  beforeEach(() => resetState());

  it("accepts --task (the exact call that used to run with an EMPTY task)", async () => {
    const { code, stderr } = await runCli(
      ["task", "--background", "--model", "test/model", "--task", "中文任务"],
      { env: { PATH: gitOnlyBin } } // no node ⇒ the worker spawn fails right after the job is recorded
    );
    assert.equal(code, 1);
    assert.match(stderr, /Failed to start the OpenCode worker process/);

    const rec = jobs()[0];
    assert.equal(rec.taskPreview, "中文任务");
    assert.equal(rec.requestedModel, "test/model");
    assert.equal(trackedJobs.readJobRequest(workspace, rec.id).taskText, "中文任务");
  });

  it("accepts a quoted task text that STARTS with -- and records it verbatim", async () => {
    const { code } = await runCli(
      ["task", "--background", "--model", "test/model", "--no-verify 这参数啥意思"],
      { env: { PATH: gitOnlyBin } }
    );
    assert.equal(code, 1); // spawn failed, but the task itself was accepted
    const rec = jobs()[0];
    assert.equal(rec.taskPreview, "--no-verify 这参数啥意思");
    assert.equal(trackedJobs.readJobRequest(workspace, rec.id).taskText, "--no-verify 这参数啥意思");
  });

  it("reads the task from --task-file", async () => {
    const file = path.join(tmpRoot, "task-input.txt");
    fs.writeFileSync(file, "--no-verify 这参数啥意思\n", "utf8");
    const { code } = await runCli(
      ["task", "--background", "--task-file", file],
      { env: { PATH: gitOnlyBin } }
    );
    assert.equal(code, 1);
    assert.equal(jobs()[0].taskPreview, "--no-verify 这参数啥意思");
  });

  it("fails fast on an empty/whitespace-only task and creates NO job", async () => {
    const { code, stderr } = await runCli(["task", "--background", "--model", "p/m", "   "]);
    assert.equal(code, 1);
    assert.match(stderr, /no task text provided/);
    assert.match(stderr, /--task-file/); // tells the user every accepted source
    assert.equal(jobs().length, 0);
  });

  it("fails fast when a declared value option has no value", async () => {
    const { code, stderr } = await runCli(["task", "--model", "--background", "--task", "x"]);
    assert.equal(code, 1);
    assert.match(stderr, /--model expects a value but none was given/);
    assert.equal(jobs().length, 0);
  });
});

// ------------------------------------------------------------------
// wait-and-result: three branches
// ------------------------------------------------------------------

describe("wait-and-result — existing job id vs. task text", () => {
  beforeEach(() => resetState());

  it("waits for an EXISTING job and prints its result (dispatches nothing)", async () => {
    const job = trackedJobs.createJobRecord(workspace, "task", { agent: "build", taskText: "old task" });
    state.upsertJob(workspace, { id: job.id, status: "completed", completedAt: new Date().toISOString() });
    const dataFile = state.jobDataPath(workspace, job.id);
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify({ rendered: "RECOVERED_RESULT_TEXT" }), "utf8");

    const { code, stdout, stderr } = await runCli(["wait-and-result", job.id]);
    assert.equal(code, 0);
    assert.match(stdout, /RECOVERED_RESULT_TEXT/);
    assert.match(stderr, /waiting for EXISTING job/);
    assert.equal(jobs().length, 1); // no new job was created
  });

  it("errors on a job id that is not in state and never dispatches it as a task", async () => {
    const { code, stderr } = await runCli(["wait-and-result", "task-mrkyzulu-fy4ojt"]);
    assert.equal(code, 1);
    assert.match(stderr, /No such job: task-mrkyzulu-fy4ojt/);
    assert.match(stderr, /did you mean `result task-mrkyzulu-fy4ojt`/i);
    assert.match(stderr, /Refusing to dispatch a job id as task text/);
    assert.equal(jobs().length, 0);
  });

  it("dispatches a NEW job for real task text and says so on stderr", async () => {
    const { code, stderr } = await runCli(
      ["wait-and-result", "--model", "test/model", "重构 X 模块并补测试"],
      { env: { PATH: gitOnlyBin } } // no node ⇒ the worker spawn fails fast
    );
    assert.match(stderr, /dispatching a NEW job/);
    assert.equal(code, 1);
    assert.match(stderr, /Failed to start the OpenCode worker process/);

    const rec = jobs()[0];
    assert.equal(rec.taskPreview, "重构 X 模块并补测试");
    assert.equal(rec.requestedModel, "test/model");
  });
});

// ------------------------------------------------------------------
// status <job-id> --wait
// ------------------------------------------------------------------

describe("status --wait", () => {
  beforeEach(() => resetState());

  it("waits for an existing job and reports it when terminal", async () => {
    const job = trackedJobs.createJobRecord(workspace, "task", { agent: "build", taskText: "old task" });
    state.upsertJob(workspace, { id: job.id, status: "completed", completedAt: new Date().toISOString() });

    const { code, stdout } = await runCli(["status", job.id, "--wait"]);
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(job.id));
    assert.match(stdout, /result /); // points at the retrieval command
  });

  it("refuses to guess which job to wait for when no id is given", async () => {
    const { code, stderr } = await runCli(["status", "--wait"]);
    assert.equal(code, 1);
    assert.match(stderr, /`status --wait` requires a job id/);
  });

  it("errors on an unknown job id", async () => {
    const { code, stderr } = await runCli(["status", "task-mrkyzulu-fy4ojt"]);
    assert.equal(code, 1);
    assert.match(stderr, /No such job/);
  });
});

// ------------------------------------------------------------------
// task-worker: job-record transport + never dying silently
// ------------------------------------------------------------------

describe("task-worker — reads the job request, never dies silently", () => {
  beforeEach(() => resetState());

  it("gets a task text starting with -- from the job record (argv carries only the job id)", async () => {
    const job = trackedJobs.createJobRecord(workspace, "task", {
      agent: "build", model: "test/model", write: true, taskText: "--task 中文任务",
    });

    const { code } = await runCli(
      ["task-worker", "--job-id", job.id, "--workspace", workspace],
      { env: { PATH: "/nonexistent" } } // no `opencode` binary ⇒ connect() fails fast
    );

    assert.equal(code, 1); // it fails at connect, NOT at argument parsing
    const rec = jobs().find((j) => j.id === job.id);
    // The whole point: the "--"-prefixed text reached the worker intact.
    assert.equal(rec.taskPreview, "--task 中文任务");
    assert.equal(rec.requestedModel, "test/model");
    assert.equal(rec.status, "failed");
    assert.doesNotMatch(rec.errorMessage ?? "", /empty task text/);
    // It logged before dying, so the reconciler never has to invent a reason.
    assert.ok(fs.existsSync(state.jobLogPath(workspace, job.id)));
  });

  it("fails an empty task with a log line and an explicit errorMessage (not a silent death)", async () => {
    const job = trackedJobs.createJobRecord(workspace, "task", { agent: "build" }); // no task text
    const { code, stderr } = await runCli(
      ["task-worker", "--job-id", job.id, "--workspace", workspace],
      { env: { PATH: "/nonexistent" } }
    );

    assert.equal(code, 1);
    assert.match(stderr, /task-worker startup aborted: empty task text — nothing to dispatch/);

    const rec = jobs().find((j) => j.id === job.id);
    assert.equal(rec.status, "failed");
    assert.equal(rec.errorMessage, "empty task text — nothing to dispatch");

    const log = fs.readFileSync(state.jobLogPath(workspace, job.id), "utf8");
    assert.match(log, /empty task text — nothing to dispatch/);
  });

  it("reports missing required args instead of exiting silently", async () => {
    const { code, stderr } = await runCli(
      ["task-worker", "--workspace", workspace],
      { env: { PATH: "/nonexistent" } }
    );
    assert.equal(code, 1);
    assert.match(stderr, /missing --job-id/);
  });

  it("still accepts the legacy --task-text transport", async () => {
    const job = trackedJobs.createJobRecord(workspace, "task", { agent: "build" });
    const { code } = await runCli(
      ["task-worker", "--job-id", job.id, "--workspace", workspace, "--task-text", "legacy task text"],
      { env: { PATH: "/nonexistent" } }
    );
    assert.equal(code, 1); // fails at connect, not at parsing
    const rec = jobs().find((j) => j.id === job.id);
    assert.equal(rec.taskPreview, "legacy task text");
    assert.doesNotMatch(rec.errorMessage ?? "", /empty task text/);
  });
});

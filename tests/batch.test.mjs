// `batch` — dispatch N tasks in ONE call.
//
// Fanning out used to cost the caller N `task --background` calls, then repeated
// `status` polls, then N `result` calls. Every one of those tool round-trips is
// itself context the caller re-reads on every later turn. `batch` is one call in,
// one compact summary out — and each item is still an ordinary tracked job, so
// status/result/cancel keep working on it individually.
//
// The two hard-won semantics copied from the sibling MCP frontend's
// oc_delegate_batch are asserted here: pre-warm the server exactly ONCE before
// fanning out (cold-start race), and never let one task's failure take down its
// siblings.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../plugins/opencode/scripts/opencode-companion.mjs", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("../plugins/opencode", import.meta.url));
const DEAD_PORT = "45998"; // nothing listens here

let tmpRoot;
let dataDir;
let workspace;
let gitOnlyBin;

before(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-batch-test-")));
  dataDir = path.join(tmpRoot, "data");
  workspace = path.join(tmpRoot, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  process.env.OPENCODE_COMPANION_DATA = dataDir;
  process.env.OPENCODE_COMPANION_SESSION_ID = "test-session-batch";

  gitOnlyBin = path.join(tmpRoot, "bin");
  fs.mkdirSync(gitOnlyBin, { recursive: true });
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  if (gitPath) fs.symlinkSync(gitPath, path.join(gitOnlyBin, "git"));
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Imported AFTER the env is set: state.mjs keys off OPENCODE_COMPANION_DATA.
const { parseBatchArgv, handleBatch, formatBatchSummary } =
  await import("../plugins/opencode/scripts/opencode-companion.mjs");
const state = await import("../plugins/opencode/scripts/lib/state.mjs");
const trackedJobs = await import("../plugins/opencode/scripts/lib/tracked-jobs.mjs");

const jobs = () => state.loadState(workspace).jobs ?? [];
function resetState() {
  try { fs.rmSync(state.stateRoot(workspace), { recursive: true, force: true }); } catch { /* nothing there */ }
}

// A worker spawn that "succeeds": handleBatch only needs a live pid.
const okSpawn = () => ({ pid: process.pid });
const completed = (id) => ({ id, status: "completed", result: "" });

/** Default deps: server warm, spawns succeed, every job completes. */
function fakeDeps(over = {}) {
  return {
    workspace,
    ensureServer: async () => ({ url: "http://x", alreadyRunning: true }),
    spawnDetached: okSpawn,
    waitForTerminalJob: async (_ws, id) => completed(id),
    readResult: (_ws, id) => ({ rendered: `RESULT for ${id}`, usage: null }),
    ...over,
  };
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
// The grammar
// ------------------------------------------------------------------

describe("parseBatchArgv — fan-out form (same question, N models)", () => {
  it("turns one shared task + N --model into N items", () => {
    const { items, errors } = parseBatchArgv([
      "--model", "prov-a/m1",
      "--model", "prov-b/m2",
      "--model", "prov-c/m3",
      "--model", "prov-d/m4",
      "为什么这个测试会偶发失败?",
    ]);
    assert.deepEqual(errors, []);
    assert.equal(items.length, 4);
    assert.deepEqual(items.map((i) => i.model), ["prov-a/m1", "prov-b/m2", "prov-c/m3", "prov-d/m4"]);
    // Same question, verbatim, to every model.
    assert.ok(items.every((i) => i.taskText === "为什么这个测试会偶发失败?"));
    // The label defaults to the model, which is exactly what distinguishes the
    // four answers in the summary.
    assert.deepEqual(items.map((i) => i.label), ["prov-a/m1", "prov-b/m2", "prov-c/m3", "prov-d/m4"]);
  });

  it("works with no --model at all (a single provider-default item)", () => {
    const { items, errors } = parseBatchArgv(["调查这个 bug"]);
    assert.deepEqual(errors, []);
    assert.equal(items.length, 1);
    assert.equal(items[0].model, undefined);
    assert.equal(items[0].label, "task 1");
  });

  it("applies global flags to every fan-out item", () => {
    const { items } = parseBatchArgv([
      "--agent", "plan", "--max-words", "200",
      "--model", "p/a", "--model", "p/b",
      "审计这段代码",
    ]);
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.agent === "plan" && i.write === false));
    assert.ok(items.every((i) => i.maxWords === 200));
  });
});

describe("parseBatchArgv — explicit items (different tasks)", () => {
  it("gives each --task its own flags", () => {
    const { items, errors } = parseBatchArgv([
      "--task", "审计 auth 模块", "--model", "p/a", "--label", "auth",
      "--task", "审计 billing 模块", "--model", "p/b", "--agent", "plan",
    ]);
    assert.deepEqual(errors, []);
    assert.equal(items.length, 2);

    assert.equal(items[0].taskText, "审计 auth 模块");
    assert.equal(items[0].model, "p/a");
    assert.equal(items[0].label, "auth");
    assert.equal(items[0].agent, "build");
    assert.equal(items[0].write, true);

    assert.equal(items[1].taskText, "审计 billing 模块");
    assert.equal(items[1].model, "p/b");
    assert.equal(items[1].agent, "plan");
    assert.equal(items[1].write, false);
    assert.equal(items[1].label, "p/b"); // no --label ⇒ the model names it
  });

  it("inherits pre-item flags as defaults, and lets an item override them", () => {
    const { items } = parseBatchArgv([
      "--agent", "plan", "--worktree",
      "--task", "A",
      "--task", "B", "--agent", "build",
    ]);
    assert.equal(items[0].agent, "plan");
    assert.equal(items[0].worktree, true);
    assert.equal(items[1].agent, "build");
    assert.equal(items[1].worktree, true);
  });

  it("concatenates a --task value with trailing bare words instead of dropping either", () => {
    const { items } = parseBatchArgv(["--task", "fix X", "and", "also", "Y"]);
    assert.equal(items.length, 1);
    assert.equal(items[0].taskText, "fix X and also Y");
  });

  it("keeps an undeclared --flag inside an item's task text (verbatim forwarding)", () => {
    const { items, errors } = parseBatchArgv(["--task", "run it", "with", "--no-verify", "set"]);
    assert.deepEqual(errors, []);
    assert.equal(items[0].taskText, "run it with --no-verify set");
  });

  it("reads items from --file (JSON array or { tasks: [...] })", () => {
    const doc = JSON.stringify({
      tasks: [
        { task: "T1", model: "p/a", label: "one", maxWords: 80 },
        { task: "T2", agent: "plan", brief: false },
      ],
    });
    const { items, errors } = parseBatchArgv(["--file", "tasks.json"], { readFile: () => doc });
    assert.deepEqual(errors, []);
    assert.equal(items.length, 2);
    assert.equal(items[0].label, "one");
    assert.equal(items[0].maxWords, 80);
    assert.equal(items[1].agent, "plan");
    assert.equal(items[1].brief, false);      // JSON brief:false is a real opt-out
    assert.equal(items[1].maxWords, undefined);
  });
});

describe("parseBatchArgv — the output budget", () => {
  it("leaves brief unset by default, so the ONE default lives in prompts.mjs", () => {
    const { items } = parseBatchArgv(["--model", "p/a", "task"]);
    assert.equal(items[0].brief, undefined);
    assert.equal(items[0].maxWords, undefined);
  });

  it("passes --no-brief / --max-words through", () => {
    const { items } = parseBatchArgv(["--no-brief", "--model", "p/a", "写一份完整报告"]);
    assert.equal(items[0].brief, false);

    const capped = parseBatchArgv(["--max-words", "120", "--model", "p/a", "t"]).items[0];
    assert.equal(capped.maxWords, 120);
  });

  it("lets an item's budget flag override the global one wholesale", () => {
    const { items } = parseBatchArgv([
      "--no-brief",
      "--task", "long one",
      "--task", "short one", "--brief", "--max-words", "80",
    ]);
    assert.equal(items[0].brief, false);              // inherits the global opt-out
    assert.equal(items[1].brief, true);               // its own --brief wins
    assert.equal(items[1].maxWords, 80);
  });
});

describe("parseBatchArgv — fatal argument errors (never dispatch a malformed batch)", () => {
  it("rejects an empty invocation", () => {
    const { errors } = parseBatchArgv([]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no tasks given/);
  });

  it("refuses to silently drop stray text sitting before the first --task", () => {
    const { errors } = parseBatchArgv(["这句话会被吞掉", "--task", "A"]);
    assert.match(errors.join(), /stray task text/);
  });

  it("rejects the ambiguous mix of a fan-out model list and explicit --task items", () => {
    const { errors } = parseBatchArgv(["--model", "p/a", "--model", "p/b", "--task", "A"]);
    assert.match(errors.join(), /several --model flags were given before the first --task/);
  });

  it("rejects a value option with no value, and a bad --agent", () => {
    assert.match(parseBatchArgv(["--task", "A", "--model"]).errors.join(), /--model expects a value/);
    assert.match(parseBatchArgv(["--task", "A", "--agent", "wat"]).errors.join(), /--agent must be build or plan/);
  });

  it("reports an unreadable --file instead of dispatching nothing silently", () => {
    const { errors } = parseBatchArgv(["--file", "nope.json"], {
      readFile: () => { throw new Error("ENOENT"); },
    });
    assert.match(errors.join(), /could not read --file nope\.json/);
  });
});

// ------------------------------------------------------------------
// The fan-out
// ------------------------------------------------------------------

describe("handleBatch — dispatch", () => {
  beforeEach(() => resetState());

  it("dispatches ONE job per model and returns every result in one summary", async () => {
    const res = await handleBatch(
      ["--model", "p/a", "--model", "p/b", "--model", "p/c", "--model", "p/d", "同一道题"],
      fakeDeps()
    );

    assert.equal(res.total, 4);
    assert.equal(res.okCount, 4);
    assert.equal(jobs().length, 4, "each task is its own tracked job");
    assert.ok(jobs().every((j) => j.type === "task"));
    // Every model got the SAME question…
    assert.ok(jobs().every((j) => j.taskPreview === "同一道题"));
    // …and the four answers are individually addressable afterwards.
    assert.deepEqual(jobs().map((j) => j.requestedModel).sort(), ["p/a", "p/b", "p/c", "p/d"]);

    assert.match(res.summary, /Batch: 4\/4 succeeded/);
    for (const m of ["p/a", "p/b", "p/c", "p/d"]) {
      assert.ok(res.summary.includes(m), `${m} is labelled in the summary`);
    }
  });

  it("warms the OpenCode server exactly ONCE, before any worker is spawned", async () => {
    const order = [];
    await handleBatch(
      ["--model", "p/a", "--model", "p/b", "--model", "p/c", "t"],
      fakeDeps({
        ensureServer: async () => { order.push("warm"); return {}; },
        spawnDetached: () => { order.push("spawn"); return okSpawn(); },
      })
    );
    // Otherwise 3 workers race to spawn `opencode serve` on the same port and
    // every loser dies with an earlyExit error.
    assert.deepEqual(order, ["warm", "spawn", "spawn", "spawn"]);
  });

  it("still fans out when the pre-warm fails (each worker reports its own error)", async () => {
    const res = await handleBatch(
      ["--model", "p/a", "--model", "p/b", "t"],
      fakeDeps({ ensureServer: async () => { throw new Error("cannot start"); } })
    );
    assert.equal(res.okCount, 2, "a failed pre-warm must not abort the batch");
  });

  it("carries the output budget into each job's REQUEST FILE (the worker reads it there)", async () => {
    await handleBatch(["--max-words", "150", "--model", "p/a", "--model", "p/b", "t"], fakeDeps());
    for (const j of jobs()) {
      const req = trackedJobs.readJobRequest(workspace, j.id);
      assert.equal(req.maxWords, 150, "a detached worker gets its budget from the request file");
      assert.equal(req.taskText, "t");
    }
  });

  it("records brief:false so an opted-out batch really runs long", async () => {
    await handleBatch(["--no-brief", "--model", "p/a", "写完整报告"], fakeDeps());
    assert.equal(trackedJobs.readJobRequest(workspace, jobs()[0].id).brief, false);
  });

  it("throws on a malformed batch WITHOUT creating any job", async () => {
    await assert.rejects(
      () => handleBatch(["--model", "p/a", "--model", "p/b", "--task", "A"], fakeDeps()),
      /several --model flags/
    );
    assert.equal(jobs().length, 0);
  });
});

describe("handleBatch — partial failure (a sibling's death is not the batch's)", () => {
  beforeEach(() => resetState());

  it("returns the tasks that SUCCEEDED and names the ones that did not", async () => {
    let n = 0;
    const res = await handleBatch(
      ["--model", "p/a", "--model", "p/b", "--model", "p/c", "t"],
      fakeDeps({
        waitForTerminalJob: async (_ws, id) => {
          n++;
          if (n === 2) return { id, status: "failed", errorMessage: "model refused the turn" };
          return completed(id);
        },
      })
    );

    assert.equal(res.okCount, 2);
    assert.equal(res.total, 3);
    assert.match(res.summary, /Batch: 2\/3 succeeded · 1 failed/);
    assert.match(res.summary, /— FAILED\n model refused the turn|— FAILED\nmodel refused the turn/);
    assert.match(res.summary, /^Failed: .*p\/b/m);
    // The two good answers are still fully there — that is the whole point.
    assert.equal((res.summary.match(/RESULT for/g) ?? []).length, 2);
  });

  it("keeps dispatching after a worker spawn fails, and marks that job failed", async () => {
    let n = 0;
    const res = await handleBatch(
      ["--model", "p/a", "--model", "p/b", "--model", "p/c", "t"],
      fakeDeps({
        spawnDetached: () => (++n === 1 ? {} : okSpawn()), // first spawn returns no pid
      })
    );

    assert.equal(res.total, 3, "the other two were still dispatched");
    assert.equal(res.okCount, 2);
    assert.match(res.summary, /Failed to start the OpenCode worker process/);

    const failed = jobs().filter((j) => j.status === "failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0].errorMessage, /Failed to start the OpenCode worker/);
  });

  it("reports a timed-out task as recoverable rather than losing it", async () => {
    const res = await handleBatch(
      ["--model", "p/a", "--model", "p/b", "t"],
      fakeDeps({
        waitForTerminalJob: async (_ws, id, _t) => (id.endsWith("x") ? completed(id) : null),
        // null ⇒ still running when the wait budget ran out
      })
    );
    assert.equal(res.okCount, 0);
    assert.match(res.summary, /TIMEOUT/);
    assert.match(res.summary, /retrieve later with: result task-/);
  });

  it("survives a sibling blowing up mid-collection (Promise.all must not eat the good results)", async () => {
    let n = 0;
    const res = await handleBatch(
      ["--model", "p/a", "--model", "p/b", "t"],
      fakeDeps({
        waitForTerminalJob: async (_ws, id) => {
          if (++n === 1) throw new Error("state read exploded");
          return completed(id);
        },
      })
    );
    assert.equal(res.okCount, 1);
    assert.match(res.summary, /state read exploded/);
    assert.match(res.summary, /RESULT for/);
  });
});

// ------------------------------------------------------------------
// The summary
// ------------------------------------------------------------------

describe("formatBatchSummary — compact by construction", () => {
  it("is one section per task: label + result + a SINGLE trailer line", () => {
    const out = formatBatchSummary([
      {
        label: "p/a", jobId: "task-a-1", status: "completed", rendered: "答案 A",
        usage: { output: 1234, model: "p/a" }, requestedModel: "p/a", sessionId: "ses_1",
      },
      {
        label: "p/b", jobId: "task-b-2", status: "completed", rendered: "答案 B",
        usage: null, requestedModel: "p/b", sessionId: "ses_2",
      },
    ]);

    assert.match(out, /^Batch: 2\/2 succeeded$/m);
    assert.match(out, /### \[1\] p\/a · task-a-1/);
    assert.match(out, /### \[2\] p\/b · task-b-2/);
    assert.ok(out.includes("答案 A") && out.includes("答案 B"));

    // The trailer must stay ONE line per task — N results must not become N
    // multi-line token dumps in the caller's context.
    const trailerLines = out.split("\n").filter((l) => l.startsWith("✓") || l.startsWith("⚠️"));
    assert.ok(trailerLines.length <= 2, `expected ≤1 trailer line per task, got ${trailerLines.length}`);
  });

  it("names every failure at the end, with the job id needed to chase it", () => {
    const out = formatBatchSummary([
      { label: "p/a", jobId: "task-a-1", status: "completed", rendered: "ok" },
      { label: "p/b", jobId: "task-b-2", status: "failed", error: "boom" },
      { label: "p/c", jobId: "task-c-3", status: "timeout", error: "still running" },
    ]);
    assert.match(out, /Batch: 1\/3 succeeded · 2 failed/);
    assert.match(out, /### \[2\] p\/b · task-b-2 — FAILED\nboom/);
    assert.match(out, /### \[3\] p\/c · task-c-3 — TIMEOUT\nstill running/);
    assert.match(out, /Failed: p\/b \(task-b-2\), p\/c \(task-c-3\)/);
    assert.match(out, /status <job id>/);
  });

  it("does not choke on a completed task that returned nothing", () => {
    const out = formatBatchSummary([{ label: "p/a", jobId: "task-a-1", status: "completed", rendered: "" }]);
    assert.match(out, /\(task completed with no output\)/);
  });
});

// ------------------------------------------------------------------
// End to end through the real CLI
// ------------------------------------------------------------------

describe("CLI", () => {
  beforeEach(() => resetState());

  it("lists batch and the output-budget flags in --help", async () => {
    const { code, stdout } = await runCli(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /\bbatch\b/);
    assert.match(stdout, /--no-brief \| --full/);
    assert.match(stdout, /--max-words <N>/);
    assert.match(stdout, /--watch is a LIVE PANEL/);
    assert.match(stdout, /ZERO\s+Claude tokens/);
  });

  it("persists --max-words / --no-brief into the request file of a backgrounded task", async () => {
    const { code } = await runCli(
      ["task", "--background", "--model", "test/model", "--max-words", "120", "--task", "查一下"],
      { env: { PATH: gitOnlyBin } } // no node on PATH ⇒ the worker spawn fails right after the record is written
    );
    assert.equal(code, 1);

    const rec = jobs()[0];
    const req = trackedJobs.readJobRequest(workspace, rec.id);
    assert.equal(req.maxWords, 120);
    assert.equal(req.taskText, "查一下");
    assert.equal(req.brief, undefined, "unset means 'caller said nothing' — the default lives in prompts.mjs");

    resetState();
    await runCli(
      ["task", "--background", "--no-brief", "--task", "写完整报告"],
      { env: { PATH: gitOnlyBin } }
    );
    assert.equal(trackedJobs.readJobRequest(workspace, jobs()[0].id).brief, false);
  });

  it("rejects a malformed batch with a usable error and dispatches nothing", async () => {
    const { code, stderr } = await runCli(["batch", "--model", "p/a", "--model", "p/b", "--task", "A"]);
    assert.equal(code, 1);
    assert.match(stderr, /Invalid arguments for `batch`/);
    assert.match(stderr, /several --model flags/);
    assert.equal(jobs().length, 0);
  });
});

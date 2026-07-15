import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  cancelJobsAndCleanup,
  handleBatch,
} from "../plugins/opencode/scripts/opencode-companion.mjs";
import { upsertJob, loadState } from "../plugins/opencode/scripts/lib/state.mjs";
import { pidStartTime } from "../plugins/opencode/scripts/lib/fs.mjs";

// A UNIQUE workspace per test keeps each one's state in its own hash dir — the
// same isolation job-heal uses, without touching the global env.
function ws() {
  return `/tmp/ocfgtest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
// A real DETACHED child (its own process group, like the plugin's worker) that
// stays alive until signalled — so we exercise the real process.kill(-pid) path.
function spawnFakeWorker() {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    detached: true, stdio: "ignore",
  });
  c.unref();
  return c;
}
const reap = (pid) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };

describe("cancelJobsAndCleanup — the x / Ctrl-C cascade", () => {
  it("kills the detached worker, aborts its session, and marks the job canceled", async () => {
    const w = ws();
    const child = spawnFakeWorker();
    await sleep(120); // let /proc/<pid>/stat be readable for the start-time fingerprint
    const abortCalls = [];
    const client = { abortSession: async (id) => { abortCalls.push(id); } };
    upsertJob(w, {
      id: "task-fg-1", type: "task", status: "running",
      pid: child.pid, pidStart: pidStartTime(child.pid), detachedWorker: true,
      opencodeSessionId: "ses_fake_1",
    });

    const res = await cancelJobsAndCleanup(w, ["task-fg-1"], { client, killGraceMs: 1500 });

    assert.deepEqual(res.canceled, ["task-fg-1"]);
    assert.deepEqual(abortCalls, ["ses_fake_1"], "the server session was aborted");
    await sleep(250);
    assert.equal(alive(child.pid), false, "the detached worker process was actually killed");
    assert.equal(loadState(w).jobs.find((j) => j.id === "task-fg-1").status, "canceled");
    reap(child.pid);
  });

  it("is idempotent — a second call does not re-abort or re-kill", async () => {
    const w = ws();
    const child = spawnFakeWorker();
    await sleep(120);
    const abortCalls = [];
    const client = { abortSession: async (id) => { abortCalls.push(id); } };
    upsertJob(w, {
      id: "task-fg-2", type: "task", status: "running",
      pid: child.pid, pidStart: pidStartTime(child.pid), detachedWorker: true,
      opencodeSessionId: "ses_fake_2",
    });

    const res1 = await cancelJobsAndCleanup(w, ["task-fg-2"], { client, killGraceMs: 1500 });
    assert.deepEqual(res1.canceled, ["task-fg-2"]);
    assert.equal(abortCalls.length, 1);
    await sleep(150);

    const res2 = await cancelJobsAndCleanup(w, ["task-fg-2"], { client });
    assert.deepEqual(res2.canceled, [], "nothing left to cancel");
    assert.deepEqual(res2.alreadyDone, ["task-fg-2 (canceled)"]);
    assert.equal(abortCalls.length, 1, "no second abort of an already-terminal job");
    reap(child.pid);
  });

  it("only touches the ids it is given — a sibling job is left running", async () => {
    const w = ws();
    const a = spawnFakeWorker();
    const b = spawnFakeWorker();
    await sleep(120);
    const client = { abortSession: async () => {} };
    upsertJob(w, {
      id: "task-fg-a", type: "task", status: "running",
      pid: a.pid, pidStart: pidStartTime(a.pid), detachedWorker: true, opencodeSessionId: "ses_a",
    });
    upsertJob(w, {
      id: "task-fg-b", type: "task", status: "running",
      pid: b.pid, pidStart: pidStartTime(b.pid), detachedWorker: true, opencodeSessionId: "ses_b",
    });

    await cancelJobsAndCleanup(w, ["task-fg-a"], { client, killGraceMs: 1500 });
    await sleep(250);

    assert.equal(alive(a.pid), false, "the targeted worker was killed");
    assert.equal(alive(b.pid), true, "the sibling worker is untouched");
    assert.equal(loadState(w).jobs.find((j) => j.id === "task-fg-b").status, "running");
    reap(a.pid); reap(b.pid);
  });
});

describe("batch — onDispatched feeds the foreground cancel handler", () => {
  it("reports every spawned job id and its workspace before blocking", async () => {
    const w = ws();
    const seen = [];
    let n = 0;
    await handleBatch(
      ["--model", "prov/model-a", "--model", "prov/model-b", "do the thing"],
      {
        workspace: w,
        ensureServer: async () => ({}),
        spawnDetached: () => ({ pid: 900000 + n++ }), // fake, never a real process
        waitForTerminalJob: async (ws2, id) => ({ id, status: "completed", result: "ok" }),
        readResult: () => ({ rendered: "ok", usage: {} }),
        onDispatched: (dispatchedWs, ids) => seen.push({ ws: dispatchedWs, ids }),
      }
    );

    assert.equal(seen.length, 1, "onDispatched fired exactly once, before the blocking wait");
    assert.equal(seen[0].ws, w);
    assert.ok(seen[0].ids.length >= 2, `expected >=2 dispatched ids, got ${seen[0].ids.length}`);
    assert.ok(seen[0].ids.every((id) => typeof id === "string" && id.startsWith("task-")));
  });

  it("arms the cancel handler BEFORE spawning — a mid-loop signal covers early workers", async () => {
    const w = ws();
    const order = [];
    let armedIds = null;
    await handleBatch(
      ["--model", "prov/model-a", "--model", "prov/model-b", "do the thing"],
      {
        workspace: w,
        ensureServer: async () => ({}),
        spawnDetached: () => { order.push("spawn"); return { pid: 900000 + order.length }; },
        waitForTerminalJob: async (ws2, id) => ({ id, status: "completed", result: "ok" }),
        readResult: () => ({ rendered: "ok", usage: {} }),
        onDispatched: (ws2, ids) => { order.push("armed"); armedIds = ids; },
      }
    );
    // The handler must be installed over the id list BEFORE the first worker is
    // spawned, or a SIGTERM mid-fan-out orphans the workers already running.
    assert.equal(order[0], "armed", `cancel handler armed after spawning; order: ${order.join(",")}`);
    // The armed list is the LIVE array — it fills as each worker spawns.
    assert.ok(armedIds.length >= 2, "the armed id list grew as workers spawned");
  });
});

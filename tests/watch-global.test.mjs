// `watch` — the live panel across EVERY workspace.
//
// Job state is stored per workspace (a hashed path), so `status --watch` can only
// ever show the repo you happen to be standing in: a delegation dispatched from
// another repo was simply, silently absent. `watch` aggregates them all and tags
// each row with the repo it came from.
//
// Two properties are load-bearing and are tested as such:
//   1. it is READ-ONLY (a background delegation is writing these same files while
//      the panel reads them — a panel must not mutate what it observes, and must
//      not probe the server on the repaint clock);
//   2. ONE corrupt state.json must not blank the whole board.
//
// Everything runs against a temp OPENCODE_COMPANION_DATA, never the real data dir.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { stateRoot, listWorkspaceStates, upsertJob } from "../plugins/opencode/scripts/lib/state.mjs";
import {
  collectAggregateStatus,
  renderAggregateStatus,
  labelWorkspaces,
} from "../plugins/opencode/scripts/opencode-companion.mjs";

let dataDir;
let prevData;

beforeEach(() => {
  dataDir = createTmpDir("occ-watch");
  prevData = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = dataDir;
});

afterEach(() => {
  if (prevData === undefined) delete process.env.OPENCODE_COMPANION_DATA;
  else process.env.OPENCODE_COMPANION_DATA = prevData;
  cleanupTmpDir(dataDir);
});

/** Seed a workspace with jobs, through the real state writer (so it is stamped). */
function seed(workspace, jobs) {
  for (const j of jobs) upsertJob(workspace, j);
  return workspace;
}

const base = () => path.join(dataDir, "state");

describe("listWorkspaceStates", () => {
  it("finds every workspace and remembers which repo each hashed dir IS", () => {
    seed("/repos/alpha", [{ id: "task-a-1", type: "task", status: "running" }]);
    seed("/repos/beta", [{ id: "task-b-1", type: "task", status: "completed" }]);

    const groups = listWorkspaceStates({ base: base() });
    assert.equal(groups.length, 2);

    const alpha = groups.find((g) => g.workspace === "/repos/alpha");
    assert.ok(alpha, "the workspace PATH must be recoverable — the dir name is a one-way hash");
    assert.equal(alpha.jobs.length, 1);
    assert.equal(alpha.jobs[0].id, "task-a-1");
  });

  it("returns nothing (not an error) when no delegation has ever run", () => {
    assert.deepEqual(listWorkspaceStates({ base: path.join(dataDir, "nope") }), []);
  });

  it("SKIPS a corrupt state.json instead of crashing the panel", () => {
    seed("/repos/good", [{ id: "task-g-1", type: "task", status: "running" }]);

    // A half-written state.json — exactly what a torn write during a repaint looks like.
    const bad = stateRoot("/repos/bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "state.json"), '{"jobs": [{"id": "task-x"');

    const groups = listWorkspaceStates({ base: base() });
    assert.equal(groups.length, 2, "the broken repo is still listed…");

    const broken = groups.find((g) => g.corrupt);
    assert.ok(broken, "…and flagged");
    assert.deepEqual(broken.jobs, [], "…with no jobs, rather than throwing");

    const good = groups.find((g) => g.workspace === "/repos/good");
    assert.equal(good.jobs.length, 1, "the healthy repo still paints");
  });

  it("does NOT flag a workspace whose state.json is merely MISSING as corrupt", () => {
    // A dir that exists but has no state.json yet (freshly created, or state
    // deleted) is empty — not corrupt. readJson returns null for BOTH cases, so
    // `corrupt` must additionally check the file actually exists, or the operator
    // is told a perfectly-fine empty workspace is broken.
    const dir = path.join(base(), "deadbeefdeadbeef");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify({ workspace: "/repos/empty" }));
    // deliberately NO state.json

    const groups = listWorkspaceStates({ base: base() });
    const empty = groups.find((g) => g.workspace === "/repos/empty");
    assert.ok(empty, "the dir is still listed");
    assert.equal(empty.corrupt, false, "a missing state.json is NOT corruption");
    assert.deepEqual(empty.jobs, []);
  });
});

describe("labelWorkspaces", () => {
  it("labels a repo by its directory name, not a screen-flooding absolute path", () => {
    const labels = labelWorkspaces([
      { hash: "h1", workspace: "/home/me/gitprojects/opencode-companion-cc" },
      { hash: "h2", workspace: "/home/me/gitprojects/windowsuse" },
    ]);
    assert.equal(labels.get("h1"), "opencode-companion-cc");
    assert.equal(labels.get("h2"), "windowsuse");
  });

  it("disambiguates two repos that share a basename", () => {
    const labels = labelWorkspaces([
      { hash: "h1", workspace: "/work/alpha/api" },
      { hash: "h2", workspace: "/work/beta/api" },
    ]);
    assert.equal(labels.get("h1"), "alpha/api");
    assert.equal(labels.get("h2"), "beta/api");
  });

  it("falls back to the hash prefix when the path is unknown (a legacy state dir)", () => {
    const labels = labelWorkspaces([{ hash: "abcdef1234567890", workspace: null }]);
    assert.equal(labels.get("abcdef1234567890"), "#abcdef12");
  });
});

describe("collectAggregateStatus", () => {
  it("aggregates jobs from EVERY workspace and tags each with its repo", () => {
    seed("/repos/alpha", [
      { id: "task-a-1", type: "task", status: "running" },
      { id: "task-a-2", type: "task", status: "completed" },
    ]);
    seed("/repos/beta", [{ id: "task-b-1", type: "task", status: "running" }]);

    const snap = collectAggregateStatus({ base: base() });

    assert.equal(snap.running, 2, "both repos' running jobs are on the board");
    assert.match(snap.scope, /all workspaces · 2 repos/);
    assert.match(snap.text, /\[alpha\] \*\*task-a-1\*\*/);
    assert.match(snap.text, /\[beta\] \*\*task-b-1\*\*/);
    assert.match(snap.text, /\[alpha\] \*\*task-a-2\*\*/);
  });

  it("--workspace narrows it back to ONE repo", () => {
    seed("/repos/alpha", [{ id: "task-a-1", type: "task", status: "running" }]);
    seed("/repos/beta", [{ id: "task-b-1", type: "task", status: "running" }]);

    const snap = collectAggregateStatus({ base: base(), only: "/repos/alpha" });

    assert.equal(snap.running, 1);
    assert.equal(snap.scope, "/repos/alpha");
    assert.match(snap.text, /task-a-1/);
    assert.doesNotMatch(snap.text, /task-b-1/);
  });

  it("surfaces a failure from a repo you are not standing in", () => {
    seed("/repos/alpha", [{ id: "task-a-1", type: "task", status: "running" }]);
    seed("/repos/beta", [
      { id: "task-b-9", type: "task", status: "failed", errorMessage: "worker exited without completing" },
    ]);

    const snap = collectAggregateStatus({ base: base() });
    assert.match(snap.text, /## ❌ Failed \(1\)/);
    assert.match(snap.text, /\[beta\] \*\*task-b-9\*\*/);
    assert.match(snap.text, /worker exited without completing/);
  });

  it("does not crash on a corrupt repo — it just paints the rest", () => {
    seed("/repos/good", [{ id: "task-g-1", type: "task", status: "running" }]);
    const bad = stateRoot("/repos/bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "state.json"), "}{ NOT JSON");

    const snap = collectAggregateStatus({ base: base() });
    assert.equal(snap.running, 1);
    assert.match(snap.text, /\[good\] \*\*task-g-1\*\*/);
  });

  it("is READ-ONLY: a repaint must never mutate the state it is observing", () => {
    seed("/repos/alpha", [
      // A job whose worker is long gone. `status` would reconcile this to failed
      // (it writes); the panel must NOT — it is only looking.
      { id: "task-a-1", type: "task", status: "running", pid: 999999, pidStart: "1" },
    ]);

    const file = path.join(stateRoot("/repos/alpha"), "state.json");
    const before = fs.readFileSync(file, "utf8");
    const mtimeBefore = fs.statSync(file).mtimeMs;

    collectAggregateStatus({ base: base() });
    collectAggregateStatus({ base: base() });

    assert.equal(fs.readFileSync(file, "utf8"), before, "state.json must be byte-identical after a repaint");
    assert.equal(fs.statSync(file).mtimeMs, mtimeBefore);
  });

  it("says so plainly when there is nothing anywhere", () => {
    const snap = collectAggregateStatus({ base: base() });
    assert.equal(snap.running, 0);
    assert.match(snap.text, /No jobs in any workspace yet/);
  });
});

describe("renderAggregateStatus", () => {
  it("shows the repo, the live token count and the activity trail on a running row", () => {
    const text = renderAggregateStatus({
      running: [{
        id: "task-x-1", type: "task", status: "running", repo: "windowsuse",
        phase: "investigating", elapsed: "2m 10s",
        progressPreview: [
          "[2026-07-15T04:00:00Z] heartbeat: 14,203 tokens",
          "[2026-07-15T04:00:01Z] activity: bash: npm test",
        ].join("\n"),
      }],
      recent: [],
    });

    assert.match(text, /\[windowsuse\] \*\*task-x-1\*\*/);
    assert.match(text, /14,203 OpenCode tokens/);
    assert.match(text, /↳ bash: npm test/);
  });

  it("never prints a long absolute path in a row (that is what floods the panel)", () => {
    const text = renderAggregateStatus({
      running: [{ id: "task-x-1", type: "task", status: "running", repo: "alpha" }],
      recent: [{ id: "task-y-1", type: "task", status: "completed", repo: "beta" }],
    });
    assert.doesNotMatch(text, /\/home\/|\/repos\//);
  });
});

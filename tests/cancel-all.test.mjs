import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveCancelableJobs } from "../plugins/opencode/scripts/lib/job-control.mjs";

const J = (id, status, sessionId) => ({ id, status, sessionId, type: "task" });

describe("resolveCancelableJobs — cancel-all (session-scoped)", () => {
  const jobs = [
    J("task-a", "running", "S1"),
    J("task-b", "pending", "S1"),
    J("task-c", "running", "S2"), // another session — must NOT be touched
    J("task-d", "completed", "S1"), // terminal — not cancelable
    J("task-e", "running", undefined),
  ];

  it("no ref ⇒ returns ALL running/pending jobs for THIS session only", () => {
    const { jobs: targets, ambiguous } = resolveCancelableJobs(jobs, undefined, { sessionId: "S1" });
    assert.equal(ambiguous, false);
    assert.deepEqual(targets.map((j) => j.id).sort(), ["task-a", "task-b"]);
    // never another session's job, never a terminal one
    assert.ok(!targets.some((j) => j.id === "task-c"), "S2 job excluded");
    assert.ok(!targets.some((j) => j.id === "task-d"), "completed job excluded");
  });

  it("no ref + no sessionId ⇒ all running/pending (best effort)", () => {
    const { jobs: targets } = resolveCancelableJobs(jobs, undefined, {});
    assert.deepEqual(targets.map((j) => j.id).sort(), ["task-a", "task-b", "task-c", "task-e"]);
  });

  it("with a ref ⇒ single matching running job", () => {
    const { jobs: targets, ambiguous } = resolveCancelableJobs(jobs, "task-a", { sessionId: "S1" });
    assert.equal(ambiguous, false);
    assert.deepEqual(targets.map((j) => j.id), ["task-a"]);
  });

  it("with an ambiguous ref ⇒ empty set + ambiguous flag", () => {
    const { jobs: targets, ambiguous } = resolveCancelableJobs(jobs, "task", { sessionId: "S1" });
    assert.equal(ambiguous, true);
    assert.deepEqual(targets, []);
  });

  it("a ref matching a terminal-only job ⇒ no cancelable job", () => {
    const { jobs: targets, ambiguous } = resolveCancelableJobs(jobs, "task-d", { sessionId: "S1" });
    assert.equal(ambiguous, false);
    assert.deepEqual(targets, []);
  });

  it("no running jobs at all ⇒ empty set", () => {
    const done = [J("task-x", "completed", "S1"), J("task-y", "failed", "S1")];
    const { jobs: targets } = resolveCancelableJobs(done, undefined, { sessionId: "S1" });
    assert.deepEqual(targets, []);
  });
});

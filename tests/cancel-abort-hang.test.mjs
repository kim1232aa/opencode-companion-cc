// cancelJobsAndCleanup must not hang on a wedged server. Codex has the twin
// test (cancel-abort-timeout.test.mjs) for its oc_cancel; CC had the identical
// withTimeout mechanism but no test proving the bound.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODE_COMPANION_DATA = mkdtempSync(join(tmpdir(), "oc-cc-abort-hang-"));
process.env.OPENCODE_SERVER_PORT = "1";

const { cancelJobsAndCleanup } = await import("../plugins/opencode/scripts/opencode-companion.mjs");
const { upsertJob, loadState } = await import("../plugins/opencode/scripts/lib/state.mjs");

function ws() {
  return mkdtempSync(join(tmpdir(), "oc-cc-abort-hang-ws-"));
}

describe("cancelJobsAndCleanup — abort is time-bounded", () => {
  it("returns promptly and still cancels when abortSession never resolves", async () => {
    const w = ws();
    upsertJob(w, { id: "hangA", type: "task", status: "running", opencodeSessionId: "ses_hangA" });

    let abortCalled = false;
    const client = { abortSession: () => { abortCalled = true; return new Promise(() => {}); } };

    const start = Date.now();
    await cancelJobsAndCleanup(w, ["hangA"], { client, abortTimeoutMs: 50, killGraceMs: 10 });
    const elapsed = Date.now() - start;

    assert.equal(abortCalled, true, "the abort must actually be attempted");
    assert.ok(elapsed < 2000, `must return promptly, not wait out the 300s default (took ${elapsed}ms)`);
    assert.equal(loadState(w).jobs.find((j) => j.id === "hangA").status, "canceled");
  });

  it("still cancels when abortSession rejects (server down)", async () => {
    const w = ws();
    upsertJob(w, { id: "downA", type: "task", status: "running", opencodeSessionId: "ses_downA" });
    const client = { abortSession: () => Promise.reject(new Error("ECONNREFUSED")) };
    await cancelJobsAndCleanup(w, ["downA"], { client, abortTimeoutMs: 50, killGraceMs: 10 });
    assert.equal(loadState(w).jobs.find((j) => j.id === "downA").status, "canceled");
  });
});

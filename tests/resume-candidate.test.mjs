// pickResumeCandidate — THE resume selector, shared by `task --resume-last`,
// `wait-and-result --resume-last` and `task-resume-candidate`.
//
// Regression: the selection was copy-pasted three times and only the candidate
// command filtered by status — so `--resume-last` could resume the session of a
// FAILED or CANCELED job that `task-resume-candidate` would never have offered.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pickResumeCandidate } from "../plugins/opencode/scripts/opencode-companion.mjs";

const T = (id, status, sessionId, updatedAt) => ({
  id, type: "task", status, sessionId, opencodeSessionId: `ses_${id}`, updatedAt,
});

describe("pickResumeCandidate", () => {
  it("never offers a failed or canceled job's session (the --resume-last drift)", () => {
    const jobs = [
      T("old-ok", "completed", "S1", "2026-01-01T00:00:00Z"),
      T("newer-failed", "failed", "S1", "2026-01-02T00:00:00Z"),
      T("newest-canceled", "canceled", "S1", "2026-01-03T00:00:00Z"),
    ];
    const r = pickResumeCandidate(jobs, "S1");
    assert.equal(r.opencodeSessionId, "ses_old-ok", "must skip the newer failed/canceled jobs");
  });

  it("prefers the newest completed/running task, scoped to the session", () => {
    const jobs = [
      T("mine", "completed", "S1", "2026-01-01T00:00:00Z"),
      T("theirs", "completed", "S2", "2026-01-05T00:00:00Z"),
      T("mine-newer", "running", "S1", "2026-01-04T00:00:00Z"),
    ];
    assert.equal(pickResumeCandidate(jobs, "S1").opencodeSessionId, "ses_mine-newer");
    // No ambient session id (unset) ⇒ whole-workspace newest.
    assert.equal(pickResumeCandidate(jobs, "").opencodeSessionId, "ses_theirs");
  });

  it("reports unavailable when nothing is resumable", () => {
    const r = pickResumeCandidate([T("f", "failed", "S1", "2026-01-01T00:00:00Z")], "S1");
    assert.equal(r.available, false);
    assert.equal(r.opencodeSessionId, null);
  });
});

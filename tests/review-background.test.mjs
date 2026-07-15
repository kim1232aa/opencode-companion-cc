// review / adversarial-review --background must ACTUALLY detach at the CLI.
//
// The review handlers run foreground (await runTrackedJob), so --background used
// to be parsed and then ignored — only the Claude slash wrapper (Bash
// run_in_background) truly detached it, and a direct occ/node CLI run blocked.
// detachReviewIfBackground re-spawns the command verbatim with an env sentinel
// (so the child does not re-spawn) and returns true; the child then runs the
// review foreground, creates the job, and writes its result.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detachReviewIfBackground } from "../plugins/opencode/scripts/opencode-companion.mjs";

describe("detachReviewIfBackground", () => {
  it("re-spawns the command verbatim with the env sentinel and returns true", () => {
    const calls = [];
    const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 4242 }; };
    const forwardArgv = ["adversarial-review", "--background", "--base", "main", "review the --verbose path"];
    const detached = detachReviewIfBackground({ background: true }, "adversarial review", { spawn, forwardArgv });

    assert.equal(detached, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "node");
    // The script path leads, then the forwarded argv VERBATIM — including a focus
    // that mentions a flag, which must never be corrupted by argv surgery.
    assert.match(calls[0].args[0], /opencode-companion\.mjs$/);
    assert.deepEqual(calls[0].args.slice(1), forwardArgv);
    // Sentinel set so the detached child runs foreground instead of re-spawning.
    assert.equal(calls[0].opts.env.OPENCODE_REVIEW_BG_CHILD, "1");
  });

  it("does nothing when --background is absent", () => {
    let called = false;
    const detached = detachReviewIfBackground({}, "review", { spawn: () => { called = true; return { pid: 1 }; } });
    assert.equal(detached, false);
    assert.equal(called, false);
  });

  it("does nothing inside the detached child (sentinel already set)", () => {
    const saved = process.env.OPENCODE_REVIEW_BG_CHILD;
    process.env.OPENCODE_REVIEW_BG_CHILD = "1";
    try {
      let called = false;
      const detached = detachReviewIfBackground(
        { background: true },
        "review",
        { spawn: () => { called = true; return { pid: 1 }; }, forwardArgv: ["review", "--background"] }
      );
      assert.equal(detached, false, "the child must NOT re-spawn (would be an infinite fork)");
      assert.equal(called, false);
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_REVIEW_BG_CHILD;
      else process.env.OPENCODE_REVIEW_BG_CHILD = saved;
    }
  });
});

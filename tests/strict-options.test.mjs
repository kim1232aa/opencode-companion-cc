// Unknown options on a NO-TASK-TEXT subcommand must fail fast.
//
// The bug, hit for real: `status --watc` (a dropped "h") printed
//   warning: unknown option --watc
//   ## Latest Finished
// …i.e. it warned, coerced the typo to `true`, and then ran a perfectly ordinary
// one-shot `status` and exited 0. The user concluded the live panel was broken.
//
// The OTHER half of this file is the guard rail: `task` / `wait-and-result` must
// STAY lenient, because their command line carries free-form task text in which
// `--no-verify` is a legal word we promise to forward byte-for-byte. Making the
// whole parser strict would "fix" the typo bug by re-breaking that promise —
// which is a bug that was already found and fixed once, and must not come back.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  parseArgs,
  parseTaskArgv,
  didYouMean,
  formatUnknownOptionError,
} from "../plugins/opencode/scripts/lib/args.mjs";

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/opencode/scripts/opencode-companion.mjs"
);

/**
 * Run the real CLI in a throwaway data dir, so a test can never read (or
 * disturb) the jobs of a delegation the user is actually running right now.
 */
function runCli(args, { dataDir }) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCODE_COMPANION_DATA: dataDir,
      OPENCODE_COMPANION_SESSION_ID: "test-session-strict",
    },
  });
}

describe("parseArgs — strict mode", () => {
  it("collects unknown options instead of coercing them to true", () => {
    const { options, unknown } = parseArgs(["--watc"], {
      booleanOptions: ["watch", "wait"],
      strict: true,
    });
    assert.deepEqual(unknown, ["watc"]);
    assert.equal(options.watc, undefined, "a typo must never become a live option");
  });

  it("still parses the legal options around the typo", () => {
    const { options, positional, unknown } = parseArgs(
      ["job-1", "--interval", "5", "--bogus", "--watch"],
      { valueOptions: ["interval"], booleanOptions: ["watch"], strict: true }
    );
    assert.equal(options.interval, "5");
    assert.equal(options.watch, true);
    assert.deepEqual(positional, ["job-1"]);
    assert.deepEqual(unknown, ["bogus"]);
  });

  it("stays LENIENT (the historical behavior) when strict is not set", () => {
    const { options, unknown } = parseArgs(["--whatever"], {});
    assert.equal(options.whatever, true);
    assert.deepEqual(unknown, [], "non-strict callers see no unknown list");
  });
});

describe("didYouMean", () => {
  it("suggests the option the user was obviously reaching for", () => {
    assert.equal(didYouMean("watc", ["wait", "watch", "exit-when-idle"]), "watch");
    assert.equal(didYouMean("jsn", ["json", "enable-review-gate"]), "json");
    assert.equal(didYouMean("intervl", ["interval", "workspace"]), "interval");
    assert.equal(didYouMean("workspce", ["interval", "workspace"]), "workspace");
  });

  it("prefers a prefix of a real option over an equally-distant unrelated one", () => {
    // "watc" is 1 from "watch" (a prefix) and 2 from "wait" — never pick "wait".
    assert.equal(didYouMean("watc", ["wait", "watch"]), "watch");
  });

  it("suggests nothing when nothing is close (no confident wrong guesses)", () => {
    assert.equal(didYouMean("completely-different", ["watch", "wait"]), null);
    assert.equal(didYouMean("watch", []), null);
  });
});

describe("formatUnknownOptionError", () => {
  it("names the flag, the subcommand, the fix, and where to look", () => {
    const msg = formatUnknownOptionError("status", ["watc"], ["wait", "watch", "interval"]);
    assert.match(msg, /unknown option `--watc` for `status`/);
    assert.match(msg, /Did you mean `--watch`\?/);
    assert.match(msg, /--help/);
  });

  it("says so plainly when the subcommand takes no options at all", () => {
    const msg = formatUnknownOptionError("result", ["jsn"], []);
    assert.match(msg, /unknown option `--jsn` for `result`/);
    assert.match(msg, /takes no options/);
  });

  it("lists the legal options when the typo resembles none of them", () => {
    const msg = formatUnknownOptionError("watch", ["zzzzzz"], ["interval", "workspace"]);
    assert.match(msg, /Valid options for `watch`: --interval, --workspace/);
  });
});

describe("the CLI itself — a typo'd flag is refused, not ignored", () => {
  let dataDir;

  it("`status --watc` exits 1 and suggests --watch (it used to run a plain status)", () => {
    dataDir = createTmpDir("strict-status");
    try {
      const res = runCli(["status", "--watc"], { dataDir });
      assert.equal(res.status, 1, "must FAIL, not fall back to a normal status");
      const err = res.stderr;
      assert.match(err, /unknown option `--watc` for `status`/);
      assert.match(err, /Did you mean `--watch`\?/);
      assert.doesNotMatch(res.stdout, /Latest Finished|Running Jobs/,
        "it must not have quietly run the ordinary status board anyway");
    } finally {
      cleanupTmpDir(dataDir);
    }
  });

  it("`result --jsn` exits 1 instead of silently ignoring the flag", () => {
    dataDir = createTmpDir("strict-result");
    try {
      const res = runCli(["result", "--jsn"], { dataDir });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /unknown option `--jsn` for `result`/);
      assert.match(res.stderr, /takes no options/);
    } finally {
      cleanupTmpDir(dataDir);
    }
  });

  it("`setup --jsn` exits 1 and suggests --json", () => {
    dataDir = createTmpDir("strict-setup");
    try {
      const res = runCli(["setup", "--jsn"], { dataDir });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Did you mean `--json`\?/);
    } finally {
      cleanupTmpDir(dataDir);
    }
  });

  it("`cancel --frce` exits 1", () => {
    dataDir = createTmpDir("strict-cancel");
    try {
      const res = runCli(["cancel", "--frce"], { dataDir });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /unknown option `--frce` for `cancel`/);
    } finally {
      cleanupTmpDir(dataDir);
    }
  });

  it("`watch --intervl 5` exits 1 and suggests --interval", () => {
    dataDir = createTmpDir("strict-watch");
    try {
      const res = runCli(["watch", "--intervl", "5"], { dataDir });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Did you mean `--interval`\?/);
    } finally {
      cleanupTmpDir(dataDir);
    }
  });

  it("a CORRECTLY spelled flag still works (the check is not just 'reject flags')", () => {
    dataDir = createTmpDir("strict-ok");
    try {
      const res = runCli(["status"], { dataDir });
      assert.equal(res.status, 0);
      assert.doesNotMatch(res.stderr, /unknown option/);
    } finally {
      cleanupTmpDir(dataDir);
    }
  });
});

describe("REGRESSION — task text is still forwarded verbatim", () => {
  it("keeps an undeclared --flag inside the task text (parseTaskArgv)", () => {
    const r = parseTaskArgv(["run", "git", "commit", "--no-verify", "on", "main"], {
      valueOptions: ["model", "agent"],
      booleanOptions: ["background"],
    });
    assert.equal(r.taskText, "run git commit --no-verify on main");
    assert.deepEqual(r.errors, []);
  });

  it("keeps a LEADING --flag as task text, and still parses the real flags", () => {
    const r = parseTaskArgv(["--no-verify", "这参数啥意思", "--model", "provider/model-x"], {
      valueOptions: ["model"],
      booleanOptions: ["background"],
    });
    assert.equal(r.taskText, "--no-verify 这参数啥意思");
    assert.equal(r.options.model, "provider/model-x");
    assert.deepEqual(r.errors, [], "an undeclared flag in task text is NEVER an error");
  });

  it("`task --no-verify …` is NOT rejected as an unknown option by the CLI", () => {
    const dataDir = createTmpDir("lenient-task");
    try {
      // --task-file points at nothing, so the run dies at argument validation —
      // BEFORE it dispatches anything or talks to a server. What matters is WHICH
      // error comes back: the task-file one, never an "unknown option --no-verify".
      const res = runCli(
        ["task", "--no-verify", "--task-file", path.join(dataDir, "missing.txt")],
        { dataDir }
      );
      assert.equal(res.status, 1);
      assert.match(res.stderr, /could not read --task-file/);
      assert.doesNotMatch(res.stderr, /unknown option/,
        "`--no-verify` is task text on a dispatch command — strict mode must not reach it");
      assert.doesNotMatch(res.stderr, /Did you mean/);
    } finally {
      cleanupTmpDir(dataDir);
    }
  });

  it("`wait-and-result` stays lenient too", () => {
    const dataDir = createTmpDir("lenient-wait");
    try {
      const res = runCli(
        ["wait-and-result", "--no-verify", "--task-file", path.join(dataDir, "missing.txt")],
        { dataDir }
      );
      assert.equal(res.status, 1);
      assert.doesNotMatch(res.stderr, /unknown option/);
    } finally {
      cleanupTmpDir(dataDir);
    }
  });
});

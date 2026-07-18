import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseTaskArgv } from "../plugins/opencode/scripts/lib/args.mjs";
import { assertSafeRef, getDiff } from "../plugins/opencode/scripts/lib/git.mjs";
import { resolveResultJob } from "../plugins/opencode/scripts/lib/job-control.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { withWorktree } from "../plugins/opencode/scripts/lib/worktree.mjs";

// (extractTaskText was removed; the byte-for-byte forwarding promise now lives
// in parseTaskArgv, asserted against the successor.)
describe("parseTaskArgv — unknown flags are task text, not routing flags", () => {
  it("keeps an unknown --flag inside the task text (byte-for-byte promise)", () => {
    const { taskText } = parseTaskArgv(
      ["--model", "p/m", "run", "git", "commit", "--no-verify", "now"],
      { valueOptions: ["model"], booleanOptions: ["write"] }
    );
    assert.equal(taskText, "run git commit --no-verify now");
  });

  it("still strips declared flags (value + boolean + inline forms)", () => {
    const { taskText } = parseTaskArgv(
      ["--write", "--model=p/m", "fix", "the", "bug"],
      { valueOptions: ["model"], booleanOptions: ["write"] }
    );
    assert.equal(taskText, "fix the bug");
  });

  it("keeps an unknown --foo=bar inline token as task text", () => {
    const { taskText } = parseTaskArgv(["use", "--depth=3", "here"], { valueOptions: ["model"] });
    assert.equal(taskText, "use --depth=3 here");
  });
});

describe("assertSafeRef — git option-injection guard", () => {
  it("accepts normal refs", () => {
    assert.equal(assertSafeRef("main"), "main");
    assert.equal(assertSafeRef("origin/feature.x-1"), "origin/feature.x-1");
    assert.equal(assertSafeRef("v1.0.0^{}"), "v1.0.0^{}");
  });

  it("rejects option-shaped and garbage refs", () => {
    assert.throws(() => assertSafeRef("--output=/tmp/x"));
    assert.throws(() => assertSafeRef("-b"));
    assert.throws(() => assertSafeRef("a b"));
    assert.throws(() => assertSafeRef(""));
  });
});

describe("getDiff — staged changes are visible; git failures throw", () => {
  const HAS_GIT = (() => {
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
  })();

  it("includes STAGED-only changes in the default working-tree diff", { skip: !HAS_GIT }, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gd-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
      // Stage a change and do NOT leave it unstaged.
      fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
      execFileSync("git", ["add", "a.txt"], { cwd: repo });
      const diff = await getDiff(repo, {});
      assert.match(diff, /-one/, "staged edit must appear in the review diff");
      assert.match(diff, /\+two/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("throws (not empty diff) when the base ref is invalid", { skip: !HAS_GIT }, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gd2-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      await assert.rejects(() => getDiff(repo, { base: "no-such-ref-xyz" }));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("resolveResultJob — strict session scoping", () => {
  it("returns null (not another session's job) when this session has none", () => {
    const jobs = [
      { id: "other", status: "completed", sessionId: "S2", updatedAt: "2026-01-02T00:00:00Z" },
    ];
    const { job } = resolveResultJob(jobs, undefined, { sessionId: "S1" });
    assert.equal(job, null);
  });

  it("still finds any session's job by explicit id", () => {
    const jobs = [
      { id: "other", status: "completed", sessionId: "S2", updatedAt: "2026-01-02T00:00:00Z" },
    ];
    const { job } = resolveResultJob(jobs, "other", { sessionId: "S1" });
    assert.equal(job?.id, "other");
  });
});

describe("runCommand — process-group kill reaps grandchildren", () => {
  it("returns promptly when a shell child spawns a sleeping grandchild", { skip: process.platform === "win32" }, async () => {
    const t0 = Date.now();
    // Without group-kill, killing only `sh` leaves `sleep 30` holding the pipe
    // and close never fires until the grandchild exits.
    const r = await runCommand("sh", ["-c", "sleep 30"], { timeoutMs: 400 });
    const elapsed = Date.now() - t0;
    assert.equal(r.timedOut, true);
    assert.ok(elapsed < 10_000, `should not wait for the grandchild (took ${elapsed}ms)`);
  });
});

describe("withWorktree — task failure preserves the worktree", () => {
  const HAS_GIT = (() => {
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
  })();

  it("keeps the worktree (with its changes) when fn throws", { skip: !HAS_GIT }, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wtf-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "base.txt"), "x\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

      const wtChanged = path.join(repo, ".opencode-worktrees", "job-boom", "made.txt");
      await assert.rejects(() =>
        withWorktree({ dir: repo, jobId: "job-boom", useWorktree: true, isWrite: true }, async (cwd) => {
          fs.writeFileSync(path.join(cwd, "made.txt"), "partial\n");
          throw new Error("boom"); // task dies AFTER modifying files
        })
      );
      assert.ok(fs.existsSync(wtChanged), "worktree with partial changes must be preserved");
      assert.equal(fs.readFileSync(wtChanged, "utf8"), "partial\n");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

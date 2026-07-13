import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withWorktree } from "../plugins/opencode/scripts/lib/worktree.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

describe("withWorktree", { skip: !hasGit }, () => {
  let repo;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "init"]);
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("runs fn in an isolated worktree and applies its changes back", async () => {
    const logs = [];
    const result = await withWorktree(
      { dir: repo, jobId: "job-apply", useWorktree: true, isWrite: true },
      async (cwd) => {
        assert.notEqual(cwd, repo, "should run inside a worktree, not the live repo");
        assert.ok(cwd.includes(".opencode-worktrees"), cwd);
        fs.writeFileSync(path.join(cwd, "created.txt"), "hello\n");
        fs.writeFileSync(path.join(cwd, "base.txt"), "base modified\n");
        return "ok";
      },
      (m) => logs.push(m)
    );

    assert.equal(result, "ok");
    // Changes applied back to the live repo working tree.
    assert.equal(fs.readFileSync(path.join(repo, "created.txt"), "utf8"), "hello\n");
    assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "base modified\n");
    // Worktree cleaned up.
    assert.ok(!fs.existsSync(path.join(repo, ".opencode-worktrees", "job-apply")));
    assert.ok(logs.some((l) => /applied/i.test(l)), logs.join(" | "));
  });

  it("runs directly in the repo when isolation is not requested", async () => {
    let seen = null;
    await withWorktree(
      { dir: repo, jobId: "job-noop", useWorktree: false, isWrite: true },
      async (cwd) => {
        seen = cwd;
      }
    );
    assert.equal(seen, repo);
  });

  it("falls back to the live repo when dir is not a git repository", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "wt-plain-"));
    try {
      let seen = null;
      const logs = [];
      await withWorktree(
        { dir: plain, jobId: "job-nogit", useWorktree: true, isWrite: true },
        async (cwd) => {
          seen = cwd;
        },
        (m) => logs.push(m)
      );
      assert.equal(seen, plain);
      assert.ok(logs.some((l) => /not inside a git repository/i.test(l)));
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

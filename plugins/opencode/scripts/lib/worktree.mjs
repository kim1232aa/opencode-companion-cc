// Optional git-worktree isolation for write-mode tasks.
//
// OpenCode's `build` agent snapshots its workspace (git) for undo. If we run it
// directly in a live repo while other edits are happening, its snapshot/restore
// can revert unrelated concurrent changes. Running it in a throwaway worktree
// keeps its snapshots inside that worktree; we then apply the resulting patch
// back to the real repo (surfacing a conflict instead of silently clobbering).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.mjs";

async function git(cwd, args, opts = {}) {
  return runCommand("git", args, { cwd, ...opts });
}

async function isGitRepo(dir) {
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  return !!r && r.exitCode === 0 && r.stdout.trim() === "true";
}

async function repoToplevel(dir) {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => null);
  return r && r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * Run `fn(effectiveCwd)` — either directly in `dir`, or, when isolation is
 * requested and possible, inside a fresh detached git worktree whose changes
 * are applied back to `dir` afterward and then removed.
 *
 * @param {object} o
 * @param {string} o.dir           the task workspace
 * @param {string} o.jobId
 * @param {boolean} o.useWorktree  --worktree was requested
 * @param {boolean} o.isWrite      write-capable run (isolation only matters here)
 * @param {(cwd: string) => Promise<any>} fn
 * @param {(msg: string) => void} [log]
 * @returns {Promise<any>} whatever fn returns
 */
export async function withWorktree({ dir, jobId, useWorktree, isWrite }, fn, log = () => {}) {
  if (!useWorktree || !isWrite || !(await isGitRepo(dir))) {
    if (useWorktree && isWrite) log("--worktree ignored: not inside a git repository.");
    return fn(dir);
  }

  const top = (await repoToplevel(dir)) || dir;
  const wtPath = `${top}/.opencode-worktrees/${jobId}`;

  const add = await git(top, ["worktree", "add", "--detach", wtPath, "HEAD"]);
  if (add.exitCode !== 0) {
    log(`--worktree setup failed (${add.stderr.trim()}); running in the live workspace instead.`);
    return fn(dir);
  }

  let patchFile = null;
  let keepWorktree = false;
  try {
    const result = await fn(wtPath);

    // Capture everything the task changed in the worktree as one patch.
    await git(wtPath, ["add", "-A"]);
    const MAX_PATCH = 128 * 1024 * 1024;
    const diff = await git(wtPath, ["diff", "--cached", "--binary", "HEAD"], { maxOutputBytes: MAX_PATCH });
    const patch = diff.stdout || "";

    // A truncated diff would corrupt the patch and apply garbage — refuse it.
    if (diff.overflowed) {
      keepWorktree = true;
      log(`Worktree changes exceed ${Math.round(MAX_PATCH / (1024 * 1024))}MB and were NOT applied back automatically. Recover them from ${wtPath}.`);
      return result;
    }

    if (patch.trim()) {
      // runCommand cannot feed stdin (stdio[0] === "ignore"), so `git apply -`
      // would read nothing. Write the patch to a temp file and apply from it.
      patchFile = path.join(os.tmpdir(), `opencode-wt-${jobId}.patch`);
      fs.writeFileSync(patchFile, patch);
      const apply = await runCommand("git", ["-C", top, "apply", "--whitespace=nowarn", patchFile])
        .catch((e) => ({ exitCode: 1, stderr: e.message, stdout: "" }));
      if (apply.exitCode !== 0) {
        keepWorktree = true;
        log(`Worktree changes could NOT be applied back cleanly (likely a conflict with concurrent edits): ${apply.stderr.trim()}. The patch is preserved at ${patchFile} and the worktree at ${wtPath}.`);
        return result;
      }
      log("Applied the isolated worktree changes back to the workspace.");
    }
    return result;
  } finally {
    if (patchFile && !keepWorktree) {
      try { fs.unlinkSync(patchFile); } catch { /* best-effort */ }
    }
    // Leave the worktree in place when apply failed/overflowed so the user can recover.
    if (!keepWorktree) {
      await git(top, ["worktree", "remove", "--force", wtPath]).catch(() => {});
    }
  }
}

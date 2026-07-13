import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs, extractTaskText } from "../plugins/opencode/scripts/lib/args.mjs";
import { withFileLock, pidStartTime } from "../plugins/opencode/scripts/lib/fs.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

const HAS_PROC = process.platform === "linux";

function tmpLock() {
  return path.join(os.tmpdir(), `oclock2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ".lock");
}

describe("parseArgs — value option must not swallow a following flag", () => {
  it("treats `--model --write` as a missing model value, keeping --write", () => {
    const { options, positional } = parseArgs(["--model", "--write", "fix", "bug"], {
      valueOptions: ["model"],
      booleanOptions: ["write"],
    });
    assert.equal(options.model, "", "model must not eat --write");
    assert.equal(options.write, true, "--write must survive as a boolean");
    assert.deepEqual(positional, ["fix", "bug"]);
  });

  it("still consumes a real value", () => {
    const { options } = parseArgs(["--model", "prov/mod"], { valueOptions: ["model"] });
    assert.equal(options.model, "prov/mod");
  });

  it("extractTaskText mirrors the rule (does not fold --write into task text)", () => {
    const text = extractTaskText(["--model", "--write", "do", "the", "thing"], ["model"], ["write"]);
    assert.equal(text, "do the thing");
  });
});

describe("withFileLock — start-time fingerprint (Linux)", () => {
  it("never steals a live holder's lock even when older than the fallback", { skip: !HAS_PROC }, () => {
    const lock = tmpLock();
    fs.mkdirSync(lock, { recursive: true });
    const realStart = pidStartTime(process.pid);
    // 3-part token with the CORRECT fingerprint = provably the same live holder.
    fs.writeFileSync(path.join(lock, "owner"), `${process.pid}:${realStart}:nonce`, "utf8");
    // Backdate mtime well past the 60s fallback — must STILL not be stolen.
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(lock, old, old);
    assert.throws(
      () => withFileLock(lock, () => { throw new Error("must not run"); }),
      /Timed out waiting for lock/
    );
    fs.rmSync(lock, { recursive: true, force: true });
  });

  it("reclaims when the fingerprint mismatches (pid was recycled)", { skip: !HAS_PROC }, () => {
    const lock = tmpLock();
    fs.mkdirSync(lock, { recursive: true });
    // Alive pid, but a start-time that cannot match ⇒ recycled ⇒ reclaim now.
    fs.writeFileSync(path.join(lock, "owner"), `${process.pid}:99999999999999:nonce`, "utf8");
    let ran = false;
    withFileLock(lock, () => { ran = true; });
    assert.equal(ran, true, "mismatched fingerprint should be reclaimed");
    assert.equal(fs.existsSync(lock), false);
  });

  it("falls back to bare liveness when the fingerprint is unknown (start=0)", { skip: !HAS_PROC }, () => {
    const lock = tmpLock();
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), `${process.pid}:0:nonce`, "utf8");
    // Fresh lock, live pid, no fingerprint ⇒ bare liveness ⇒ not reclaimed.
    assert.throws(
      () => withFileLock(lock, () => { throw new Error("must not run"); }),
      /Timed out waiting for lock/
    );
    fs.rmSync(lock, { recursive: true, force: true });
  });
});

describe("runCommand — total timeout", () => {
  it("kills a hung child and flags timedOut", { skip: process.platform === "win32" }, async () => {
    const t0 = Date.now();
    const r = await runCommand("sleep", ["10"], { timeoutMs: 300 });
    const elapsed = Date.now() - t0;
    assert.equal(r.timedOut, true, "should report timedOut");
    assert.notEqual(r.exitCode, 0, "a killed process is not a clean exit");
    assert.ok(elapsed < 5000, `should return well before the 10s sleep (took ${elapsed}ms)`);
  });

  it("does not set timedOut for a fast command under the timeout", { skip: process.platform === "win32" }, async () => {
    const r = await runCommand("true", [], { timeoutMs: 5000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 0);
  });
});

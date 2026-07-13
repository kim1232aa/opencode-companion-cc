// Filesystem utilities for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";

/**
 * Ensure a directory exists (recursive mkdir).
 * @param {string} dirPath
 */
export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Read a JSON file, returning null on failure.
 * @param {string} filePath
 * @returns {any|null}
 */
export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write a JSON file atomically (write to tmp then rename).
 * @param {string} filePath
 * @param {any} data
 */
export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Append a line to a file.
 * @param {string} filePath
 * @param {string} line
 */
export function appendLine(filePath, line) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, line + "\n", "utf8");
}

/**
 * Read the last N lines of a file.
 * @param {string} filePath
 * @param {number} n
 * @returns {string[]}
 */
export function tailLines(filePath, n = 10) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// A held lock is only reclaimed when its owner process is provably gone —
// never on a mere mtime age, which would steal the lock from a slow-but-alive
// holder and break mutual exclusion. The mtime fallback below is a last resort
// for when the owner token can't be read (crash mid-write, or a foreign
// pre-token lock) or the owner pid was recycled by an unrelated process; it is
// deliberately long, since a healthy critical section here is milliseconds.
const LOCK_STALE_FALLBACK_MS = 60_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwnerFile(lockPath) {
  return path.join(lockPath, "owner");
}

function readLockOwner(lockPath) {
  try {
    return fs.readFileSync(lockOwnerFile(lockPath), "utf8").trim();
  } catch {
    return null;
  }
}

function ownerPidAlive(token) {
  const pid = Number.parseInt(String(token).split(":")[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // process exists and is signalable
  } catch (err) {
    return err.code === "EPERM"; // exists but owned by another user
  }
}

/**
 * Run `fn` while holding an exclusive filesystem lock, so concurrent processes
 * touching the same lockPath serialize instead of racing on a read-modify-write.
 * Uses mkdir as the mutex primitive (atomic on POSIX). The holder writes an
 * owner token (pid + nonce); a waiter reclaims only if that pid is dead (or the
 * lock is older than the long fallback), and a holder releases only a lock
 * whose token still matches its own — so a long critical section is never
 * stolen and a reclaimed lock is never double-released (ABA-safe).
 * @param {string} lockPath
 * @param {() => any} fn
 * @returns {any}
 */
export function withFileLock(lockPath, fn) {
  ensureDir(path.dirname(lockPath));
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(lockOwnerFile(lockPath), token, "utf8");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Someone holds it. Reclaim ONLY if the holder is provably gone.
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished between the failed mkdir and this stat; retry
      }
      const owner = readLockOwner(lockPath);
      const reclaim = owner
        ? !ownerPidAlive(owner) || ageMs > LOCK_STALE_FALLBACK_MS
        : ageMs > LOCK_STALE_FALLBACK_MS;
      if (reclaim) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // lost the reclaim race to another waiter; retry
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    // Only remove the lock if it is STILL ours — a stale-reclaim by another
    // process may have replaced it, and we must never delete a lock we no
    // longer own (would break the new holder's mutual exclusion).
    if (readLockOwner(lockPath) === token) {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

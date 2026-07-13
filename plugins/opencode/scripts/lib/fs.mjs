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

const LOCK_STALE_MS = 10_000; // reclaim a lock left behind by a crashed process
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive filesystem lock, so concurrent
 * processes touching the same lockPath serialize instead of racing on a
 * read-modify-write. Uses mkdir as the mutex primitive (atomic on POSIX).
 * @param {string} lockPath
 * @param {() => any} fn
 * @returns {any}
 */
export function withFileLock(lockPath, fn) {
  ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockPath);
          continue; // retry acquiring immediately after reclaiming
        }
      } catch {
        continue; // lock vanished between the failed mkdir and this stat; retry
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
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // already reclaimed by another process as stale; fine
    }
  }
}

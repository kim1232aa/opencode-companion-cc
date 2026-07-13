// Process utilities for the OpenCode companion.

import { spawn } from "node:child_process";

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {Promise<string|null>}
 */
export async function resolveOpencodeBinary() {
  return new Promise((resolve) => {
    const proc = spawn("which", ["opencode"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    proc.stdout.on("data", (d) => {
      if (!settled) out += d;
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      console.error(`Failed to resolve opencode binary: ${err.message}`);
      resolve(null);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

/**
 * Check if `opencode` CLI is available.
 * @returns {Promise<boolean>}
 */
export async function isOpencodeInstalled() {
  const bin = await resolveOpencodeBinary();
  return bin !== null;
}

/**
 * Get the installed opencode version.
 * @returns {Promise<string|null>}
 */
export async function getOpencodeVersion() {
  return new Promise((resolve) => {
    const proc = spawn("opencode", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    let settled = false;
    proc.stdout.on("data", (d) => {
      if (!settled) out += d;
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      console.error(`Failed to get opencode version: ${err.message}`);
      resolve(null);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

/**
 * Run a command and return { stdout, stderr, exitCode }.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let overflowed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutputBytes =
      typeof opts.maxOutputBytes === "number" && opts.maxOutputBytes >= 0
        ? opts.maxOutputBytes
        : undefined;

    proc.stdout.on("data", (d) => {
      if (settled || overflowed) return;
      if (maxOutputBytes !== undefined) {
        if (stdoutBytes + d.length > maxOutputBytes) {
          overflowed = true;
          const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
          if (remaining > 0) {
            stdout += d.subarray(0, remaining).toString();
            stdoutBytes += remaining;
          }
          proc.kill();
          return;
        }
        stdout += d;
        stdoutBytes += d.length;
        return;
      }
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      if (settled || overflowed) return;
      if (maxOutputBytes !== undefined) {
        if (stderrBytes + d.length > maxOutputBytes) {
          overflowed = true;
          const remaining = Math.max(0, maxOutputBytes - stderrBytes);
          if (remaining > 0) {
            stderr += d.subarray(0, remaining).toString();
            stderrBytes += remaining;
          }
          proc.kill();
          return;
        }
        stderr += d;
        stderrBytes += d.length;
        return;
      }
      stderr += d;
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn command '${cmd}': ${err.message}`));
    });
    proc.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      const result = { stdout, stderr, exitCode: exitCode ?? 1 };
      if (maxOutputBytes !== undefined) {
        result.overflowed = overflowed;
      }
      resolve(result);
    });
  });
}

/**
 * Spawn a detached background process.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  child.on("error", (err) => {
    console.error(`Failed to spawn detached command '${cmd}': ${err.message}`);
  });
  child.unref();
  return child;
}

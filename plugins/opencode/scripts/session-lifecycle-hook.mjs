#!/usr/bin/env node

// Session lifecycle hook for the OpenCode companion.
// Called on SessionStart and SessionEnd events to manage the OpenCode server.

import process from "node:process";
import { isServerRunning } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState } from "./lib/state.mjs";
import { recoverStrandedResults, reconcileStrandedJobs } from "./lib/job-control.mjs";

function serverUrl() {
  const port = Number(process.env.OPENCODE_SERVER_PORT) || 4096;
  return `http://127.0.0.1:${port}`;
}

const event = process.argv[2]; // "SessionStart" or "SessionEnd"

async function main() {
  const workspace = await resolveWorkspace();

  if (event === "SessionStart") {
    // Check if OpenCode server is available (but don't auto-start it)
    const running = await isServerRunning();
    if (running) {
      process.stderr.write("[opencode-companion] OpenCode server detected.\n");
    }
  }

  if (event === "SessionEnd") {
    // Clean up orphaned jobs whose worker died. First try to salvage the result
    // from the server (the session often finished server-side) — otherwise a
    // recoverable answer would be lost the moment we mark the job failed. Only
    // then reconcile whatever couldn't be recovered.
    let jobs = loadState(workspace).jobs ?? [];
    try {
      jobs = await recoverStrandedResults(workspace, jobs, serverUrl());
    } catch {
      // Recovery is best-effort; fall through to reconciliation.
    }
    reconcileStrandedJobs(workspace, jobs);
  }
}

main().catch(() => {
  // Hooks should never block the session, so swallow errors silently.
  process.exit(0);
});

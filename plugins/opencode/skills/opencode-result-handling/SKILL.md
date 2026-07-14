---
name: opencode-result-handling
description: How to correctly check whether an OpenCode companion job finished, died, or is still running, and how to retrieve its result. Use whenever you need to inspect an OpenCode/opencode-rescue background job's status, decide if a task that looks stuck or "frozen" is actually dead, find a dispatched job's output, or interpret /opencode:status and /opencode:result. Explains why you must use the status/result commands instead of reading state or log files by hand.
user-invocable: false
---

# OpenCode Result Handling

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result <job-id>
```

(or `/opencode:status`, `/opencode:result`). Cheap Bash calls — run them from the main
loop; never spawn a subagent just to collect a result.

## Iron rules

- **Use the commands; never hand-read state or logs.** Several plugin versions can be
  installed at once, each with its **own** state dir, so a hand-built path into
  `state/**/*.json` or `jobs/*.log` can show stale data from a different install. The
  commands resolve the right workspace, reconcile dead workers, and recover finished
  sessions from the server.
- **"Frozen" is not "dead".** A real task routinely runs **15–30+ minutes**, and logs
  are written only on a phase change — a long gap at `Running task…` is the **normal
  working state**. Liveness comes from the worker process and the server (which
  `status` checks), never from log recency. Rising `heartbeat: N tokens so far`
  between two `status` calls = working.
- **"completed" is not always "succeeded".** `⚠️ no output` / "No output" means the
  model produced nothing usable — a **failure**, not a win. Retry with a different
  `--model` or a rephrased task.
- **A dead worker does not mean a lost result.** After an OOM/SIGKILL the OpenCode
  session usually still finished server-side; `status`/`result` salvage it and mark the
  job `completed` (flagged `recovered`). **Always run `result <id>` before concluding
  anything was lost.**
- **Jobs are session-scoped by default.** Without a job id, `status`/`result` show only
  the current Claude session's jobs — "no finished job" does not mean the workspace has
  none. Pass another session's job id explicitly.

## Presenting a result

Return the command's stdout as the primary result — final message, changed files, and
the trailing token/cost line — and include the session id so the run can be resumed. If
you see `> Recovered from the OpenCode server after the worker exited without returning.`,
mention the recovery and check the answer looks complete.

Full triage flow (job-state matrix, concurrent-job dashboard, manual liveness checks):
[references/job-triage.md](references/job-triage.md).

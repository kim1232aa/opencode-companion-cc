---
name: opencode-result-handling
description: How to correctly check whether an OpenCode companion job finished, died, or is still running, and how to retrieve its result. Use whenever you need to inspect an OpenCode/opencode-rescue background job's status, decide if a task that looks stuck or "frozen" is actually dead, find a dispatched job's output, or interpret /opencode:status and /opencode:result. Explains why you must use the status/result commands instead of reading state or log files by hand.
user-invocable: false
---

# OpenCode Result Handling

## Check a job with the commands — never hand-read state or logs

To learn a job's real status or fetch its result, run the companion's own
commands and trust their output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result <job-id>
```

(or `/opencode:status` and `/opencode:result`). They resolve the correct
workspace, reconcile jobs whose worker died, and recover finished sessions from
the server. **Do NOT** judge a job by reading
`~/.claude/plugins/data/**/state/**/*.json` or `jobs/*.log` directly. That path
is a trap:

- **Multiple plugin versions can be installed at once** — e.g. an old
  `opencode/1.0.0` and the current `opencode-companion-cc/2.0.x` — and **each has
  its own separate state directory**. Reading the wrong version's dir shows
  stale, frozen data that has nothing to do with the live job. The `status`/
  `result` commands read the right one; hand-built paths silently don't.
- **Job logs are written only on a phase change** (`report()`), not
  continuously. A long gap sitting at `Running task…` is the **normal working
  state**, not a sign of death.

## "Frozen" is not "dead"

A stale log does not mean the worker died. A real OpenCode task routinely runs
**15–30+ minutes**. Do not declare a task dead because it has been quiet for a
few minutes.

- Determine liveness from the **worker process and the server**, not from log
  recency. `status` already does this (it reconciles a dead pid to `failed` and
  recovers a finished session), so prefer it.
- If you check manually anyway, confirm the worker pid is alive **and** ask the
  server whether the session is still active — never infer death from a stale
  log line.

## A dead worker does not mean a lost result

If a worker was hard-killed (OOM / SIGKILL) after its prompt was dispatched, the
OpenCode session usually still finished server-side. `status` and `result` probe
the server and salvage that answer, marking the job `completed` (flagged
`recovered`). **Run `result <id>` before concluding anything was lost.**

## Presenting results

When you have the command output:

1. Return the command's stdout as the primary result — the final assistant
   message, any changed files, and the trailing token/cost line.
2. Note when a result is `recovered` (it came from the server after the worker
   exited, so double-check it looks complete).
3. Include the session id so the run can be resumed (`--resume-last`, or an
   explicit resume of that session).

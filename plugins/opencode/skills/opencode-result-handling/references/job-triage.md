# Job triage — full flow

## Check a job with the commands — never hand-read state or logs

To learn a job's real status or fetch its result, run the companion's own commands
and trust their output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result <job-id>
```

(or `/opencode:status` and `/opencode:result`). They resolve the correct workspace,
reconcile jobs whose worker died, and recover finished sessions from the server.

**Do NOT** judge a job by reading `~/.claude/plugins/data/**/state/**/*.json` or
`jobs/*.log` directly. That path is a trap:

- **Multiple plugin versions can be installed at once** — e.g. an old
  `opencode/1.0.0` and the current `opencode-companion-cc/2.0.x` — and **each has
  its own separate state directory**. Reading the wrong version's dir shows stale,
  frozen data that has nothing to do with the live job. The `status`/`result`
  commands read the right one; hand-built paths silently don't.
- **Job logs are written only on a phase change** (`report()`), not continuously.
  A long gap sitting at `Running task…` is the **normal working state**, not a sign
  of death.

## Jobs are session-scoped by default

`status` and `result` (without an explicit job id) show ONLY jobs dispatched from
the current Claude session — another session's newer job is deliberately not
returned. To inspect a different session's job, pass its job id explicitly. So
"result says no finished job" does not mean the workspace has none.

## "Frozen" is not "dead"

A stale log does not mean the worker died. A real OpenCode task routinely runs
**15–30+ minutes**. Do not declare a task dead because it has been quiet for a few
minutes. While the model is generating, the worker writes a
`heartbeat: N tokens so far` line into the job log every ~30s — `status` shows it
in the running job's progress preview. Tokens climbing between two `status` calls =
working; frozen across several = genuinely stuck.

- Determine liveness from the **worker process and the server**, not from log
  recency. `status` already does this (it reconciles a dead pid to `failed` and
  recovers a finished session), so prefer it.
- If you check manually anyway, confirm the worker pid is alive **and** ask the
  server whether the session is still active — never infer death from a stale log
  line.

## "completed" is not always "succeeded"

`status`/`result` distinguish these — do not treat every terminal job as a win:

- ❌ **failed** shows its error (surfaced at the top of `status`).
- ✅ **completed** with output = success.
- **`⚠️ no output` / "No output" = completed but the model produced nothing
  usable** (some models return an empty turn). That is NOT a success — retry with a
  different `--model` or a rephrased task.
- With several concurrent jobs, read the whole `status` dashboard: each running job
  shows a live token count and how long since its last update, so you can tell
  generating (tokens rising) from stuck (frozen + old "updated … ago") from failed
  — without watching any single one.

## A dead worker does not mean a lost result

If a worker was hard-killed (OOM / SIGKILL) after its prompt was dispatched, the
OpenCode session usually still finished server-side. `status` and `result` probe the
server and salvage that answer, marking the job `completed` (flagged `recovered`).
**Run `result <id>` before concluding anything was lost.**

## Presenting results

When you have the command output:

1. Return the command's stdout as the primary result — the final assistant message,
   any changed files, and the trailing token/cost line.
2. A recovered result is marked by the exact line
   `> Recovered from the OpenCode server after the worker exited without returning.`
   in the `result` output — when you see it, mention the recovery and double-check
   the answer looks complete.
3. Include the session id so the run can be resumed (`--resume-last`, or an explicit
   resume of that session).

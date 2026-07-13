---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the OpenCode rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--worktree] [--model <provider/model>] [--agent <build|plan>] [what OpenCode should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*)
---

Route this request to the `opencode:opencode-rescue` subagent.
The final user-visible response must be OpenCode's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- Default (or `--wait`): the subagent dispatches `wait-and-result`, which BLOCKS until OpenCode finishes and returns the full output. This is the reliable path — the user gets the actual result, not a job id.
- `--background`: the subagent dispatches `task --background`, which returns a job id immediately; the user retrieves the result later with `/opencode:result`.
- `--background` and `--wait` select the subcommand only. Do not treat them as part of the natural-language task text.
- `--model`, `--agent`, and `--worktree` are runtime-selection flags. Preserve them for the forwarded dispatch call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting OpenCode, check for a resumable rescue session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current OpenCode session or start a new one.
- The two choices must be:
  - `Continue current OpenCode session`
  - `Start a new OpenCode session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current OpenCode session (Recommended)` first.
- Otherwise put `Start a new OpenCode session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" <wait-and-result|task> ...` and return that command's stdout as-is.
- Return the OpenCode companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/opencode:status`, fetch `/opencode:result`, call `/opencode:cancel`, summarize output, or do follow-up work of its own.
- Leave `--agent` unset unless the user explicitly asks for a specific agent (build or plan).
- Leave the model unset unless the user explicitly asks for one.
- If `--resume` or `--fresh` is present in the request — whether supplied by the user or added by the resume-check step above — leave it in the forwarded request. The subagent maps `--resume` to `--resume-last` (and `--fresh` to a fresh run) when it builds the dispatch command; you do not expand it yourself.
- If the helper reports that OpenCode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
- If the user did not supply a request, ask what OpenCode should investigate or fix.

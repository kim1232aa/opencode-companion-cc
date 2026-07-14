---
description: Delegate a task, investigation, or fix to OpenCode
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

- If the helper reports `available: false`, route normally (fresh). There is nothing to decide.
- If the helper reports `available: true`, resolve resume-vs-fresh as follows. **Never block on a question nobody can answer** — this command and the rescue subagent both run without a human in the loop, and a stalled dispatch is killed by the watchdog.
  - **Only if `AskUserQuestion` is actually available in the current context**, use it exactly once with two options:
    - `Continue current OpenCode session`
    - `Start a new OpenCode session`
    - If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current OpenCode session (Recommended)` first. Otherwise put `Start a new OpenCode session (Recommended)` first.
    - Continue → add `--resume` before routing to the subagent. New session → add `--fresh`.
  - **If `AskUserQuestion` is NOT available** — which is the normal case here, since this command's `allowed-tools` grants only `Bash(node:*)` and the `opencode:opencode-rescue` subagent has only `Bash` — do not ask and do not stall. Decide deterministically:
    - If the user's own words are clearly a follow-up ("continue", "keep going", "resume", "apply the top fix", "dig deeper"), add `--resume`.
    - Otherwise add `--fresh`. **A new session is the default.**
    - Then disclose the decision (see the routing-note rule below). Do not silently pick one.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" <wait-and-result|task> ...` and return that command's stdout as-is.
- Return the OpenCode companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- **Routing note (the only permitted addition):** if a resumable session was detected and you chose fresh-vs-resume yourself (because `AskUserQuestion` was unavailable), prepend exactly ONE line above the verbatim stdout, then the stdout unchanged:
  `Detected a resumable OpenCode session <id>; started a new session. To continue that session instead, re-run with --resume.`
  Nothing else may be added.
- Do not ask the subagent to inspect files, monitor progress, poll `/opencode:status`, fetch `/opencode:result`, call `/opencode:cancel`, summarize output, or do follow-up work of its own.
- Leave `--agent` unset unless the user explicitly asks for a specific agent (build or plan).
- Leave the model unset unless the user explicitly asks for one.
- If `--resume` or `--fresh` is present in the request — whether supplied by the user or added by the resume-check step above — leave it in the forwarded request. The subagent maps `--resume` to `--resume-last` (and `--fresh` to a fresh run) when it builds the dispatch command; you do not expand it yourself.
- If the helper reports that OpenCode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
- If the user did not supply a request, ask what OpenCode should investigate or fix.

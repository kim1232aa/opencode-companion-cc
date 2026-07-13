---
name: opencode-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# OpenCode Runtime

Use this skill only inside the `opencode:opencode-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct OpenCode CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `opencode:opencode-rescue`.
- Default to `wait-and-result` for every rescue request (diagnosis, planning, research, and explicit fix requests). It dispatches on a tracked worker, BLOCKS until the task finishes, and prints the actual result — so you return real output, not just a job id. Use `task --background` ONLY when the user explicitly asked for fire-and-forget background execution.
- Forward the user's task text byte-for-byte. Never summarize, shorten, paraphrase, or "tighten" it, no matter how long or detailed it is — length is not a reason to compress it.
- Do not inspect the repo, solve the task yourself, or add independent analysis. Your only Claude-side work is stripping routing flags before the single dispatch call.
- Leave `--agent` unset unless the user explicitly requests a specific agent (build or plan).
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.

Command selection:
- Use exactly one dispatch invocation per rescue handoff: `wait-and-result` by default, or `task --background` when the user explicitly asked for background.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only — it selects the subcommand (`task --background` vs `wait-and-result`). Strip the token before dispatching, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to the dispatch call.
- If the forwarded request includes `--agent`, pass it through to the dispatch call.
- If the forwarded request includes `--worktree`, pass it through to the dispatch call. It isolates a write-capable run in a throwaway git worktree so OpenCode's snapshots can't revert unrelated concurrent edits; the companion applies the result back afterward. Both `wait-and-result` and `task` accept it.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always add `--resume-last` to the dispatch call, even if the request text is ambiguous.
- `--fresh`: always dispatch a fresh run (no `--resume-last`), even if the request sounds like a follow-up.

Safety rules:
- Default to write-capable OpenCode work in `opencode:opencode-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the dispatch command exactly as-is (including the trailing token-usage line the companion appends).
- If the Bash call fails or OpenCode cannot be invoked, return nothing.

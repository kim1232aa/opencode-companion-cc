---
description: Delegate a task, investigation, or fix to OpenCode
argument-hint: "[--background|--wait] [--resume|--fresh] [--worktree] [--model <provider/model>] [--agent <build|plan>] [what OpenCode should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*)
---

Delegate this request to OpenCode. The final user-visible response must be
OpenCode's output verbatim.

Raw user request:
$ARGUMENTS

## Dispatch it yourself — do NOT spawn a subagent

Call the companion directly with **one `Bash` call**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" <wait-and-result|task> [flags] "<task text>"
```

That costs ~200 Claude tokens. Routing the same dispatch through the
`opencode:opencode-rescue` subagent costs **~10k** (agent + skills + its turns)
and adds nothing to a plain forward. Hand it to the subagent **only** if the
delegation itself needs multi-step reasoning (probe the repo → decide what to ask
→ re-dispatch on the result), or if the result will be very long and the main
thread only needs a summary of it.

Execution mode:

- Default (or `--wait`): `wait-and-result` — BLOCKS until OpenCode finishes and
  prints the full output. Run it in the foreground with `timeout: 600000` (the
  Bash maximum). If the call is cut off, the detached worker is still alive: take
  the job id from the `[opencode] job <id> dispatched…` stderr line and poll
  `result <id>` until it returns. Never say "I'll check back later".
- `--background`: `task --background` — returns a job id immediately without
  blocking; the user retrieves the output later with `/opencode:result`. This is
  also how you fan out: N independent tasks → N `task --background` calls (or the
  `batch` subcommand, if this version has one — see `--help`).
- `--background`/`--wait` select the subcommand only. `--model`, `--agent`, and
  `--worktree` are runtime flags. None of them are part of the natural-language
  task text — strip them from the text and pass them as flags.

## Resume vs fresh

- `--resume` in the request → dispatch with `--resume-last`. `--fresh` → dispatch
  without it. The user already chose; do not ask.
- Otherwise check for a resumable session first:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```

- `available: false` → dispatch fresh. Nothing to decide.
- `available: true` → **never block on a question nobody can answer** (this
  command's `allowed-tools` grants only `Bash(node:*)`, so `AskUserQuestion` is
  normally unavailable, and a stalled dispatch is killed by the watchdog). Decide
  deterministically: if the user's own words are clearly a follow-up ("continue",
  "keep going", "resume", "apply the top fix", "dig deeper"), use `--resume-last`;
  **otherwise dispatch fresh — a new session is the default** — then disclose it
  with the routing note below. Only if `AskUserQuestion` genuinely IS available may
  you ask once instead (two options: continue the current OpenCode session / start
  a new one, recommended one first).

## Operating rules

- Forward the user's task text byte-for-byte, minus the routing flags. Never
  summarize, shorten, or "tighten" it.
- Return the companion's stdout verbatim. Do not paraphrase, summarize, rewrite,
  or add commentary before or after it.
- **Routing note (the only permitted addition):** if a resumable session was
  detected and you chose fresh-vs-resume yourself, prepend exactly ONE line above
  the verbatim stdout, then the stdout unchanged:
  `Detected a resumable OpenCode session <id>; started a new session. To continue that session instead, re-run with --resume.`
- Leave `--agent` unset (defaults to `build`, write-capable) unless the user
  explicitly asks for one. `--agent plan` is the only read-only mode and needs an
  explicit "don't change anything" / "review only" — investigative wording is not
  enough. Leave `--model` unset unless the user named one.
- Do not inspect files, monitor progress, poll `/opencode:status`, call
  `/opencode:cancel`, or do follow-up work of your own — dispatch and return.
- If the helper reports that OpenCode is missing or unauthenticated, stop and tell
  the user to run `/opencode:setup`.
- If the user did not supply a request, ask what OpenCode should investigate or fix.

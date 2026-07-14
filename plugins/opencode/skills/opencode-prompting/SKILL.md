---
name: opencode-prompting
description: OpenCode-specific rules for composing the task text forwarded to the opencode-companion runtime — what the dispatch layer already handles for you, what breaks a forwarded prompt, and how model/agent selection actually behaves. Use when writing or reviewing the task text for an /opencode:rescue delegation, choosing between the build and plan agents, or picking a --model for a delegated OpenCode run.
user-invocable: false
---

# OpenCode Prompting

**Dispatch from the main loop.** `task --background "<task>"` returns a job id
instantly without blocking; collect it later with `result <id>`. Fan out N tasks =
N such Bash calls in one turn (or the `batch` subcommand, if this version has one —
see `--help`). The `opencode-rescue` subagent costs **~10k Claude tokens** of fixed
overhead vs **~200** for a direct call — reserve it for delegations needing
multi-step reasoning (probe → decide → re-dispatch) or a long result that must be
summarized down.

## Iron rules

- **The run is UNATTENDED — a question kills it.** Nobody answers; the run hangs
  until the watchdog kills it and the retry hangs identically. Never write text
  that invites one ("let me know if…", "confirm before proceeding"). Any ambiguity
  → append the ready-made block from [references/unattended-run.md](references/unattended-run.md).
- **The task text is all OpenCode sees** (plus the repo). Restate every decision,
  path, and acceptance criterion from the Claude conversation. Forward the user's
  text byte-for-byte — length is not a problem, missing context is.
- **`plan` is the only read-only mode**; `build` (default) writes, and `--write` is
  not a real switch. Investigative wording ("diagnose", "research") does NOT mean
  read-only — only explicit intent ("review only", "don't change anything") does.
- **Never read `auth.json` or any credential file to find providers/models** — use
  `opencode models` or `setup`. See [references/model-and-credentials.md](references/model-and-credentials.md).
- **Routing flags must not appear in prose.** `--model`, `--agent`, `--worktree`,
  `--resume-last`, `--fresh`, `--background`, `--wait` are stripped from the task
  text wherever they occur — "run this with --worktree" does not survive. Pass them
  as flags. (Undeclared ones, e.g. "run git commit --no-verify", stay as text.)
- **One task per dispatch.** One job per invocation; bundling unrelated asks yields
  one blended, hard-to-recover result.

## References

- [unattended-run.md](references/unattended-run.md) — the no-question policy + the copy-paste follow-through block
- [model-and-credentials.md](references/model-and-credentials.md) — model refs, provider ids, credential rules, agent semantics
- [dispatch-layer.md](references/dispatch-layer.md) — what the layer injects for you (don't duplicate it), and how to shape the task
- [opencode-prompt-recipes.md](references/opencode-prompt-recipes.md) — concrete templates
- [opencode-prompt-antipatterns.md](references/opencode-prompt-antipatterns.md) — failure modes to avoid

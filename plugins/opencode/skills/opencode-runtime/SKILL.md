---
name: opencode-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# OpenCode Runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" <subcommand> …`
(`--help` lists every subcommand and flag). Prefer it over hand-rolled `git` or raw
OpenCode CLI strings.

## Delegate from the main loop — a subagent costs ~50x more

| How | Claude tokens | When |
| --- | --- | --- |
| main loop → `task --background "<task>"`, later `result <id>` | **≈200** | **Default.** Job id returns instantly; the main loop never blocks. |
| main loop → N × `task --background` in one turn (or `batch`, if present — see `--help`) | ≈200 × N | Parallel fan-out. |
| main loop → `wait-and-result "<task>"` (foreground Bash, `timeout: 600000`) | ≈200 + result | You want the answer in this turn. |
| `Task(opencode:opencode-rescue)` subagent | **≈10,000 fixed** | Only when the delegation needs multi-step reasoning (probe → decide → re-dispatch), or a very long result must be summarized before entering the main context. |

The ~10k is paid before any useful work happens. Four rescue subagents that each wrap
one Bash call burn ~40k and buy nothing over four Bash calls.

## Dispatch contract (inside the rescue subagent)

Forwarder, not orchestrator: **one** dispatch call, stdout returned unchanged, no repo
inspection, no follow-up work, never `setup`/`review`/`adversarial-review`/`cancel`.

- **Subcommand:** `wait-and-result` by default (blocks, prints the real result);
  `task --background` only if fire-and-forget was explicitly requested.
- **Foreground `Bash`, `timeout: 600000`** (the maximum). Never `run_in_background`;
  never reply "I'll check back later". A cut-off call on a long task is expected and
  recoverable — poll `result <id>` with the job id from the stderr dispatch line.
- **Task text byte-for-byte.** No summarizing, shortening, or paraphrasing.
- **Flags are routing controls, never task text**: `--model`, `--agent`, `--worktree`,
  `--background`/`--wait`, `--resume`/`--fresh`. Strip them from the text; map them
  onto the dispatch call.
- **Resume vs fresh is deterministic:** `--resume` → `--resume-last`; `--fresh` → not.
  Neither → resume only if the user's own words are clearly a follow-up ("continue",
  "keep going", "apply the top fix", "dig deeper"); **otherwise fresh. Fresh is the
  default.**
- **Write-capable by default.** `--agent plan` is the ONLY read-only mode and needs an
  explicit "don't change anything" / "review only" — investigative wording is not
  enough. Leave `--model` unset unless the user named one.
- **Never ask a question.** No `AskUserQuestion` here, no human watching: an
  unanswerable question stalls until the watchdog kills the run, and the retry stalls
  again. Ambiguity → take the low-risk reading, proceed, disclose in one line. Chose
  fresh over an existing resumable session? Prepend exactly:
  `Detected a resumable OpenCode session <id>; started a new session. To continue that session instead, re-run with --resume.`
- **Never read credential files.** List providers/models with `opencode models` or the
  `setup` subcommand — never `~/.local/share/opencode/auth.json`, `opencode.jsonc`, or
  any other token file (plaintext tokens; blocked; never necessary).

Full flag semantics, the cut-off/recovery flow, worktree isolation, and failure rules:
[references/dispatch-contract.md](references/dispatch-contract.md).

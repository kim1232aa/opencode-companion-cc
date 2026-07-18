# opencode-companion-cc

A **maintained, hardened** OpenCode delegation + review plugin for [Claude Code](https://claude.com/claude-code).

Delegate coding tasks — or run code reviews — from inside Claude Code to [OpenCode](https://github.com/anomalyco/opencode), pointed at **any OpenAI-compatible backend** (a local aggregator, DeepSeek, OpenRouter, Ollama, …). Background jobs, parallel fan-out, per-task model selection, session resume, and status/result/cancel management included.

> **Why this fork exists.** It is a direct fork of
> [tasict/opencode-plugin-cc](https://github.com/tasict/opencode-plugin-cc)
> (Apache-2.0), which itself adapts
> [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) to OpenCode.
> The upstream and its known forks are unmaintained and carry a number of real
> bugs (silent prompt truncation, a 5-minute hang on long tasks, an ineffective
> read-only switch, lost job state under concurrency, and more). This
> distribution consolidates the best fixes from the fork ecosystem
> ([suharvest](https://github.com/suharvest/opencode-plugin-cc),
> [JohnnyVicious](https://github.com/JohnnyVicious/opencode-plugin-cc)),
> adds original fixes, and — crucially — ships tests for the modules where those
> bugs actually lived. See **[docs/WHATS-FIXED.md](docs/WHATS-FIXED.md)** and the git log.

## What You Get

- **Task delegation** (`/opencode:rescue`) — foreground with the real result, background with a job id, or a parallel **batch** fan-out; per-task `--model`, read-only `--agent plan`, session **resume**, git-worktree **isolation**, and an output **budget** that keeps answers brief by default.
- **Reviews** (`/opencode:review`, `/opencode:adversarial-review`) — read-only reviews of the working tree or a branch diff, backed by a real JSON output schema; the adversarial variant takes free-form focus text.
- **Job management** (`/opencode:status`, `/opencode:result`, `/opencode:cancel`) — live token heartbeat, the commands OpenCode is actually running, crash-safe result recovery, cancel-all.
- **The `occ` terminal CLI** — a live cross-repo panel of every delegation, for **zero Claude tokens**.
- Every run ends with a one-line **token/model/session trailer**; all delegated work is billed to the OpenCode-side backend, not your Claude quota.

## Requirements

- [Claude Code](https://claude.com/claude-code) (CLI, desktop app, or IDE extension)
- [OpenCode](https://github.com/anomalyco/opencode) installed (`npm i -g opencode-ai` or `brew install opencode`)
- A configured AI provider in OpenCode (see [Install](#install))
- Node.js 18.18 or later

## Install

```
/plugin marketplace add kim1232aa/opencode-companion-cc
/plugin install opencode@opencode-companion-cc
/reload-plugins
```

Then verify:

```
/opencode:setup
```

### Pointing OpenCode at any OpenAI-compatible endpoint

Add a custom provider to `~/.config/opencode/opencode.jsonc`. Example for a
local OpenAI-compatible aggregator on port 20129:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "my-endpoint/some-model",
  "provider": {
    "my-endpoint": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "my-endpoint",
      "options": {
        "baseURL": "http://localhost:20129/v1",
        "apiKey": "sk-..."
      },
      "models": {
        "some-model": { "tool_call": true }
      }
    }
  }
}
```

Then delegate with `/opencode:rescue --model my-endpoint/some-model "…"`.

> **Note:** `opencode serve` caches config at startup. After editing
> `opencode.jsonc`, restart the daemon (kill the running `opencode serve`) for
> changes to take effect.

### Uninstall

```
/plugin uninstall opencode@opencode-companion-cc
/reload-plugins
```

## Usage

### Delegate a task — `/opencode:rescue`

```
/opencode:rescue fix the failing tests in src/parser
/opencode:rescue --background --model my-endpoint/some-model "translate README.md to Japanese"
/opencode:rescue --agent plan "explain how the retry logic in lib/http.mjs works"   # read-only
```

- **Foreground (default):** blocks and prints the real result plus the token trailer.
- **`--background`:** returns a job id instantly; collect later with `/opencode:result`.
- **`--agent plan`** is the only read-only mode; the default `build` agent has full write access.
- **`--resume`** continues this session's last OpenCode session (the code it already read stays cached — follow-ups are ~10× faster); `--fresh` forces a new one. Only completed/running jobs are resume candidates.
- **`--worktree`** runs a write task in an isolated throwaway git worktree and applies the changes back — a concurrent editing session can't be clobbered, and a failed apply preserves the worktree + patch instead of reporting false success.
- **Output budget:** answers are `--brief` by default (the answer re-enters Claude's context every turn; the work itself is free). `--full` lifts it, `--max-words <n>` caps it hard.

Fan out several independent tasks in ONE command with `batch` (per-item flags after each `--task`):

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/opencode-companion.mjs" batch \
  --task "add JSDoc to lib/args.mjs" \
  --task "write a unit test for parseModelRef" --model my-endpoint/other-model
```

### Reviews — `/opencode:review` and `/opencode:adversarial-review`

```
/opencode:review --base main            # branch diff vs main (working tree if omitted)
/opencode:adversarial-review focus on the cancel/retry race conditions
```

Both are strictly read-only (`plan` agent), honor `--model` and the output-budget
flags, and hand the model the actual review-output JSON schema so the findings
render structurally. `review` takes no free text and rejects unknown flags
(a typo like `--bsae` fails fast instead of silently reviewing the wrong scope);
`adversarial-review` treats everything after the flags as focus text.

### Manage jobs — `status` / `result` / `cancel`

```
/opencode:status        # live heartbeat: token count climbing = generating; frozen = stuck
/opencode:result        # newest finished job (or: result <job id>)
/opencode:cancel        # no id = cancel ALL of this session's running jobs
```

- `status` shows the OpenCode-side commands each job is running (`bash: npm test` …), so you can tell *working* from *wedged*.
- If a background worker dies (OOM, kill), `status`/`result` probe the server and **recover the finished answer** instead of losing it.
- `cancel` aborts the server session, kills the detached worker's process group, and never leaves partial output behind.

### The `occ` CLI — watch delegations from a terminal, for zero Claude tokens

The companion is a plain Node CLI, so you can drive it from a terminal instead of
from Claude. Install a short launcher once:

```bash
/opencode:setup --install-cli          # writes ~/.local/bin/occ
```

It refuses to shadow an existing command (`occ`, not `oc` — that one is the
OpenShift CLI); pass `--cli-name <name>` for another name, `--uninstall-cli` to
remove it. The launcher resolves the newest installed plugin version at run
time, so upgrading the plugin never breaks it.

```bash
occ watch                   # LIVE panel of every delegation, in EVERY repo
occ watch --workspace ~/code/api   # …or just one, without cd-ing there
occ status                  # this repo's jobs, once
occ result <job id>
```

`occ watch` is the cross-repo view — job state is stored per workspace, so plain
`status` only sees the repo you are standing in. `watch` aggregates every
workspace and tags each row with its repo:

```
OpenCode delegations · live — refreshed 05:06:50, every 3s · Ctrl-C to exit
2 running · all workspaces · 4 repos
────────────────────────────────────────────────────────────────────────
## Running Jobs (2)

- 🟢 [api] **task-mrkz-c3d4** (task) · editing · 4m 12s · 6,001 OpenCode tokens
- 🟢 [opencode-companion-cc] **task-mrky-a1b2** (task) · investigating · 2m 3s · 14,203 OpenCode tokens
  ↳ bash: npm test

## ❌ Failed (1)

- ❌ [MiroFish] **task-mrkb-g7h8** (task) — failed — 1m 30s
  Error: worker (pid 4242) exited without completing
```

It reads local job state only — no server probe, no writes — so it never
disturbs the jobs it shows, and it costs zero Claude tokens.

## Typical Flows

**Quick question, answer this turn.** Foreground `/opencode:rescue --agent plan "…"` — blocks a few seconds, prints the answer and the trailer. Done.

**Long task, keep working, get woken on completion.** Dispatch with `--background`, then run `wait-and-result <job id>` in a *tracked background shell* (Claude Code's `run_in_background`). The shell exits when the job finishes, and the harness notifies the conversation — this is the only wake-up mechanism; bare `--background` never calls back. (The dispatch output prints this exact recipe.)

**Parallel fan-out.** One `batch` command with N `--task` items runs N concurrent workers and prints all results with one summary — the cheapest way to run independent subtasks.

**Iterating on one codebase.** First delegation reads the code (slow); follow-ups with `--resume` reuse that session's cache — measured ~10× faster with ~96% cache-read on real runs.

**Pre-merge review.** `/opencode:review --base main --background`, keep working, `/opencode:result` when it lands.

## Delegation Cost — dispatch from the main loop, not from a subagent

Delegating is a **Bash call**, not a reasoning task. Route it accordingly:

| How you delegate | Claude tokens | Use it when |
| --- | --- | --- |
| Main loop → `task --background "<task>"`, later `result <id>` | **≈200** | **Default.** Returns a job id instantly; the main loop never blocks. |
| Main loop → N × `task --background` in one turn (or `batch`) | ≈200 × N | Parallel fan-out of independent tasks. |
| Main loop → `wait-and-result "<task>"` (foreground Bash) | ≈200 + result | You want the answer in this turn. |
| Main loop → `task --background`, then `wait-and-result <id>` in a background shell | ≈200 + result on wake | Notify-on-completion for long tasks. |
| `Task(opencode:opencode-rescue)` subagent | **≈10,000 fixed** | Only when the delegation itself needs multi-step reasoning, or a very long result must be summarized before entering the main context. |

The subagent's ~10k is paid **before any useful work happens**. Four parallel
rescue subagents that each wrap a single `Bash` call burn ~40k Claude tokens and
buy nothing over four `Bash` calls.

`opencode-companion.mjs --help` lists every subcommand and flag.

## Configuration

| Env var | Default | What it does |
| --- | --- | --- |
| `OPENCODE_SERVER_PORT` | `4096` | Port of the managed `opencode serve` daemon (dispatch, recovery, and cancel all agree on it). |
| `OPENCODE_COMPANION_PROMPT_TIMEOUT_MS` | 30 min | Hard wall-clock cap on a single prompt turn. |
| `OPENCODE_COMPANION_WAIT_TIMEOUT_MS` | 35 min | How long `wait-and-result` waits before giving up (the job keeps running). |
| `OPENCODE_COMPANION_DATA` | plugin data dir | Override the job-state directory (also how two frontends can share one store). Normal installs store state under the plugin's own data dir; tmpdir is only the last-resort fallback for source checkouts. |
| `OPENCODE_COMPANION_VERBOSE_TRAILER` | off | `1` restores the multi-line token breakdown instead of the one-line trailer. |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | unset | Basic auth for the loopback server (loopback HTTP — see KNOWN_ISSUES). |

**Review gate:** `/opencode:setup --enable-review-gate` turns on the (always
installed, default-pass) Stop hook so it runs a targeted OpenCode review on
Claude's response and blocks the stop if issues are found. **Off by default** — it can loop long and drain usage limits.

## FAQ

**Claude Code shows "↓ N tokens" — is the delegation costing me Claude tokens?**
No. That number is what the *turn* cost the host. The delegated work runs on the
OpenCode backend; the trailer's token line is that OpenCode-side usage. Only the
returned *answer text* enters your Claude context (which is why answers are
brief by default).

**My foreground call was cut off at 10 minutes.**
That's the Bash tool's ceiling, not a failure — Claude Code moves the call to
the background without signaling it, the detached worker keeps running, and the
dispatch line printed the job id: collect with `/opencode:result <id>`. (A
SIGTERM/SIGINT cut-off — pressing `x`/Ctrl-C — CANCELS the job instead; that's
the deliberate cancel semantics. Expect >10 min? use `--background` + the
notify-on-completion flow above.)

**What happens if the worker or the server dies mid-task?**
`status`/`result` probe the server and recover a finished answer (marked
`recovered`); a still-generating session keeps the job alive; only a genuinely
lost run reconciles to `failed` — with the reason in the job log.

**My model id contains slashes — how do I write the ref?**
`<providerID>/<modelID>`, split on the FIRST slash; the model id may itself
contain slashes (`my-endpoint/org/model-x`). The provider id comes from your
`opencode.jsonc` — not necessarily the display name OpenCode's UI shows. A ref
that only dropped the provider prefix is auto-fixed when unambiguous.

**Does `cancel` really stop the work?**
Yes — it marks the job canceled, aborts the OpenCode session server-side
(time-bounded), and TERM→KILLs the detached worker's process group. Partial
output is not preserved.

**Why is the answer so short?**
Brief mode is the default on purpose: the answer re-enters Claude's context on
every later turn, so an unbounded answer is the one part of a delegation that
keeps costing. Use `--full` or `--max-words <n>` when you need the long form.

## Architecture

The plugin talks to `opencode serve` over its HTTP REST API. The long-lived
prompt POST uses `node:http` (not global `fetch`) to avoid undici's hidden 5-min
body timeout; short control calls use `fetch`. The server is auto-started and
managed by the companion scripts. Background tasks run as detached workers whose
state is tracked on disk (0700/0600). A stall watchdog aborts turns with no
token progress and retries on a fresh session; crash recovery salvages finished
answers from the server.

## Development

```
npm test          # full suite; includes a parity gate that fails if the shared
                  # lib drifts from the sibling opencode-companion-codex repo
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This is a derivative work; attribution to the upstream projects and the forks
whose fixes are included is recorded in [NOTICE](NOTICE) per Apache-2.0 §4(b).

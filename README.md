# opencode-companion-cc

A **maintained, hardened** OpenCode delegation + review plugin for [Claude Code](https://claude.com/claude-code).

Delegate coding tasks — or run code reviews — from inside Claude Code to [OpenCode](https://github.com/anomalyco/opencode), pointed at **any OpenAI-compatible backend** (a local aggregator, DeepSeek, OpenRouter, Ollama, …). Background jobs, per-task model selection, and status/result/cancel management included.

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
> bugs actually lived. See **[What's Fixed](#whats-fixed-vs-upstream)**.

## What You Get

- `/opencode:rescue` — delegate a task to OpenCode (`--model`, `--agent`, `--resume`, `--fresh`, `--background`, `--worktree`). Blocks and returns the actual result by default (via `wait-and-result`); `--background` is fire-and-forget.
- `/opencode:review` / `/opencode:adversarial-review` — read-only or steerable challenge reviews (both now honor `--model`)
- `/opencode:status`, `/opencode:result`, `/opencode:cancel` — manage background jobs
- `/opencode:setup` — check install/auth, toggle the review gate

Every delegated run also reports OpenCode-side **token usage and cost** (input / output / reasoning / cache, plus turn count and `$` when the backend prices it). Write-capable runs can opt into `--worktree` for **git-worktree isolation** so a concurrent editing session can't be clobbered by OpenCode's snapshot/undo.

## Requirements

- [Claude Code](https://claude.com/claude-code) (CLI, desktop app, or IDE extension)
- [OpenCode](https://github.com/anomalyco/opencode) installed (`npm i -g opencode-ai` or `brew install opencode`)
- A configured AI provider in OpenCode (see below)
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

## What's Fixed vs upstream

| Area | Bug in upstream | Fix |
|---|---|---|
| Long tasks | Any task &gt;5 min died with an opaque `fetch failed` — Node's bundled undici has a hidden 300 s `bodyTimeout` that `AbortSignal.timeout()` cannot override | Prompt POST goes through `node:http` (no default body timeout), bounded only by an explicit, env-tunable wall-clock timer |
| Model routing | Current OpenCode REST requires `model` as a `{providerID, modelID}` object; the plugin sent a raw string → every `--model` call 400'd | `parseModelRef()` splits on the first `/` and sends the object form |
| Read-only | `--write` was a dead flag that always evaluated true; even `--agent plan` left the runtime believing it had write access | `isWrite` derived from the resolved agent (`plan` ⇒ read-only) |
| Prompt fidelity | The rescue subagent was permitted to "tighten" the prompt, silently compressing long task text before forwarding | Byte-for-byte forwarding mandated in both the agent def and its runtime skill |
| `--model` in reviews | `/opencode:review` / `--adversarial-review` parsed only `--base`; `--model` was swallowed | `--model` threaded through both review handlers |
| Provider list | `/opencode:setup` assumed `/provider` returned an array; new OpenCode returns `{all, default, connected}` → always empty | Handles both shapes |
| Headless permission hang | An `external_directory` (or other) permission prompt in a headless dispatch is never answerable → 5–10 min hang | A watcher polls `/permission` and auto-rejects un-answerable prompts, so the agent gets a normal tool-error it can react to |
| Concurrent job state | Unlocked read-modify-write of `state.json` lost job updates under parallel background jobs (~1/3 of the time at 5–8 concurrent) | A filesystem lock (`withFileLock`) serializes state writes |
| websearch | The `websearch` tool is a no-op on custom providers unless `OPENCODE_ENABLE_EXA=1` | Set on the managed `opencode serve` process |
| No token visibility (2.0.1) | `extractResponseText` discarded `response.info`, so the OpenCode-side token/cost of a delegated run was never surfaced | `getSessionUsage()` sums assistant-message `tokens`/`cost` across the session; every dispatch path renders a token-usage line (derives `total` when a build omits it) |
| Recycled-PID kill (2.0.1) | `cancel` and the stranded-job reaper checked only pid *liveness*; a reused pid could be signalled/mis-reconciled — and the comment falsely claimed an ownership check | `pidStartTime()` fingerprints the worker via `/proc/<pid>/stat` field 22; `isOwnedProcessAlive()` only treats a pid as ours when the start-time matches (bare-liveness fallback off-Linux) |
| Untracked background pid (2.0.1) | `rescue --background` never recorded its detached worker's pid, so `cancel` couldn't stop it and death-detection couldn't fire | The pid + start-time are persisted for background jobs too |
| Worktree isolation (2.0.1) | Running `build` in a live repo let OpenCode's git snapshot/undo revert unrelated concurrent edits; a first cut piped the patch via a stdin that `runCommand` ignores → nothing applied back | Opt-in `--worktree` runs in a throwaway detached worktree, then applies the captured patch back through a temp file (refusing a truncated/oversized diff), surfacing conflicts instead of clobbering |
| Dead `--scope` flag (2.0.1) | `/opencode:review` advertised `--scope auto\|working-tree\|branch` but the value was parsed and never used | Removed from parsing and docs; `--base` is the real control |
| File-lock stolen from a live holder (2.0.2) | `withFileLock` reclaimed a lock on 60s mtime age even when the owner pid was provably alive — breaking mutual exclusion for any critical section >60s (contradicting its own doc comment) | Owner token now carries a `pid:start:nonce` fingerprint; reclaim only when the holder is dead or the pid was recycled (start-time mismatch), never on age while it's the same live process |
| `cancel` clobbers a finished job (2.0.2) | A worker could complete during `cancel`'s async `abortSession`, then `cancel` unconditionally overwrote its status → a completed job mislabeled `canceled` | Re-reads the job before writing; leaves a terminal status untouched |
| Spawn failure hangs for the full timeout (2.0.2) | If the detached worker failed to spawn (no pid), `wait-and-result` had nothing to poll and blocked up to 35 min before reporting timeout | Fails fast when the child has no pid, marking the job failed immediately (both foreground-wait and background paths) |
| Value option ate the next flag (2.0.2) | `--model --write` set `model="--write"` and silently dropped `--write`, later throwing in `parseModelRef` | `parseArgs`/`extractTaskText` refuse to consume a `--`-prefixed token as a value |
| Worktree silent data loss (2.0.2) | `withWorktree` didn't check `git add`/`git diff` exit codes; a failure yielded an empty patch and the task's changes were deleted with the worktree | Checks both exit codes, preserves the worktree, and raises instead of discarding; also runs in the matching subdir when `dir` is a repo subpath, and gives `runCommand` a total timeout + SIGKILL escalation |
| Cost as numeric string dropped (2.0.2) | `getSessionUsage` counted `info.cost` only when `typeof === "number"`, silently zeroing a `"0.0123"`-style string | Lenient `Number()` + `Number.isFinite` parse |
| Dead worker lost its result (2.0.3) | A background worker hard-killed (SIGKILL/OOM) after sending its prompt couldn't write a result; the finished OpenCode session's output was unreachable and the job showed a phantom "running" | `status`/`result` now probe the server (`getSessionResult`) and salvage a dead worker's answer, marking the job `completed` (flagged `recovered`) before reconciling the rest to `failed` |
| Foreign service mistaken for the server (2.0.3) | `isServerRunning` treated any 200 on `/global/health` as "OpenCode is up", so an unrelated service squatting on the port could receive dispatched sessions | Response must carry OpenCode's `{ healthy, version }` shape to count as the server |

Additional hardening (background-job self-heal, recursive-delegation guard,
error classification, and expanded test coverage) is consolidated from the
suharvest and JohnnyVicious forks — see the [NOTICE](NOTICE) file for attribution.

## Slash Commands

- `/opencode:rescue` — delegate a task via the `opencode:opencode-rescue` subagent. Blocks and returns the real result by default; `--background` is fire-and-forget. `--model <provider/model>`, `--agent <build|plan>`, `--resume`, `--fresh`, `--background`, `--worktree`.
- `/opencode:review` — read-only OpenCode review. `--base <ref>`, `--model <id>`, `--wait`, `--background`.
- `/opencode:adversarial-review` — steerable challenge review; accepts custom focus text. `--model <id>`.
- `/opencode:status` / `/opencode:result` / `/opencode:cancel` — manage background jobs.
- `/opencode:setup` — check OpenCode install/auth; enable/disable the review-gate hook.

## Review Gate

When enabled via `/opencode:setup --enable-review-gate`, a Stop hook runs a
targeted OpenCode review on Claude's response and blocks the stop if issues are
found. It is **off by default**; note it can create long-running loops and drain
usage limits when on.

## Architecture

The plugin talks to `opencode serve` over its HTTP REST API. The long-lived
prompt POST uses `node:http` (not global `fetch`) to avoid undici's hidden 5-min
body timeout; short control calls use `fetch`. The server is auto-started and
managed by the companion scripts. Background tasks run as detached workers whose
state is tracked on disk under `CLAUDE_PLUGIN_DATA`.

## Development

```
npm test          # run the test suite
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This is a derivative work; attribution to the upstream projects and the forks
whose fixes are included is recorded in [NOTICE](NOTICE) per Apache-2.0 §4(b).

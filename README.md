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

- `/opencode:rescue` — delegate a task to OpenCode (`--model`, `--agent`, `--resume`, `--fresh`, `--background`, `--worktree`). Blocks and returns the actual result by default (via `wait-and-result`); `--background` is fire-and-forget. A transient 500 / dropped connection / stall is retried on a fresh session; the run ends with a **one-line token/model/session trailer**.
- `/opencode:review` / `/opencode:adversarial-review` — read-only or steerable challenge reviews (both honor `--model`); the model is handed the real review-output JSON schema.
- `/opencode:status`, `/opencode:result`, `/opencode:cancel` — manage background jobs. `status` shows a **live token heartbeat and the commands OpenCode is actually running** (bash/edit/read); `cancel` with no job id cancels **all** of the session's running jobs.
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
| Dead worker lost its result (2.0.3) | A background worker hard-killed (SIGKILL/OOM) after sending its prompt couldn't write a result; the finished OpenCode session's output was unreachable and the job showed a phantom "running" | `status`, `result`, the SessionEnd hook, and `wait-and-result` now probe the server (`getSessionResult`) and salvage a dead worker's answer, marking the job `completed` (flagged `recovered`) before reconciling the rest to `failed` |
| Recovery correctness (2.0.3) | Naively taking the session's last assistant text could recover a half-generated turn, an errored turn, or (on a reused `--resume-last` session) the *previous* task's answer; and a still-generating session was failed prematurely | Only a turn with `time.completed` set, no `info.error`, and `time.created` newer than the job's dispatch is recovered; a still-active session keeps the job alive (`awaitingServer`) instead of failing it; probes use a short timeout after one health check, so `status` can't block for minutes |
| Foreign service mistaken for the server (2.0.3) | `isServerRunning` treated any 200 on `/global/health` as "OpenCode is up", so an unrelated service squatting on the port could receive dispatched sessions | Requires `healthy === true` (a `{ healthy: false }` or foreign 200 no longer counts); server port unified across dispatch and recovery via `OPENCODE_SERVER_PORT` |
| Worktree destroyed a failed task's changes (2.0.5) | If the task errored (HTTP timeout, API error) AFTER modifying files, the worktree was still removed — partial changes silently destroyed; a failed `git worktree add` also silently ran in the live workspace, defeating the requested isolation | A failing task preserves the worktree (path reported); a failed worktree add now errors instead of falling back |
| Cold-start hang & lingering half-started server (2.0.5) | After spawning `opencode serve`, the dispatcher's open stdout/stderr pipes kept the Node event loop alive — it finished its work then hung instead of exiting; a startup timeout also left the half-started child running | Pipes are destroyed once startup resolves; a timed-out startup SIGTERMs the child |
| `cancel` could kill the user's live call (2.0.5) | A foreground job's recorded pid is the dispatcher itself, so a cancel from another session SIGTERMed the user's in-flight Bash call; the terminal-status check also raced outside the lock | Only detached background workers are signalled (foreground runs are stopped via `abortSession`); the canceled write is now a compare-and-set inside the state lock |
| Review false-green on staged/untracked work (2.0.5) | Working-tree review ran plain `git diff` (unstaged only) — a staged-only change set reviewed as "no changes"; git failures returned empty context instead of erroring; `--base` was spliced into git argv unvalidated (option injection) | Diffs against `HEAD` (staged+unstaged), git failures throw, and `--base` must match a safe-ref pattern |
| Task text corruption (2.0.5) | `extractTaskText` stripped EVERY `--token`, so a task like "run git commit --no-verify" lost `--no-verify` — breaking the byte-for-byte forwarding promise | Only declared routing flags are stripped; unknown `--tokens` stay in the task text |
| Grandchild processes wedged the caller (2.0.5) | Timeout/overflow kills signalled only the direct child; a `sh -c '…'` grandchild kept the output pipes open and `close` never fired | Children run in their own process group; kills signal the whole group (SIGTERM→SIGKILL) |
| Assorted (2.0.5) | `--fresh` didn't override `--resume-last`; recovery probes could still block on a slow usage call; a missing `time.created` slipped past the dispatch-time filter; SessionEnd hook's 5s timeout was shorter than recovery itself; `/result` could fall back to another session's job; state fell into world-readable `/tmp`; three dead client methods formed a false capability surface | All fixed: fresh override, 8s probe timeouts, strict since-filter, 60s hook timeout, strict session scoping, 0700/0600 state permissions, dead APIs removed |
| Token progress heartbeat (2.0.5) | During a 15–30 min generation the job log only changed on phase transitions, so `status` couldn't distinguish "generating" from "stuck" | The worker logs `heartbeat: N tokens so far` every 30s (live server poll); watch it climb via `/opencode:status` |
| Intermittent failures aborted the run (2.1.0) | A transient OpenCode 500, a dropped connection, or a stall (no token progress) failed the whole delegation, even though these are intermittent | `dispatchWithRetry` retries up to 3× on a fresh session (one interval both heartbeats and trips the stall watchdog); an empty turn is still failed immediately — it's deterministic, and retrying only re-burns cached input |
| Cancel re-ran the task (2.1.0) | An external cancel aborted the OpenCode session, which surfaced to the retry loop as a transient throw — so a (possibly write) task was re-run on a fresh session | Cancel marks the job canceled in shared state; `dispatchWithRetry`'s `shouldStop` check observes it and aborts with `Delegation canceled` instead of retrying |
| Opaque subtasks (2.1.0) | `status` showed only a token count, so you couldn't see what OpenCode was doing | The dispatch heartbeat streams OpenCode's own tool calls (bash/edit/read) into the job log; `status` shows the latest ones next to the token heartbeat |
| Verbose trailer (2.1.0) | Every delegated run ended with a multi-line `---`/Tokens/Model/session footer | Collapsed to a single-line trailer (model-mismatch ⚠️ and empty-output warnings preserved); the full breakdown stays in `/opencode:result`, or set `OPENCODE_COMPANION_VERBOSE_TRAILER=1` |
| Unbacked review schema (2.1.0) | The review prompts said "return JSON matching the review-output schema" but never actually included the schema | `buildReviewPrompt` appends the real schema (best-effort file read, compact inline fallback) so the model's output matches what the renderer consumes |
| Session-scoping no-op + audit fixes (2.1.0) | `getClaudeSessionId` read a non-existent `CLAUDE_SESSION_ID`, so per-session scoping silently matched nothing; the Stop-gate hook mis-parsed stdin; a review-prompt placeholder could be expanded from injected diff/focus text | Reads the real `CLAUDE_CODE_SESSION_ID`; the hook safely takes `last_assistant_message`; template placeholders are filled in a single pass |

Additional hardening (background-job self-heal, recursive-delegation guard,
error classification, and expanded test coverage) is consolidated from the
suharvest and JohnnyVicious forks — see the [NOTICE](NOTICE) file for attribution.

## Delegation Cost — dispatch from the main loop, not from a subagent

Delegating is a **Bash call**, not a reasoning task. Route it accordingly:

| How you delegate | Claude tokens | Use it when |
| --- | --- | --- |
| Main loop → `task --background "<task>"`, later `result <id>` | **≈200** | **Default.** Returns a job id instantly; the main loop never blocks. |
| Main loop → N × `task --background` in one turn | ≈200 × N | Parallel fan-out of independent tasks. |
| Main loop → `wait-and-result "<task>"` (foreground Bash) | ≈200 + result | You want the answer in this turn. |
| `Task(opencode:opencode-rescue)` subagent | **≈10,000 fixed** | Only when the delegation itself needs multi-step reasoning (probe → decide → re-dispatch), or a very long result must be summarized before it enters the main context. |

The subagent's ~10k is paid **before any useful work happens** — it is the agent
definition, its skills, and the subagent's own turns; the real work runs on
OpenCode and costs OpenCode tokens either way. Four parallel rescue subagents that
each wrap a single `Bash` call burn **~40k Claude tokens** and buy nothing over
four `Bash` calls. The wrapper only pays for itself when it absorbs more context
than it costs.

`opencode-companion.mjs --help` lists every subcommand and flag.

## Slash Commands

- `/opencode:rescue` — delegate a task to OpenCode. Dispatches directly from the main loop (no subagent). Blocks and returns the real result by default; `--background` is fire-and-forget. `--model <provider/model>`, `--agent <build|plan>`, `--resume`, `--fresh`, `--background`, `--worktree`.
- `/opencode:review` — read-only OpenCode review. `--base <ref>`, `--model <id>`, `--wait`, `--background`.
- `/opencode:adversarial-review` — steerable challenge review; accepts custom focus text. `--model <id>`.
- `/opencode:status` / `/opencode:result` / `/opencode:cancel` — manage background jobs.
- `/opencode:setup` — check OpenCode install/auth; enable/disable the review-gate hook; install the `occ` CLI launcher.

## The `occ` CLI — watch delegations from a terminal, for zero Claude tokens

The companion is a plain Node CLI, so you can drive it from a terminal instead of
from Claude. Install a short launcher once:

```bash
/opencode:setup --install-cli          # writes ~/.local/bin/occ
```

It refuses to shadow an existing command (`occ`, not `oc` — that one is the
OpenShift CLI); pass `--cli-name <name>` if you want another name, and
`--uninstall-cli` to remove it. The launcher **resolves the newest installed
plugin version at run time**, so upgrading the plugin never breaks it — no version
is baked in.

```bash
occ watch                   # LIVE panel of every delegation, in EVERY repo
occ watch --workspace ~/code/api   # …or just one, without cd-ing there
occ status                  # this repo's jobs, once
occ result <job id>
```

`occ watch` is the cross-repo view: job state is stored per workspace, so
`status --watch` only ever sees the repo you are standing in — a delegation
dispatched from another repo simply never showed up. `watch` aggregates them all
and tags each row with the repo it belongs to:

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

It reads local job state only — no server probe, no writes — so it never disturbs
the jobs it is showing you, and it costs **zero Claude tokens**.

Every token number it prints is OPENCODE-side usage: the work you delegated. It
is not billed to your Claude context or quota.

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

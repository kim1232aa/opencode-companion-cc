# Dispatch contract — full details

Everything the `opencode-runtime` SKILL.md compresses into one-liners. Read this
when a dispatch behaves unexpectedly, or when you need the exact semantics of a
flag before passing it through.

## Choosing the delegation shape (cost first)

| Shape | Claude-token cost | When |
| --- | --- | --- |
| Main loop → `task --background "<task>"`, later `result <id>` | ≈200 | **Default.** Returns a job id instantly; the main loop never blocks. |
| Main loop → N × `task --background` in one turn (or `batch`, if this version has it — check `--help`) | ≈200 × N | Parallel fan-out of independent tasks. |
| Main loop → `wait-and-result "<task>"` (foreground Bash, `timeout: 600000`) | ≈200 + the result | You want the answer in this turn and are willing to block the Bash call. |
| `Task(opencode:opencode-rescue)` subagent | **≈10,000 fixed** | Only when the delegation needs multi-step reasoning (probe → decide → re-dispatch), or a very long result must be boiled down to a summary before it enters the main context. |

The subagent's ~10k is paid **before any useful work happens** — it is the agent
definition, its skills, and the subagent's own turns. Four parallel rescue
subagents that each wrap a single Bash call burn ~40k Claude tokens and add
nothing over four Bash calls.

## Subcommand selection inside the subagent

- `wait-and-result` — default. Dispatches on a tracked detached worker, BLOCKS
  until the task finishes, prints the full result. You return real output, not a
  job id.
- `task --background` — only when fire-and-forget was explicitly requested.
  Prints a job id immediately; the user fetches it later with `/opencode:result`.
- Exactly **one** dispatch invocation per handoff. Never `setup`, `review`,
  `adversarial-review`, `status`, `result`, or `cancel` from the rescue subagent
  (the one exception is the cut-off recovery below).

## The 10-minute cut-off and how to recover

- Run `wait-and-result` as a **foreground, blocking `Bash` call with
  `timeout: 600000`** — 10 minutes is the Bash tool's maximum; you cannot set
  more.
- The companion itself waits up to **35 minutes** internally (override with
  `--timeout-ms` or `OPENCODE_COMPANION_WAIT_TIMEOUT_MS`). So a task longer than
  10 minutes **will** have its Bash call cut off. **That is expected, not a
  failure**, and the recovery flow is designed for it:
  1. The command prints `[opencode] job <id> dispatched…` to stderr at the start.
     Keep that id.
  2. The detached worker keeps running after the Bash call dies.
  3. Poll with further `Bash` calls to `result <id>` (checking `status` in
     between — the job log shows `heartbeat: N tokens so far` while the model is
     still generating) until the result is ready, then return it.
- **Never** run the dispatch with `run_in_background`, and **never** answer with
  "I'll wait for the result" / "I'll check back later". Either return the
  blocking call's stdout, or actively fetch it with `result <id>`.

## Flag semantics

All of these are Claude-side routing controls. Strip them from the task text and
map them onto the dispatch call — never let them survive into the prose OpenCode
receives.

- `--background` / `--wait` — execution mode only. They select the subcommand
  (`task --background` vs `wait-and-result`) and are not passed through as text.
- `--model <provider/model>` — pass through. Leave unset by default; only add it
  when the user explicitly asked for a model.
- `--agent <build|plan>` — pass through. `build` (default) is write-capable;
  `plan` is the **only** read-only mode. There is no working `--write` /
  no-write flag. Add `plan` only on explicit user intent ("don't change
  anything", "just review", "no edits"). Do **not** infer read-only from
  investigative wording ("diagnose", "research", "look into") — such requests
  usually precede a fix, and the default is write-capable.
- `--worktree` — pass through. For a write task on a repo where other edits may
  be happening concurrently, it runs OpenCode inside an isolated git worktree so
  its snapshots cannot revert unrelated concurrent changes; the companion applies
  the result back afterwards. Accepted by both `wait-and-result` and `task`.
- `--resume` → add `--resume-last` to the dispatch call, even if the request
  text sounds ambiguous.
- `--fresh` → dispatch a fresh run (no `--resume-last`), even if the request
  sounds like a follow-up.
- Neither present → decide deterministically: `--resume-last` only if the user's
  own words are clearly a follow-up ("continue", "keep going", "resume", "apply
  the top fix", "dig deeper"). Otherwise **fresh** — fresh is the default.

## Never ask a question — why it is fatal, not just annoying

The rescue subagent has only `Bash`. There is no `AskUserQuestion` tool in it,
and no human is watching a dispatch. A question waits for an answer that never
comes: the run stalls until the stall watchdog kills it, the retry stalls the
same way, and the spend is burned for nothing.

- If something is ambiguous — resume-vs-fresh, which file, which of two readings
  of the request — pick the most reasonable low-risk interpretation, proceed, and
  state the assumption in one line. Do not stall, and do not silently guess
  without disclosing.
- When a resumable session existed and you chose fresh anyway, prepend exactly
  one line to the forwarded stdout:
  `Detected a resumable OpenCode session <id>; started a new session. To continue that session instead, re-run with --resume.`
  That routing line is the only text you may ever add.

## Credentials

- To list providers or models: the plugin's `setup` subcommand, or
  `opencode models`. Those are the only two supported ways.
- **Never read `~/.local/share/opencode/auth.json`, `opencode.jsonc`, or any
  other credential/token file to discover providers.** They hold plaintext
  tokens; reading them is blocked by the permission layer (correctly) and is
  never necessary — `setup` / `opencode models` already returns the real ids.

## Safety and failure rules

- Default to write-capable OpenCode work unless the user explicitly asked for
  read-only.
- Preserve the user's task text as-is apart from stripping routing flags. Never
  summarize, shorten, paraphrase, or "tighten" it, no matter how long it is —
  OpenCode needs the full detail, and length is not a reason to compress.
- Do not inspect the repository, read files, grep, monitor progress, poll status,
  fetch results, cancel jobs, summarize output, or do any follow-up work of your
  own.
- Return the stdout of the dispatch command exactly as-is, including the trailing
  token-usage line the companion appends. No commentary before or after it.
- If the Bash call fails or OpenCode cannot be invoked, return nothing.

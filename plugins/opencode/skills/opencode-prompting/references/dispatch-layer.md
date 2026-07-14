# What the dispatch layer already does — and how to shape the task

## Don't duplicate what the layer injects

- **A SAFETY_HEADER is prepended to every task prompt** (`prompts.mjs`). It tells
  the model it is running INSIDE an OpenCode session and neutralizes any Claude Code
  routing rules that leaked in from CLAUDE.md ("delegate to opencode-rescue /
  codex-rescue", `plugin:name` Task invocations). You do not need to strip such
  rules from the task text — but also **never ADD delegation instructions of your
  own**: a model that tries to re-delegate has no sub-agent to call, and some models
  hang instead of failing cleanly after the attempt.
- **A read/write preamble is added** based on the agent: write runs get "You have
  full read/write access"; plan runs get "This is a read-only investigation. Do not
  modify any files."

## Shaping the task itself

- **One task per dispatch.** The companion tracks one job per invocation; bundled
  unrelated asks produce one blended, hard-to-recover result.
- **State the goal, the involved paths, and the success criteria** in the text.
  OpenCode agents can read the repo themselves — name the entry points instead of
  pasting whole files.
- **Relying on conversation context is the classic failure.** The OpenCode model
  sees ONLY the task text plus the repo it runs in. Anything discussed in the Claude
  session (decisions, constraints, file lists) must be restated in the task text —
  forward it byte-for-byte and complete; length is not a problem, missing context is.
- **For write tasks on a repo others may be editing concurrently**, request isolation
  via the `--worktree` flag (a flag, not prose).

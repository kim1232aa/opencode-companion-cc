---
name: opencode-prompting
description: OpenCode-specific rules for composing the task text forwarded to the opencode-companion runtime — what the dispatch layer already handles for you, what breaks a forwarded prompt, and how model/agent selection actually behaves. Use when writing or reviewing the task text for an /opencode:rescue delegation, choosing between the build and plan agents, or picking a --model for a delegated OpenCode run.
user-invocable: false
---

# OpenCode Prompting

Rules grounded in how this plugin's dispatch layer actually behaves — not
generic prompt advice.

## What the dispatch layer already does (don't duplicate it)

- **A SAFETY_HEADER is prepended to every task prompt** (`prompts.mjs`). It
  tells the model it is running INSIDE an OpenCode session and neutralizes any
  Claude Code routing rules that leaked in from CLAUDE.md ("delegate to
  opencode-rescue / codex-rescue", `plugin:name` Task invocations). You do not
  need to strip such rules from the task text — but also never ADD delegation
  instructions of your own: a model that tries to re-delegate has no sub-agent to
  call, and some models hang instead of failing cleanly after the attempt.
- **A read/write preamble is added** based on the agent: write runs get "You
  have full read/write access", plan runs get "This is a read-only
  investigation. Do not modify any files."

## What actually breaks a forwarded prompt

- **Routing flags mixed into prose.** Declared flags (`--model`, `--agent`,
  `--write`, `--worktree`, `--resume-last`, `--fresh`, `--background`,
  `--wait`) are stripped from the task text wherever they appear — so never
  write a sentence like "run this with --worktree" and expect the words to
  survive. Undeclared `--tokens` (e.g. "run git commit --no-verify") ARE kept
  as task text.
- **Relying on conversation context.** The OpenCode model sees ONLY the task
  text + the repo it runs in. Anything discussed in the Claude session
  (decisions, constraints, file lists) must be restated in the task text —
  forward it byte-for-byte and complete; length is not a problem, missing
  context is.

## The delegated run is UNATTENDED (never let it ask a question)

A dispatched OpenCode run has **no human on the other end**. If the model stops
to ask a clarifying question, nobody answers: the run hangs until the stall
watchdog kills it, and the retry hangs the same way. Cost is burned, nothing
ships. Treat "the model asked a question" as a **prompt bug**, not a user
problem.

- **Never write task text that invites a question** — no "let me know if…",
  "confirm before proceeding", "ask me which approach you prefer", "check with
  me first".
- **Do the opposite: state the follow-through policy explicitly.** Append a
  block like this to the task text whenever the request has any ambiguity:

  ```
  This is a non-interactive, unattended run. Nobody can answer a question.
  Do not ask for clarification or confirmation — there is no one to reply.
  Default to the most reasonable low-risk interpretation and keep going.
  If a detail is genuinely undecidable, pick the safest option, proceed, and
  record the assumption in your final answer under "Assumptions".
  Resolve the task fully before stopping. Do not stop at the first plausible
  answer, and do not stop after identifying the issue without applying the fix.
  ```

- **Give it the material to not need a question.** Most questions come from
  missing context, so restate paths, constraints, and acceptance criteria in
  the task text (see "Relying on conversation context" above). A prompt that
  fully specifies the end state does not produce a question.
- If the model genuinely cannot proceed, it should **finish and report** what
  remains unknown — not block. Ask for an "Assumptions" / "Open questions"
  section in the output instead of a mid-run question.

## Agent selection (the real semantics)

- `build` (default): full write access. `--write` is NOT a real switch — write
  capability comes from the agent, nothing else.
- `plan`: the ONLY way to get a read-only run. Reviews always use it.
- Do not infer read-only from investigative wording ("diagnose", "research");
  such tasks often precede a fix. Only explicit user intent ("review only",
  "don't change anything") selects `plan`.

## Model selection

- `--model` must be `provider/model`, split on the FIRST slash — model ids may
  themselves contain slashes (e.g. `myprovider/group/model-name` is provider
  `myprovider`, model `group/model-name`).
- Omit `--model` to use the provider default. Only pass one the user asked for;
  a bad ref fails the dispatch with "--model must be in the form
  provider/model".
- **To find out which providers/models exist, run `opencode models`, or this
  plugin's `setup` subcommand (`/opencode:setup`). Those are the only two
  supported ways.**
- **Never read `~/.local/share/opencode/auth.json` — or any other credential,
  token, or auth file — to enumerate providers.** It stores plaintext tokens.
  Reading it is blocked by the permission layer (correctly), and it is never
  necessary: `opencode models` / `setup` already returns the real provider and
  model ids.

## Shaping the task itself

- One task per dispatch. The companion tracks one job per invocation; bundled
  unrelated asks produce one blended, hard-to-recover result.
- State the goal, the involved paths, and the success criteria in the text.
  OpenCode agents can read the repo themselves — name the entry points instead
  of pasting whole files.
- For write tasks on a repo that others may be editing concurrently, request
  isolation via `--worktree` (a flag, not prose).

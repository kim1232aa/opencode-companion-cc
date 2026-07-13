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
  instructions of your own: a model that tries to re-delegate stalls (GLM
  notoriously hangs after a failed Task call).
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

## Agent selection (the real semantics)

- `build` (default): full write access. `--write` is NOT a real switch — write
  capability comes from the agent, nothing else.
- `plan`: the ONLY way to get a read-only run. Reviews always use it.
- Do not infer read-only from investigative wording ("diagnose", "research");
  such tasks often precede a fix. Only explicit user intent ("review only",
  "don't change anything") selects `plan`.

## Model selection

- `--model` must be `provider/model`, split on the FIRST slash — model ids may
  themselves contain slashes (e.g. `volcano-coding/火山方舟Coding_Plan/glm-5.2`
  is provider `volcano-coding`, model `火山方舟Coding_Plan/glm-5.2`).
- Omit `--model` to use the provider default. Only pass one the user asked for;
  a bad ref fails the dispatch with "--model must be in the form
  provider/model".

## Shaping the task itself

- One task per dispatch. The companion tracks one job per invocation; bundled
  unrelated asks produce one blended, hard-to-recover result.
- State the goal, the involved paths, and the success criteria in the text.
  OpenCode agents can read the repo themselves — name the entry points instead
  of pasting whole files.
- For write tasks on a repo that others may be editing concurrently, request
  isolation via `--worktree` (a flag, not prose).

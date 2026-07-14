---
description: Check whether the local OpenCode CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(brew:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

If the result says OpenCode is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install OpenCode now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install OpenCode (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g opencode-ai
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

If OpenCode is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If OpenCode is installed but no provider is configured, tell the user to configure a provider in their OpenCode config, then verify with `!opencode models`.

Credentials rule:
- To list the available providers/models, use this command's `setup` output or `!opencode models`. Those are the only two supported ways.
- **Never read `~/.local/share/opencode/auth.json` or any other credential/token file** to enumerate providers or models. It contains plaintext tokens, reading it is blocked by the permission layer (correctly), and it is never necessary. This plugin never reads, stores, or edits credentials.

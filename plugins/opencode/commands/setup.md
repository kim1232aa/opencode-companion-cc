---
description: Check whether the local OpenCode CLI is ready, toggle the stop-time review gate, or install the `occ` CLI launcher
argument-hint: '[--enable-review-gate|--disable-review-gate] [--install-cli|--uninstall-cli] [--cli-name <name>]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(brew:*), Bash(curl:*), AskUserQuestion
---

CLI launcher rule (check this FIRST):
- If `$ARGUMENTS` contains `--install-cli` or `--uninstall-cli`, run the command
  WITHOUT `--json` and present its output verbatim. It is a local filesystem
  operation: it does not need OpenCode installed or the server running, so skip
  every installation check below.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup $ARGUMENTS
```

- `--install-cli` writes a short launcher (default `occ`) into `~/.local/bin`, so the
  user can run `occ status` / `occ watch` / `occ result <id>` from any terminal
  instead of a 90-character `node .../<version>/scripts/opencode-companion.mjs`.
  The launcher resolves the newest installed version at run time, so a plugin
  upgrade never breaks it.
- If it reports a name collision, tell the user to retry with `--cli-name <name>`.
- If it reports that `~/.local/bin` is not on PATH, surface the exact one-line
  command it printed — it is copy-pasteable as-is.

Otherwise, run:

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

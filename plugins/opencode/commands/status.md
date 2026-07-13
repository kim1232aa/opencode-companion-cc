---
description: Show this repo's running and recent OpenCode jobs
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the status command and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- This command is the source of truth: it resolves the correct workspace,
  reconciles jobs whose worker died, and recovers finished sessions from the
  server. Do NOT judge a job by hand-reading `plugins/data/**/state/**` files or
  job logs — multiple plugin versions have separate state dirs, and logs only
  update on a phase change, so a long gap at "Running task" is normal, not death.

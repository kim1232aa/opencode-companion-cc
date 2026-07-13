# Known issues / deferred

This fork fixed the load-bearing correctness, transport, and lifecycle bugs (see
the git log and the README "What's Fixed" table). The items below were surfaced
by review but deliberately deferred — each with its rationale. PRs welcome.

## Security / hardening

- **`$ARGUMENTS` shell interpolation in `review` / `adversarial-review` / `rescue`.**
  These commands interpolate free-form user text into a shell command, which is
  the standard Claude Code slash-command mechanism. Free-text tasks can't be
  fully sanitized without breaking them. Bounded commands (`status`, `cancel`,
  `result`) validate the job ref against `^[A-Za-z0-9._:-]+$` in the handler, but
  a shell-layer safe-command bridge (single-quoted heredoc + argv allowlist) is
  not yet implemented for them.
- **Full `process.env` is passed to child processes** (`opencode serve`, git,
  the detached worker). Children need `PATH`/`HOME`, so a blanket allowlist is
  intrusive; the delegated model can, in principle, read the parent environment.
  Only delegate to backends you trust.
- **Task text is passed on the worker command line** (visible via `ps` /
  `/proc/<pid>/cmdline` to other local users on a shared machine).
- **Basic auth over loopback HTTP** when `OPENCODE_SERVER_PASSWORD` is set — safe
  on localhost, capturable only by a root-level packet sniffer on the same host.

## Lifecycle / robustness

- **Auto-heal is dead-pid based, not session-probe based.** A background job
  whose worker dies is reconciled to `failed`. It does not (yet) query the
  OpenCode server to recover the *result* of a session that actually finished
  server-side after the worker vanished — that richer recovery from the
  suharvest fork was not ported.
- **No hard per-job wall-clock timeout in `runTrackedJob`.** In practice covered
  by `httpPostJson`'s prompt timeout (`OPENCODE_COMPANION_PROMPT_TIMEOUT_MS`,
  default 30 min), `wait-and-result`'s own bound, and dead-pid reconciliation.

## Platform / scope

- **Windows is not actively supported.** `resolveOpencodeBinary` uses `which`
  (not `where`) and does not thread `$SHELL`. Linux/macOS are the tested targets.
- **Not ported from upstream forks (out of scope for local-endpoint delegation):**
  GitHub PR review (`--pr` / `--post`), `--path` targeted reviews, `--free`
  random free-model selection, and `--worktree` isolation.

## Cosmetic / minor

- A few `createClient` endpoints (`getProviderAuth`, `subscribeEvents`) are
  exposed but unused.
- The Stop-time review gate, when enabled, can block for up to its configured
  timeout (15 min) and is off by default; `/opencode:setup` output could state
  the persistence/blocking implications more loudly.

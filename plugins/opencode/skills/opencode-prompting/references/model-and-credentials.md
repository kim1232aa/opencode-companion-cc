# Model selection and credential rules

## Model refs

- `--model` must be `provider/model`, **split on the FIRST slash only** — model
  ids may themselves contain slashes, so `myprovider/group/model-name` is provider
  `myprovider` and model `group/model-name`.
- The provider id is the OpenCode **provider id** from the opencode config — not
  the display name the UI may show, and not the grouping shown next to the model.
- Omit `--model` to use the provider default. Only pass one the user explicitly
  asked for; a bad ref fails the dispatch with
  `--model must be in the form provider/model`.

## How to discover providers and models

**Run `opencode models`, or this plugin's `setup` subcommand (`/opencode:setup`).
Those are the only two supported ways.**

## Never read credential files

**Never read `~/.local/share/opencode/auth.json` — or `opencode.jsonc`, or any
other credential, token, or auth file — to enumerate providers.**

- It stores **plaintext tokens**.
- Reading it is blocked by the permission layer (correctly).
- It is never necessary: `opencode models` / `setup` already returns the real
  provider and model ids.

## Agent selection (the real semantics)

- `build` (default): full write access. `--write` is **not** a real switch — write
  capability comes from the agent, nothing else.
- `plan`: the **only** way to get a read-only run. Reviews always use it.
- Do not infer read-only from investigative wording ("diagnose", "research",
  "look into"); such tasks often precede a fix. Only explicit user intent ("review
  only", "don't change anything", "no edits") selects `plan`.

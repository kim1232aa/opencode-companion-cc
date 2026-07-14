# The delegated run is UNATTENDED — never let it ask a question

A dispatched OpenCode run has **no human on the other end**. If the model stops to
ask a clarifying question, nobody answers: the run hangs until the stall watchdog
kills it, and the retry hangs the same way. Cost is burned, nothing ships. Treat
"the model asked a question" as a **prompt bug**, not a user problem.

## What not to write

Never write task text that invites a question:

- "let me know if…"
- "confirm before proceeding"
- "ask me which approach you prefer"
- "check with me first"

## State the follow-through policy instead

Append this block verbatim to the task text whenever the request has any
ambiguity:

```
This is a non-interactive, unattended run. Nobody can answer a question.
Do not ask for clarification or confirmation — there is no one to reply.
Default to the most reasonable low-risk interpretation and keep going.
If a detail is genuinely undecidable, pick the safest option, proceed, and
record the assumption in your final answer under "Assumptions".
Resolve the task fully before stopping. Do not stop at the first plausible
answer, and do not stop after identifying the issue without applying the fix.
```

## Give it the material to not need a question

Most questions come from missing context. The OpenCode model sees ONLY the task
text plus the repository it runs in — nothing from the Claude conversation. So
restate paths, constraints, decisions, and acceptance criteria in the task text. A
prompt that fully specifies the end state does not produce a question.

If the model genuinely cannot proceed, it should **finish and report** what remains
unknown — not block. Ask for an "Assumptions" / "Open questions" section in the
*output* instead of a mid-run question.

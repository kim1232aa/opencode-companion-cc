// Lightweight argument parser for the OpenCode companion scripts.

// A token only *looks like* an option when it is `--name`, `--na-me` or
// `--name=value` with an ASCII option name: no whitespace, no CJK, no
// punctuation beyond `.`/`_`/`-`. Real options can never contain a space, so a
// token such as `--no-verify 这参数啥意思` (one quoted argv entry) is natural
// language, not a flag — and is treated as task text. This is what lets a task
// that *starts* with a dashed word survive without a `--` sentinel.
const OPTION_RE = /^--([A-Za-z0-9][A-Za-z0-9._-]*)(?:=([\s\S]*))?$/;

/**
 * Match an argv token against the option shape.
 * @param {string} token
 * @returns {{ key: string, inlineValue: string|undefined }|null} null when the
 *   token is not option-shaped (i.e. it is task text / a positional).
 */
export function matchOption(token) {
  if (typeof token !== "string") return null;
  const m = OPTION_RE.exec(token);
  if (!m) return null;
  return { key: m[1], inlineValue: m[2] };
}

/**
 * Parse CLI arguments into options and positional args.
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} schema
 * @returns {{ options: Record<string, string|boolean>, positional: string[] }}
 */
export function parseArgs(argv, schema = {}) {
  const valueSet = new Set(schema.valueOptions ?? []);
  const boolSet = new Set(schema.booleanOptions ?? []);
  const options = {};
  const positional = [];

  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (endOfOptions) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let inlineValue;
    const eqIdx = key.indexOf("=");
    if (eqIdx !== -1) {
      inlineValue = key.slice(eqIdx + 1);
      key = key.slice(0, eqIdx);
    }
    if (valueSet.has(key)) {
      if (inlineValue !== undefined) {
        options[key] = inlineValue;
      } else {
        // Don't swallow a following option as this flag's value: `--model
        // --write` must not set model="--write" (which later throws in
        // parseModelRef and silently drops --write). Treat it as a missing
        // value instead.
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          process.stderr.write(`warning: --${key} expects a value but none was given\n`);
          options[key] = "";
        } else {
          options[key] = argv[++i];
        }
      }
    } else if (boolSet.has(key)) {
      options[key] = true;
    } else {
      process.stderr.write(`warning: unknown option --${key}\n`);
      options[key] = true;
    }
  }

  return { options, positional };
}

/**
 * Parse a *task-style* argv: declared routing flags plus free-form task text.
 * Single scanner for the dispatch paths (`task`, `wait-and-result`); it yields
 * the options, the positional task text, and the list of FATAL argument errors,
 * so a malformed call can fail before a job is created.
 *
 * The `--x` ambiguity is resolved the same way the upstream codex companion
 * does it: an UNDECLARED `--x` is demoted to task text, never an error. That
 * keeps the byte-for-byte forwarding promise intact ("run git commit
 * --no-verify"), and the task text now travels to the worker in the job record
 * rather than on argv, so a leading `--` is no longer dangerous.
 *   - undeclared `--x`            → task text, verbatim, wherever it appears
 *   - declared value option with no value (`--model --write`) → fatal error
 *     (the caller's model choice must never be silently dropped)
 *   - a `--`-prefixed token that is not option-shaped ("--no-verify 这是啥")
 *                                 → task text
 *   - everything after a bare `--` sentinel → task text, dashes and all
 * Emptiness is the only other fatal condition, and the caller checks it after
 * folding in the other task sources (--task/--task-file/stdin).
 *
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} schema
 * @returns {{ options: Record<string, string|boolean>, taskText: string, errors: string[] }}
 */
export function parseTaskArgv(argv, schema = {}) {
  const valueSet = new Set(schema.valueOptions ?? []);
  const boolSet = new Set(schema.booleanOptions ?? []);
  const options = {};
  const parts = [];
  const errors = [];

  let endOfOptions = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (endOfOptions) {
      parts.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
      continue;
    }

    const opt = matchOption(arg);
    if (!opt) {
      parts.push(arg);
      continue;
    }

    const { key, inlineValue } = opt;

    if (valueSet.has(key)) {
      if (inlineValue !== undefined) {
        options[key] = inlineValue;
        continue;
      }
      // Don't swallow a following option as this flag's value: `--model --write`
      // must not set model="--write" (which later fails in parseModelRef and
      // silently drops --write). A missing value is a hard error here — the
      // caller asked for a specific model/agent and must not get a default.
      const next = argv[i + 1];
      if (next === undefined || matchOption(next)) {
        errors.push(`--${key} expects a value but none was given`);
        continue;
      }
      options[key] = argv[++i];
      continue;
    }

    if (boolSet.has(key)) {
      options[key] = true;
      continue;
    }

    // Undeclared: demote to task text and keep it verbatim, so a forwarded
    // shell command ("run git commit --no-verify") is never corrupted.
    parts.push(arg);
  }

  return { options, taskText: parts.join(" ").trim(), errors };
}

// Job ids are minted by generateJobId() as `<type>-<base36 ts>-<base36 rand>`
// (e.g. task-mrkyzulu-fy4ojt). Natural-language task text never has this shape,
// so the shape test is a safe first gate before the state lookup.
const JOB_ID_RE = /^[a-z][a-z-]*-[a-z0-9]{5,}-[a-z0-9]{4,}$/i;

/**
 * Whether a string is shaped like a job id (safe-ref charset + generated shape).
 * @param {string} ref
 * @returns {boolean}
 */
export function looksLikeJobId(ref) {
  return typeof ref === "string"
    && /^[A-Za-z0-9._:-]+$/.test(ref)
    && JOB_ID_RE.test(ref);
}

/**
 * Decide what `wait-and-result <arg>` actually means. `wait-and-result` used to
 * treat EVERY argument as task text, so passing an existing job id dispatched a
 * brand-new job whose "task" was that opaque id — it went looking for the id in
 * the repo and then hung asking the user what the task was.
 *
 * @param {string} taskText - the parsed positional text
 * @param {object[]} jobs - jobs from state
 * @returns {{ kind: "await"|"missing"|"dispatch", jobId?: string, ambiguous?: boolean }}
 *   - "await": it is an existing job → wait for THAT job, dispatch nothing.
 *   - "missing": job-id-shaped but unknown → hard error, never dispatch it.
 *   - "dispatch": genuine task text → dispatch a new job.
 */
export function classifyWaitTarget(taskText, jobs = []) {
  const ref = String(taskText ?? "").trim();
  // Multi-word / non-safe-ref text is task text, full stop.
  if (!ref || /\s/.test(ref) || !/^[A-Za-z0-9._:-]+$/.test(ref)) return { kind: "dispatch" };

  const full = looksLikeJobId(ref);                       // a complete generated id
  const prefixish = ref.includes("-") && ref.length >= 8; // a plausible id PREFIX
  if (!full && !prefixish) return { kind: "dispatch" };

  // Double-check against state: a hit means "wait for that job".
  const exact = jobs.find((j) => j?.id === ref);
  if (exact) return { kind: "await", jobId: exact.id };
  const prefixed = jobs.filter((j) => typeof j?.id === "string" && j.id.startsWith(ref));
  if (prefixed.length === 1) return { kind: "await", jobId: prefixed[0].id };
  if (prefixed.length > 1) return { kind: "missing", jobId: ref, ambiguous: true };

  // No hit. A full job-id shape is unambiguously a (stale/foreign) job
  // reference — erroring is right; dispatching it as a "task" is what used to
  // send OpenCode hunting for the id in the repo. Anything else is task text.
  return full ? { kind: "missing", jobId: ref } : { kind: "dispatch" };
}

/**
 * Extract the natural-language text from argv after stripping known flags.
 * Superseded by {@link parseTaskArgv} on the dispatch paths (which also reports
 * fatal argument errors); kept for callers that only need the text.
 * @param {string[]} argv
 * @param {string[]} flagsWithValue - flags that consume the next token
 * @param {string[]} booleanFlags - flags that are standalone
 * @returns {string}
 */
export function extractTaskText(argv, flagsWithValue = [], booleanFlags = []) {
  const valSet = new Set(flagsWithValue);
  const boolSet = new Set(booleanFlags);
  const parts = [];

  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (endOfOptions) {
      parts.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (arg.startsWith("--")) {
      let key = arg.slice(2);
      const eqIdx = key.indexOf("=");
      if (eqIdx !== -1) {
        key = key.slice(0, eqIdx);
        if (valSet.has(key) || boolSet.has(key)) continue; // known inline flag
        parts.push(arg); // unknown --foo=bar is task text — keep it
        continue;
      }
      if (valSet.has(key)) {
        // Mirror parseArgs: only consume the next token as this flag's value
        // when it isn't itself an option, so a stray `--model --write` doesn't
        // eat --write and mis-split the remaining task text.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) i++;
        continue;
      }
      if (boolSet.has(key)) continue; // known boolean routing flag
      // NOT a declared flag: it's part of the task text (e.g. "run git commit
      // --no-verify"). Stripping it would silently corrupt the forwarded task
      // and break the byte-for-byte forwarding promise.
      parts.push(arg);
      continue;
    }
    parts.push(arg);
  }

  return parts.join(" ").trim();
}

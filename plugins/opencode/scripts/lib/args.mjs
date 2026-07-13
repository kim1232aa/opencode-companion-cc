// Lightweight argument parser for the OpenCode companion scripts.

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
        options[key] = argv[++i] ?? "";
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
 * Extract the natural-language text from argv after stripping known flags.
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
        // inline value form: no next token to consume
      } else if (valSet.has(key)) {
        i++; // skip value token
      }
      // skip boolean flags silently
      continue;
    }
    parts.push(arg);
  }

  return parts.join(" ").trim();
}

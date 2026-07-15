// adversarial-review focus resolution.
//
// Regression guard: `adversarial-review --task "审查 X"` used to leave `--task`
// UNDECLARED, so parseTaskArgv demoted the flag token to text and the focus
// became the literal "--task 审查 X" (the flag leaked in). The focus now folds
// --task/--prompt/--task-file/positional through resolveTaskText's precedence,
// exactly like `task`, so the caller gets a clean focus. An empty focus stays
// valid ("general review") and must never slurp an unrelated stdin pipe.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseTaskArgv } from "../plugins/opencode/scripts/lib/args.mjs";
import { resolveReviewFocus } from "../plugins/opencode/scripts/opencode-companion.mjs";

// Mirror handleAdversarialReview's own schema so the test exercises the real
// parse → resolve path the handler uses.
const SCHEMA = {
  valueOptions: ["base", "model", "task", "prompt", "task-file", "max-words"],
  booleanOptions: ["wait", "background", "brief", "no-brief", "full"],
};

function focusFor(argv) {
  const { options, taskText } = parseTaskArgv(argv, SCHEMA);
  return resolveReviewFocus(options, taskText);
}

describe("adversarial-review focus resolution", () => {
  it("does not leak a --task flag into the focus", () => {
    assert.equal(focusFor(["--task", "审查 X 模块"]).focus, "审查 X 模块");
    assert.equal(focusFor(["--base", "main", "--task", "审查 X"]).focus, "审查 X");
  });

  it("accepts --prompt as a focus source too", () => {
    assert.equal(focusFor(["--prompt", "look at the retry path"]).focus, "look at the retry path");
  });

  it("still takes positional text as the focus", () => {
    assert.equal(focusFor(["--base", "main", "the", "focus", "text"]).focus, "the focus text");
  });

  it("keeps an undeclared --flag inside positional focus verbatim", () => {
    // The byte-for-byte forwarding promise: a focus that mentions a flag name
    // ("review the --verbose path") must survive, since it is not a real option.
    assert.equal(focusFor(["review", "the", "--verbose", "path"]).focus, "review the --verbose path");
  });

  it("treats no arguments as an empty (general) focus without reading stdin", () => {
    assert.equal(focusFor([]).focus, "");
  });

  it("reads --task-file and surfaces a read error instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-review-focus-"));
    const p = path.join(dir, "focus.txt");
    fs.writeFileSync(p, "  concurrency and cancel paths \n");
    try {
      assert.equal(focusFor(["--task-file", p]).focus, "concurrency and cancel paths");
      const missing = focusFor(["--task-file", path.join(dir, "nope.txt")]);
      assert.equal(missing.focus, "");
      assert.equal(missing.errors.length, 1);
      assert.match(missing.errors[0], /could not read --task-file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--task-file wins over positional, matching `task` precedence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-review-focus-"));
    const p = path.join(dir, "focus.txt");
    fs.writeFileSync(p, "from the file");
    try {
      assert.equal(focusFor(["--task-file", p, "positional", "words"]).focus, "from the file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

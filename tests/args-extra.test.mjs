import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, parseTaskArgv, extractTaskText } from "../plugins/opencode/scripts/lib/args.mjs";

describe("parseArgs — harvested fixes", () => {
  it("supports --key=value form", () => {
    const { options } = parseArgs(["--model=deepseek/v4", "hello"], { valueOptions: ["model"] });
    assert.equal(options.model, "deepseek/v4");
  });

  it("does not consume the following token for an empty inline value (`--model=`)", () => {
    // The `=` explicitly delimited an EMPTY value, so "gpt-5" stays positional
    // rather than being swallowed as the model — and no empty ref sneaks past.
    const { options, positional } = parseArgs(["--model=", "gpt-5"], { valueOptions: ["model"] });
    assert.equal(options.model, "");
    assert.deepEqual(positional, ["gpt-5"]);
  });
});

describe("parseTaskArgv — empty inline value", () => {
  it("rejects `--model=` as a missing value instead of accepting an empty model", () => {
    const { options, errors } = parseTaskArgv(["--model=", "do the thing"], { valueOptions: ["model"] });
    assert.ok(errors.some((e) => /--model expects a value/.test(e)), errors.join(" | "));
    assert.equal(options.model, undefined, "an empty model must never be set");
  });

  it("still accepts a real inline value", () => {
    const { options, errors } = parseTaskArgv(["--model=deepseek/v4", "task"], { valueOptions: ["model"] });
    assert.equal(errors.length, 0);
    assert.equal(options.model, "deepseek/v4");
  });

  it("does not consume the `--` sentinel as a value option's value", () => {
    // matchOption("--") is null, so without an explicit guard `--model -- text`
    // ate the sentinel as model="--" and lost end-of-options. It must error.
    const { options, errors } = parseTaskArgv(["--model", "--", "--no-verify", "commit"], { valueOptions: ["model"] });
    assert.ok(errors.some((e) => /--model expects a value/.test(e)), errors.join(" | "));
    assert.notEqual(options.model, "--");
  });

  it("keeps the sentinel working when the value IS supplied", () => {
    const { options, taskText, errors } = parseTaskArgv(
      ["--model", "gpt-5", "--", "--no-verify", "commit"],
      { valueOptions: ["model"] }
    );
    assert.equal(errors.length, 0);
    assert.equal(options.model, "gpt-5");
    assert.equal(taskText, "--no-verify commit"); // dashed tokens after -- are text
  });
});

describe("parseArgs — strict review parsing (typo/missing-base no longer silent)", () => {
  const SCHEMA = {
    valueOptions: ["base", "model", "max-words"],
    booleanOptions: ["wait", "background", "brief", "no-brief", "full"],
  };

  it("flags a typo'd flag as unknown under strict (so review can reject it)", () => {
    const { unknown, positional } = parseArgs(["--bsae", "main"], { ...SCHEMA, strict: true });
    assert.deepEqual(unknown, ["bsae"], "the misspelled --base must surface as unknown");
    assert.deepEqual(positional, ["main"], "and its arg is left positional, not a base");
  });

  it("surfaces a bare --base as an empty value (the signal review rejects)", () => {
    const { options } = parseArgs(["--base"], SCHEMA);
    assert.equal(options.base, "", "bare --base lands as '' -> review fails fast instead of reviewing the working tree");
  });

  it("accepts a well-formed review invocation", () => {
    const { options, unknown } = parseArgs(["--base", "main", "--brief"], { ...SCHEMA, strict: true });
    assert.equal(unknown.length, 0);
    assert.equal(options.base, "main");
    assert.equal(options.brief, true);
  });
});

describe("parseArgs — more harvested fixes", () => {

  it("still supports --key value (space) form", () => {
    const { options } = parseArgs(["--model", "deepseek/v4"], { valueOptions: ["model"] });
    assert.equal(options.model, "deepseek/v4");
  });

  it("treats everything after -- as positional, even dashed tokens", () => {
    const { positional } = parseArgs(["--agent", "plan", "--", "--not-a-flag", "text"], {
      valueOptions: ["agent"],
    });
    assert.deepEqual(positional, ["--not-a-flag", "text"]);
  });

  it("records declared booleans as true", () => {
    const { options } = parseArgs(["--background"], { booleanOptions: ["background"] });
    assert.equal(options.background, true);
  });
});

describe("extractTaskText — harvested fixes", () => {
  it("consumes --key value and returns the remaining task text", () => {
    const text = extractTaskText(["--model", "x/y", "do", "the", "thing"], ["model"], []);
    assert.equal(text, "do the thing");
  });

  it("does not consume a following token for --key=value", () => {
    const text = extractTaskText(["--model=x/y", "do", "it"], ["model"], []);
    assert.equal(text, "do it");
  });

  it("keeps text after the -- sentinel", () => {
    const text = extractTaskText(["--agent", "plan", "--", "--weird", "task"], ["agent"], []);
    assert.equal(text, "--weird task");
  });
});

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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, extractTaskText } from "../plugins/opencode/scripts/lib/args.mjs";

describe("parseArgs — harvested fixes", () => {
  it("supports --key=value form", () => {
    const { options } = parseArgs(["--model=deepseek/v4", "hello"], { valueOptions: ["model"] });
    assert.equal(options.model, "deepseek/v4");
  });

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

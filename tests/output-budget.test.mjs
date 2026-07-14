// The OUTPUT BUDGET.
//
// Why it exists: a delegated job's WORK runs on OpenCode and costs the caller
// nothing, but its ANSWER is copied back into the caller's context and re-read
// on every later turn — so the answer is the one part of a delegation that keeps
// billing. buildTaskPrompt used to carry no length constraint at all, and models
// routinely returned an essay where a conclusion plus a file:line would do.
//
// What must NOT break in the process:
//   - the task text is still forwarded VERBATIM as the trailing block,
//   - SAFETY_HEADER and HEADLESS_HEADER still lead,
//   - the budget constrains the REPORT, never the work,
//   - a review's JSON schema contract is untouched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTaskPrompt,
  buildReviewPrompt,
  buildOutputBudget,
  wantsOutputBudget,
  OUTPUT_BUDGET_HEADER,
  DEFAULT_BRIEF,
  SAFETY_HEADER,
  HEADLESS_HEADER,
} from "../plugins/opencode/scripts/lib/prompts.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "opencode");

describe("buildOutputBudget", () => {
  it("is ON by default — the recurring cost is the answer, not the work", () => {
    assert.equal(DEFAULT_BRIEF, true);
    const budget = buildOutputBudget({});
    assert.ok(budget.includes(OUTPUT_BUDGET_HEADER));
  });

  it("is fully OFF when brief:false — the explicit escape hatch", () => {
    assert.equal(buildOutputBudget({ brief: false }), "");
  });

  it("adds a hard word cap when maxWords is given", () => {
    const budget = buildOutputBudget({ maxWords: 150 });
    assert.match(budget, /HARD LIMIT: keep the final answer under 150 words/);
    // Truncation is not the prescribed way to hit the cap: point at the detail.
    assert.match(budget, /where it can be read in full/);
    assert.match(budget, /never cut off mid-thought/i);
  });

  it("never smuggles a word cap into a run that opted out", () => {
    assert.equal(buildOutputBudget({ brief: false, maxWords: 50 }), "");
  });

  it("ignores a non-positive / non-numeric maxWords instead of emitting a broken limit", () => {
    for (const bad of [0, -10, "abc", NaN, undefined, null]) {
      const budget = buildOutputBudget({ maxWords: bad });
      assert.ok(budget.includes(OUTPUT_BUDGET_HEADER), `budget still present for ${bad}`);
      assert.doesNotMatch(budget, /HARD LIMIT/, `no bogus cap for ${bad}`);
    }
  });

  it("floors a fractional cap to a whole number of words", () => {
    assert.match(buildOutputBudget({ maxWords: 120.9 }), /under 120 words/);
  });

  it("constrains the REPORT, not the work, and says so", () => {
    const budget = buildOutputBudget({});
    assert.match(budget, /constrains what you REPORT, not how much work you do/);
    assert.match(budget, /Investigate as deeply as the task needs/);
  });

  it("asks for conclusion + locators, and bans the padding", () => {
    const budget = buildOutputBudget({});
    assert.match(budget, /lead with the conclusion/i);
    assert.match(budget, /file:line/);
    assert.match(budget, /instead of reproducing whole files, whole diffs or long logs/);
    assert.match(budget, /no preamble/i);
    assert.match(budget, /name where it can be read in full/i);
    // The escape valve inside the instruction itself: a task that genuinely
    // wants a long artifact still gets one.
    assert.match(budget, /Write at length ONLY where the task explicitly asks/);
  });

  it("explains WHY (the answer is re-read every turn), so the model can weigh it", () => {
    assert.match(OUTPUT_BUDGET_HEADER, /STAYS in that agent's context/);
    assert.match(OUTPUT_BUDGET_HEADER, /re-read on every\s+later turn/);
  });

  it("adds the schema-safe clause only when the caller imposes an output contract", () => {
    assert.doesNotMatch(buildOutputBudget({}), /does NOT relax/);
    const structured = buildOutputBudget({ structured: true });
    assert.match(structured, /applies to the PROSE inside the required output fields/);
    assert.match(structured, /still return every required field/);
  });

  it("names no private provider or model (this is a public plugin)", () => {
    assert.doesNotMatch(
      buildOutputBudget({ maxWords: 100, structured: true }),
      /glm|zhipu|deepseek|kimi|qwen|anthropic|claude|openai|gpt|gemini/i
    );
  });
});

describe("wantsOutputBudget — the opt-in test used where the budget is not defaulted", () => {
  it("is false when the caller said nothing", () => {
    assert.equal(wantsOutputBudget({}), false);
    assert.equal(wantsOutputBudget({ brief: false }), false);
  });

  it("is true on an explicit brief, or on any positive word cap", () => {
    assert.equal(wantsOutputBudget({ brief: true }), true);
    assert.equal(wantsOutputBudget({ maxWords: 200 }), true);
    assert.equal(wantsOutputBudget({ maxWords: 0 }), false);
  });
});

describe("buildTaskPrompt — output budget", () => {
  it("carries the budget by default, in both write and read-only modes", () => {
    assert.ok(buildTaskPrompt("fix the parser", { write: true }).includes(OUTPUT_BUDGET_HEADER));
    assert.ok(buildTaskPrompt("find the bug", {}).includes(OUTPUT_BUDGET_HEADER));
  });

  it("drops the budget entirely when the caller asks for the long form", () => {
    const p = buildTaskPrompt("write the full migration guide", { write: true, brief: false });
    assert.ok(!p.includes(OUTPUT_BUDGET_HEADER));
    // Everything else about the dispatch is unchanged.
    assert.ok(p.includes(SAFETY_HEADER));
    assert.ok(p.includes(HEADLESS_HEADER));
    assert.ok(p.endsWith("write the full migration guide"));
  });

  it("passes a word cap through to the prompt", () => {
    assert.match(buildTaskPrompt("audit auth", { maxWords: 200 }), /under 200 words/);
  });

  it("KEEPS the verbatim-task-text contract: the budget is a system prefix", () => {
    // A task text that itself talks about output length must survive byte for
    // byte — the budget may never rewrite, wrap or summarize the forwarded task.
    const task = "Write a 5000-word report. Do NOT be brief. HARD LIMIT: none.";
    const p = buildTaskPrompt(task, { write: true, maxWords: 100 });

    assert.ok(p.endsWith(task), "task text is forwarded verbatim, as the trailing block");
    assert.ok(p.indexOf(OUTPUT_BUDGET_HEADER) < p.indexOf(task), "budget precedes the task");
    assert.ok(p.indexOf(SAFETY_HEADER) < p.indexOf(HEADLESS_HEADER), "safety header stays first");
    assert.ok(p.indexOf(HEADLESS_HEADER) < p.indexOf(OUTPUT_BUDGET_HEADER), "headless header stays second");
  });

  it("keeps the access-mode line between the budget and the task", () => {
    const p = buildTaskPrompt("do it", { write: true });
    const mode = "You have full read/write access. Make the necessary code changes.";
    assert.ok(p.indexOf(OUTPUT_BUDGET_HEADER) < p.indexOf(mode));
    assert.ok(p.indexOf(mode) < p.indexOf("do it"));

    const ro = buildTaskPrompt("look at it", {});
    assert.match(ro, /This is a read-only investigation/);
  });
});

describe("buildReviewPrompt — the budget is OPT-IN and never breaks the JSON contract", () => {
  it("adds nothing when not asked (review output is already schema-bounded)", async () => {
    const p = await buildReviewPrompt(REPO_ROOT, {}, PLUGIN_ROOT);
    assert.ok(!p.includes(OUTPUT_BUDGET_HEADER));
    assert.match(p, /<output_schema>/);
  });

  it("tightens the prose when asked, with the schema block still LAST", async () => {
    const p = await buildReviewPrompt(REPO_ROOT, { brief: true, maxWords: 300 }, PLUGIN_ROOT);
    assert.ok(p.includes(OUTPUT_BUDGET_HEADER));
    assert.match(p, /under 300 words/);
    // The output contract must still be the final word of the prompt, and the
    // budget must explicitly refuse to relax it.
    assert.match(p, /applies to the PROSE inside the required output fields/);
    assert.ok(
      p.indexOf(OUTPUT_BUDGET_HEADER) < p.indexOf("<output_schema>"),
      "the schema block stays last"
    );
    assert.match(p, /Return ONLY a single JSON object/);
    assert.ok(p.trimEnd().endsWith("</output_schema>"));
  });

  it("a bare maxWords implies the budget for reviews too", async () => {
    const p = await buildReviewPrompt(REPO_ROOT, { maxWords: 120 }, PLUGIN_ROOT);
    assert.ok(p.includes(OUTPUT_BUDGET_HEADER));
    assert.match(p, /under 120 words/);
  });
});

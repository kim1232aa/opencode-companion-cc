import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatTrailer } from "../plugins/opencode/scripts/lib/render.mjs";

describe("formatTrailer — concise one-line result tail", () => {
  it("is a single ✓ line with out tokens, model and session", () => {
    const out = formatTrailer(
      { total: 5000, output: 1234, model: "prov/glm-5.2" },
      { requestedModel: "prov/glm-5.2", sessionId: "abc123" }
    );
    assert.ok(!out.includes("\n"), "single line");
    assert.match(out, /^✓ /);
    assert.match(out, /1,234 out tok/);
    assert.match(out, /model:prov\/glm-5\.2/);
    assert.match(out, /session:abc123/);
    // no multi-line "Tokens" / "---" block
    assert.ok(!out.includes("---"));
    assert.ok(!out.includes("Tokens"));
  });

  it("keeps the model-mismatch ⚠️ correctness signal (ran vs requested)", () => {
    const out = formatTrailer(
      { output: 10, model: "prov/actually-ran" },
      { requestedModel: "prov/wanted", sessionId: "s1" }
    );
    assert.match(out, /^⚠️/);
    assert.match(out, /ran prov\/actually-ran/);
    assert.match(out, /NOT requested prov\/wanted/);
  });

  it("falls back to total tokens when output is 0, and shows cost", () => {
    const out = formatTrailer({ total: 800, output: 0, cost: 0.0021, model: "p/m" });
    assert.match(out, /800 tok/);
    assert.match(out, /\$0\.0021/);
    assert.match(out, /model:p\/m/);
  });

  it("marks a requested-but-unreported model with (requested)", () => {
    const out = formatTrailer({ output: 5 }, { requestedModel: "p/m" });
    assert.match(out, /model:p\/m \(requested\)/);
  });

  it("returns '' when there is nothing meaningful to show", () => {
    assert.equal(formatTrailer(undefined), "");
    assert.equal(formatTrailer(null), "");
    assert.equal(formatTrailer({}), "");
    assert.equal(formatTrailer({ total: 0, output: 0, cost: 0 }), "");
  });

  it("omits session when none is provided", () => {
    const out = formatTrailer({ output: 3, model: "p/m" });
    assert.ok(!out.includes("session:"), out);
  });
});

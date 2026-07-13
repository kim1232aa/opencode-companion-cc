// The Stop hook's stdin is a JSON object from Claude Code, with the reply text
// in `last_assistant_message` (alongside session_id / transcript_path / cwd).
// extractClaudeResponse must unwrap it — and never throw on a malformed payload.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractClaudeResponse } from "../plugins/opencode/scripts/stop-review-gate-hook.mjs";

describe("extractClaudeResponse", () => {
  it("extracts last_assistant_message from the Stop-hook JSON payload", () => {
    const stdin = JSON.stringify({
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      last_assistant_message: "Here is my final answer.",
    });
    assert.equal(extractClaudeResponse(stdin), "Here is my final answer.");
  });

  it("returns '' for a valid JSON object missing last_assistant_message (safe allow)", () => {
    assert.equal(extractClaudeResponse(JSON.stringify({ session_id: "x" })), "");
  });

  it("returns '' when last_assistant_message is not a string", () => {
    assert.equal(extractClaudeResponse(JSON.stringify({ last_assistant_message: 42 })), "");
  });

  it("falls back to the raw text when stdin is not JSON", () => {
    assert.equal(extractClaudeResponse("just some plain text"), "just some plain text");
  });

  it("returns '' for empty / whitespace-only stdin", () => {
    assert.equal(extractClaudeResponse(""), "");
    assert.equal(extractClaudeResponse("   \n"), "");
  });

  it("returns '' for non-string input rather than throwing", () => {
    assert.equal(extractClaudeResponse(undefined), "");
    assert.equal(extractClaudeResponse(null), "");
  });

  it("uses a bare JSON string value as-is", () => {
    assert.equal(extractClaudeResponse(JSON.stringify("bare string reply")), "bare string reply");
  });

  it("does not treat a JSON array as a message object", () => {
    assert.equal(extractClaudeResponse(JSON.stringify([{ last_assistant_message: "no" }])), "");
  });
});

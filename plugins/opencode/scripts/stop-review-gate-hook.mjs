#!/usr/bin/env node

// Stop review gate hook for the OpenCode companion.
// When enabled, runs a targeted OpenCode review on Claude's response before
// allowing the session to stop. If issues are found, the stop is blocked.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState } from "./lib/state.mjs";
import { isServerRunning, connect } from "./lib/opencode-server.mjs";

// fileURLToPath(import.meta.url), not import.meta.dirname (Node 20.11+): engines
// declares >=18.18, and on 18/19 import.meta.dirname is undefined → path.resolve
// throws. CLAUDE_PLUGIN_ROOT is normally set by the hook runner, but don't rely
// on it for startup not to crash.
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const workspace = await resolveWorkspace();

  // Check if review gate is enabled
  const state = loadState(workspace);
  if (!state.config?.reviewGate) {
    // Gate is disabled, allow stop
    console.log("ALLOW: Review gate is disabled.");
    return;
  }

  // Check if server is available
  if (!(await isServerRunning())) {
    console.log("ALLOW: OpenCode server not running.");
    return;
  }

  // Read the raw stdin the host piped in. Claude Code's Stop hook sends a JSON
  // object (last_assistant_message / session_id / transcript_path / cwd / …),
  // NOT the reply text on its own — extractClaudeResponse unwraps it.
  let rawStdin = "";
  if (!process.stdin.isTTY) {
    rawStdin = await new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      // Timeout after 5 seconds of no input
      setTimeout(() => resolve(data), 5000);
    });
  }

  const claudeResponse = extractClaudeResponse(rawStdin);

  if (!claudeResponse.trim()) {
    console.log("ALLOW: No response to review.");
    return;
  }

  // Load the stop-review-gate prompt template
  const templatePath = path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md");
  const template = fs.readFileSync(templatePath, "utf8");
  const prompt = template.replace(
    "{{CLAUDE_RESPONSE_BLOCK}}",
    `<claude_response>\n${claudeResponse}\n</claude_response>`
  );

  try {
    const client = await connect({ cwd: workspace });
    const session = await client.createSession({ title: "Stop Review Gate" });

    const response = await client.sendPrompt(session.id, prompt, {
      agent: "plan", // read-only review
    });

    // Extract the verdict
    const text = extractText(response);
    const firstLine = text.trim().split("\n")[0];

    if (firstLine.startsWith("BLOCK")) {
      // Output BLOCK to stderr so Claude Code sees it
      process.stderr.write(`OpenCode review gate: ${firstLine}\n`);
      console.log(firstLine);
      process.exit(1); // Non-zero exit blocks the stop
    } else {
      console.log(firstLine || "ALLOW: No issues found.");
    }
  } catch (err) {
    // On error, allow the stop (don't block on failures)
    console.log(`ALLOW: Review gate error: ${err.message}`);
  }
}

/**
 * Unwrap the Claude reply text from a Stop-hook stdin payload.
 * Claude Code pipes a JSON object whose reply lives in `last_assistant_message`.
 * Safe degradation:
 *   - valid JSON object → its `last_assistant_message` (empty string if the
 *     field is absent, so the gate simply allows rather than reviewing noise);
 *   - JSON that isn't an object → "" (nothing meaningful to review);
 *   - not JSON at all → the raw text verbatim (older/other hosts may pipe the
 *     reply directly). Never throws — a bad payload must not crash the hook.
 * @param {string} rawStdin
 * @returns {string}
 */
export function extractClaudeResponse(rawStdin) {
  const raw = typeof rawStdin === "string" ? rawStdin : "";
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return typeof parsed.last_assistant_message === "string"
        ? parsed.last_assistant_message
        : "";
    }
    // Parsed to a bare string ⇒ use it; anything else (number/array/null) ⇒ "".
    return typeof parsed === "string" ? parsed : "";
  } catch {
    // Not JSON — treat the whole stdin as the response text (legacy fallback).
    return raw;
  }
}

function extractText(response) {
  if (typeof response === "string") return response;
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(response);
}

// Only run when invoked as the entry script, so tests can import
// extractClaudeResponse without triggering the full hook (stdin read, git, …).
function isEntryPoint() {
  try {
    return !!process.argv[1] &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.log(`ALLOW: Unhandled error: ${err.message}`);
    process.exit(0);
  });
}

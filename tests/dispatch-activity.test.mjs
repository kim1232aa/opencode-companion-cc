import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dispatchWithRetry } from "../plugins/opencode/scripts/lib/opencode-server.mjs";

const extract = (r) => (r && typeof r.text === "string" ? r.text : "");

describe("dispatchWithRetry — activity stream integration (#11)", () => {
  it("logs new internal tool activity during the run, de-duplicated across beats", async () => {
    const logs = [];
    let seq = 0;
    const client = {
      createSession: async () => ({ id: `s${++seq}` }),
      getSessionUsage: async () => ({ total: 100, output: 50, turns: 1 }),
      abortSession: async () => {},
      // Emits one tool part the first time it is polled; the persistent `seen`
      // Set (passed by dispatchWithRetry) makes every later beat return nothing.
      getSessionActivity: async (_sid, { seen } = {}) => {
        if (seen && !seen.has("p1")) {
          seen.add("p1");
          return ["bash: npm test"];
        }
        return [];
      },
      sendPrompt: async () => {
        // Stay in-flight long enough for several beats to fire.
        await new Promise((r) => setTimeout(r, 90));
        return { text: "done" };
      },
    };

    const res = await dispatchWithRetry({
      client, prompt: "x", agent: "build", extract,
      log: (m) => logs.push(m),
      makeSession: () => client.createSession(),
      beatMs: 15, stallMs: 10_000, backoffMs: 1,
    });

    assert.equal(extract(res.response), "done");
    const activity = logs.filter((l) => l.startsWith("activity:"));
    assert.deepEqual(activity, ["activity: bash: npm test"], logs.join("\n"));
    // heartbeats still logged alongside activity
    assert.ok(logs.some((l) => l.startsWith("heartbeat:")), "heartbeat still present");
  });

  it("does not throw when the client has no getSessionActivity (older/mock client)", async () => {
    const logs = [];
    const client = {
      createSession: async () => ({ id: "s1" }),
      getSessionUsage: async () => ({ total: 0, output: 0, turns: 0 }),
      abortSession: async () => {},
      sendPrompt: async () => { await new Promise((r) => setTimeout(r, 40)); return { text: "ok" }; },
    };
    const res = await dispatchWithRetry({
      client, prompt: "x", agent: "build", extract,
      log: (m) => logs.push(m),
      makeSession: () => client.createSession(),
      beatMs: 10, stallMs: 10_000, backoffMs: 1,
    });
    assert.equal(extract(res.response), "ok");
    assert.ok(!logs.some((l) => l.startsWith("activity:")), "no activity lines without the method");
  });
});

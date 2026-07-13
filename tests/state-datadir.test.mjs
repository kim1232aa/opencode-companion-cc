import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stateRoot, upsertJob, loadState } from "../plugins/opencode/scripts/lib/state.mjs";

describe("stateRoot data-dir selection", () => {
  it("ignores a foreign CLAUDE_PLUGIN_DATA that does not name an opencode dir", () => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    const savedOverride = process.env.OPENCODE_COMPANION_DATA;
    delete process.env.OPENCODE_COMPANION_DATA;
    process.env.CLAUDE_PLUGIN_DATA = "/home/whoever/.claude/plugins/data/codex-openai-codex";
    try {
      const root = stateRoot("/some/workspace");
      // Running from a source checkout (no /cache/ segment), it must fall back
      // to a tmp dir — NOT write into the codex plugin's data dir.
      assert.ok(!root.includes("codex-openai-codex"), root);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = saved;
      if (savedOverride !== undefined) process.env.OPENCODE_COMPANION_DATA = savedOverride;
    }
  });

  it("honors an explicit OPENCODE_COMPANION_DATA override", () => {
    const saved = process.env.OPENCODE_COMPANION_DATA;
    process.env.OPENCODE_COMPANION_DATA = "/tmp/oc-explicit-data";
    try {
      assert.ok(stateRoot("/w").startsWith("/tmp/oc-explicit-data/state/"));
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_COMPANION_DATA;
      else process.env.OPENCODE_COMPANION_DATA = saved;
    }
  });
});

describe("upsertJob pruning", () => {
  it("never evicts a non-terminal job even when many newer jobs exist", () => {
    const saved = process.env.OPENCODE_COMPANION_DATA;
    process.env.OPENCODE_COMPANION_DATA = `/tmp/ocprune-${process.pid}-${Date.now()}`;
    try {
      const w = "/prune/ws";
      upsertJob(w, { id: "long-runner", type: "task", status: "running", pid: process.pid });
      // create 60 completed jobs (> MAX_JOBS 50), all newer
      for (let i = 0; i < 60; i++) {
        upsertJob(w, { id: `done-${i}`, type: "task", status: "completed" });
      }
      const jobs = loadState(w).jobs;
      assert.ok(jobs.some((j) => j.id === "long-runner"), "running job must survive pruning");
      assert.ok(jobs.length <= 51);
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_COMPANION_DATA;
      else process.env.OPENCODE_COMPANION_DATA = saved;
    }
  });
});

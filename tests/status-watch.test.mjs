// `status --watch` — a live panel that costs ZERO Claude tokens.
//
// The problem it solves: while a 4-model fan-out runs for 13 minutes, the only
// progress signal a user had was a Claude agent row, whose "↓ N tokens" is
// CLAUDE's own overhead — it says nothing about how the delegated job is doing,
// only that it hasn't returned. The real signal (OpenCode token progress, the
// activity stream, stall warnings) already existed in `status`; it just had to
// be asked for, one call at a time. --watch repaints it in place, in a second
// terminal, without going anywhere near Claude.
//
// The loop is driven here through injected seams (maxTicks above all), so no
// test ever races a real timer or spins an unbounded loop.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveWatchOptions,
  renderWatchHeader,
  runStatusWatch,
} from "../plugins/opencode/scripts/opencode-companion.mjs";

const ESC = "\x1b";

/** A watch harness: records every frame, sleep and snapshot call. */
function harness({ running = [1, 1, 1], startMs = 0, tickMs = 3000 } = {}) {
  const frames = [];
  const sleeps = [];
  const probes = [];
  let clock = startMs;
  let call = 0;

  return {
    frames, sleeps, probes,
    deps: {
      write: (s) => frames.push(s),
      sleep: async (ms) => { sleeps.push(ms); clock += tickMs; },
      nowMs: () => clock,
      now: () => new Date("2026-07-15T04:05:06Z"),
      snapshot: async (_ws, opts) => {
        probes.push(!!opts.probe);
        const n = running[Math.min(call, running.length - 1)];
        call++;
        return { text: `PANEL ${call}`, running: n };
      },
    },
  };
}

const cfg = (over = {}) => ({
  workspace: "/ws",
  sessionId: "s1",
  ref: undefined,
  intervalMs: 3000,
  probeEveryMs: 15000,
  exitWhenIdle: false,
  isTTY: false,
  ...over,
});

describe("resolveWatchOptions", () => {
  it("defaults to a 3s repaint", () => {
    const o = resolveWatchOptions({}, { isTTY: true });
    assert.equal(o.intervalMs, 3000);
    assert.equal(o.exitWhenIdle, false);
    assert.equal(o.isTTY, true);
  });

  it("honors --interval in SECONDS", () => {
    assert.equal(resolveWatchOptions({ interval: "5" }, { isTTY: false }).intervalMs, 5000);
    assert.equal(resolveWatchOptions({ interval: 1.5 }, { isTTY: false }).intervalMs, 1500);
  });

  it("clamps an absurd interval instead of hammering the state file (or stalling)", () => {
    assert.equal(resolveWatchOptions({ interval: "0.05" }, {}).intervalMs, 1000);   // min 1s
    assert.equal(resolveWatchOptions({ interval: "99999" }, {}).intervalMs, 300000); // max 5m
  });

  it("falls back to the default on a junk --interval", () => {
    assert.equal(resolveWatchOptions({ interval: "abc" }, {}).intervalMs, 3000);
    assert.equal(resolveWatchOptions({ interval: "-4" }, {}).intervalMs, 3000);
  });

  it("never probes the OpenCode server more often than it repaints", () => {
    // Default: a 15s server probe behind a 3s repaint.
    assert.equal(resolveWatchOptions({}, {}).probeEveryMs, 15000);
    // A slow repaint drags the probe out with it, never the other way round.
    assert.equal(resolveWatchOptions({ interval: "60" }, {}).probeEveryMs, 60000);
  });

  it("carries --exit-when-idle and the TTY-ness through", () => {
    const o = resolveWatchOptions({ "exit-when-idle": true }, { isTTY: false });
    assert.equal(o.exitWhenIdle, true);
    assert.equal(o.isTTY, false);
  });
});

describe("renderWatchHeader", () => {
  const head = renderWatchHeader({
    at: new Date("2026-07-15T04:05:06Z"),
    intervalMs: 3000,
    running: 4,
    workspace: "/repo",
  });

  it("proves the panel is alive: a clock and the repaint interval", () => {
    assert.match(head, /refreshed \d{2}:\d{2}:\d{2}/);
    assert.match(head, /every 3s/);
    assert.match(head, /Ctrl-C to exit/);
  });

  it("shows how many jobs are in flight, and where", () => {
    assert.match(head, /4 running · \/repo/);
  });

  it("says whose tokens these are — the confusion this whole flag exists to end", () => {
    assert.match(head, /OPENCODE-side usage/);
    assert.match(head, /0 Claude tokens/);
    assert.match(head, /second terminal/i);
  });
});

describe("runStatusWatch — the loop", () => {
  it("repaints once per tick and sleeps BETWEEN frames, not after the last one", async () => {
    const h = harness();
    const res = await runStatusWatch(cfg(), { ...h.deps, maxTicks: 3 });

    assert.equal(res.ticks, 3);
    assert.equal(h.frames.length, 3);
    assert.deepEqual(h.sleeps, [3000, 3000]); // 3 frames ⇒ 2 waits
    assert.match(h.frames[0], /PANEL 1/);
    assert.match(h.frames[2], /PANEL 3/);
  });

  it("repaints IN PLACE on a TTY (clear + home), like top", async () => {
    const h = harness();
    await runStatusWatch(cfg({ isTTY: true }), { ...h.deps, maxTicks: 2 });
    for (const f of h.frames) {
      assert.ok(f.startsWith(`${ESC}[2J`), "each frame clears the screen first");
      assert.ok(f.includes(`${ESC}[H`), "and homes the cursor");
    }
  });

  it("degrades to plain appended frames when piped — no escape codes in a log", async () => {
    const h = harness();
    await runStatusWatch(cfg({ isTTY: false }), { ...h.deps, maxTicks: 3 });
    for (const f of h.frames) {
      assert.ok(!f.includes(ESC), "a redirected panel must stay greppable");
    }
    assert.ok(h.frames.every((f) => f.startsWith("\n")), "frames are appended, not overwritten");
  });

  it("probes the OpenCode server on its OWN slower clock, not on every repaint", async () => {
    const h = harness({ startMs: 0, tickMs: 3000 }); // 3s repaint, 15s probe
    await runStatusWatch(cfg(), { ...h.deps, maxTicks: 7 });

    // t=0 probe, then 3/6/9/12s skipped, then t=15s probes again.
    assert.deepEqual(h.probes, [true, false, false, false, false, true, false]);
    assert.equal(h.probes.filter(Boolean).length, 2, "7 repaints ⇒ only 2 server probes");
  });

  it("keeps watching an EMPTY board by default (the user may dispatch again)", async () => {
    const h = harness({ running: [0, 0, 0] });
    const res = await runStatusWatch(cfg(), { ...h.deps, maxTicks: 3 });
    assert.equal(res.ticks, 3, "an idle board is a frame, not an exit condition");
    assert.equal(res.idle, true);
  });

  it("stops at the first idle frame with --exit-when-idle", async () => {
    const h = harness({ running: [2, 1, 0, 0, 0] });
    const res = await runStatusWatch(cfg({ exitWhenIdle: true }), { ...h.deps, maxTicks: 10 });
    assert.equal(res.ticks, 3, "runs until nothing is in flight, then quits");
    assert.equal(res.idle, true);
    assert.deepEqual(h.sleeps, [3000, 3000], "no trailing sleep after the final frame");
  });

  it("honors an external stop (Ctrl-C) instead of running to maxTicks", async () => {
    const h = harness();
    let stop = false;
    const res = await runStatusWatch(cfg(), {
      ...h.deps,
      maxTicks: 50,
      shouldStop: () => stop,
      sleep: async (ms) => { h.sleeps.push(ms); stop = true; }, // interrupt after frame 1
    });
    assert.equal(res.ticks, 1);
    assert.equal(h.frames.length, 1);
  });

  it("scopes to a single job when a ref is given", async () => {
    const seen = [];
    const h = harness();
    await runStatusWatch(cfg({ ref: "task-abc-123" }), {
      ...h.deps,
      maxTicks: 1,
      snapshot: async (_ws, opts) => {
        seen.push(opts.ref);
        return { text: "ONE JOB", running: 1 };
      },
    });
    assert.deepEqual(seen, ["task-abc-123"]);
    assert.match(h.frames[0], /ONE JOB/);
  });

  it("puts the header on every frame, so a scrolled-back pipe is still readable", async () => {
    const h = harness();
    await runStatusWatch(cfg(), { ...h.deps, maxTicks: 2 });
    for (const f of h.frames) {
      assert.match(f, /OpenCode delegations · live/);
      assert.match(f, /0 Claude tokens/);
    }
  });
});

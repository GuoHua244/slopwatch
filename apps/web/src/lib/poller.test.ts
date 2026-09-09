import { describe, expect, test } from "bun:test";
import { createPoller } from "./poller";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One-shot timer harness: `fire()` invokes the currently scheduled callback. */
const manualTimers = () => {
  const state = {
    pending: null as (() => void) | null,
    intervalMs: 0,
    clears: 0,
  };
  return {
    timers: {
      set: (callback: () => void, ms: number) => {
        state.pending = callback;
        state.intervalMs = ms;
        return "handle";
      },
      clear: () => {
        state.clears += 1;
        state.pending = null;
      },
    },
    fire: () => state.pending?.(),
    state,
  };
};

/** Visibility harness: `setVisible` flips state and notifies subscribers. */
const visibility = (initial: boolean) => {
  const listeners: (() => void)[] = [];
  let visible = initial;
  return {
    isVisible: () => visible,
    subscribe: (listener: () => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    setVisible: (next: boolean) => {
      visible = next;
      for (const listener of listeners) listener();
    },
    count: () => listeners.length,
  };
};

const recorder = () => {
  const state = { count: 0 };
  return {
    state,
    tick: async () => {
      state.count += 1;
    },
  };
};

describe("createPoller", () => {
  test("ticks immediately on start and schedules the interval", async () => {
    const t = manualTimers();
    const r = recorder();
    const poller = createPoller({
      intervalMs: 5000,
      tick: r.tick,
      timers: t.timers,
      isVisible: () => true,
      onVisibilityChange: visibility(true).subscribe,
    });
    poller.start();
    await flush();
    expect(r.state.count).toBe(1);
    expect(t.state.intervalMs).toBe(5000);
    expect(t.state.pending).not.toBeNull();
    poller.stop();
  });

  test("ticks on each scheduled fire while visible", async () => {
    const t = manualTimers();
    const r = recorder();
    const poller = createPoller({
      intervalMs: 5000,
      tick: r.tick,
      timers: t.timers,
      isVisible: () => true,
      onVisibilityChange: visibility(true).subscribe,
    });
    poller.start();
    await flush();
    t.fire();
    await flush();
    t.fire();
    await flush();
    expect(r.state.count).toBe(3);
    poller.stop();
  });

  test("never overlaps ticks", async () => {
    const t = manualTimers();
    let started = 0;
    const releases: (() => void)[] = [];
    const blockingTick = async () => {
      started += 1;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    };
    const poller = createPoller({
      intervalMs: 5000,
      tick: blockingTick,
      timers: t.timers,
      isVisible: () => true,
      onVisibilityChange: visibility(true).subscribe,
    });
    poller.start();
    await flush();
    expect(started).toBe(1);
    // scheduled fire lands while the first tick is still in flight → skipped
    t.fire();
    await flush();
    expect(started).toBe(1);
    for (const release of releases) release();
    await flush();
    t.fire();
    await flush();
    expect(started).toBe(2);
    for (const release of releases) release();
    await flush();
    poller.stop();
  });

  test("skips ticks while hidden, including the start tick", async () => {
    const t = manualTimers();
    const vis = visibility(false);
    const r = recorder();
    const poller = createPoller({
      intervalMs: 5000,
      tick: r.tick,
      timers: t.timers,
      isVisible: vis.isVisible,
      onVisibilityChange: vis.subscribe,
    });
    poller.start();
    await flush();
    expect(r.state.count).toBe(0);
    t.fire();
    await flush();
    expect(r.state.count).toBe(0);
    // becoming visible triggers exactly one immediate tick
    vis.setVisible(true);
    await flush();
    expect(r.state.count).toBe(1);
    vis.setVisible(false);
    await flush();
    expect(r.state.count).toBe(1);
    t.fire();
    await flush();
    expect(r.state.count).toBe(1);
    poller.stop();
  });

  test("tick errors surface via onError and the loop continues", async () => {
    const t = manualTimers();
    let attempts = 0;
    const errors: unknown[] = [];
    const flakyTick = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
    };
    const poller = createPoller({
      intervalMs: 5000,
      tick: flakyTick,
      onError: (e) => errors.push(e),
      timers: t.timers,
      isVisible: () => true,
      onVisibilityChange: visibility(true).subscribe,
    });
    poller.start();
    await flush();
    expect(attempts).toBe(1);
    expect(errors).toHaveLength(1);
    t.fire();
    await flush();
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
    poller.stop();
  });

  test("stop clears the timer and unsubscribes visibility", async () => {
    const t = manualTimers();
    const vis = visibility(true);
    const r = recorder();
    const poller = createPoller({
      intervalMs: 5000,
      tick: r.tick,
      timers: t.timers,
      isVisible: vis.isVisible,
      onVisibilityChange: vis.subscribe,
    });
    poller.start();
    await flush();
    expect(r.state.count).toBe(1);
    poller.stop();
    expect(t.state.clears).toBe(1);
    expect(vis.count()).toBe(0);
    t.fire();
    await flush();
    vis.setVisible(true);
    await flush();
    expect(r.state.count).toBe(1);
  });

  test("double start is a no-op", async () => {
    const t = manualTimers();
    const vis = visibility(true);
    const r = recorder();
    const poller = createPoller({
      intervalMs: 5000,
      tick: r.tick,
      timers: t.timers,
      isVisible: vis.isVisible,
      onVisibilityChange: vis.subscribe,
    });
    poller.start();
    poller.start();
    await flush();
    expect(r.state.count).toBe(1);
    expect(vis.count()).toBe(1);
    poller.stop();
  });
});

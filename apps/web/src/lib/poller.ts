export type PollerTimers = {
  /** One-shot schedule with setTimeout semantics. */
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type PollerOptions = {
  intervalMs: number;
  tick: () => Promise<void> | void;
  /** Invoked when a tick throws; the loop keeps going either way. */
  onError?: (error: unknown) => void;
  /** Injectable timers; defaults to setTimeout/clearTimeout. */
  timers?: PollerTimers;
  /** Injectable for tests; defaults to document.visibilityState. */
  isVisible?: () => boolean;
  /** Subscribes a listener to visibility changes; returns an unsubscribe fn. */
  onVisibilityChange?: (listener: () => void) => () => void;
};

export type Poller = { start(): void; stop(): void };

const defaultTimers: PollerTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

const documentVisible = (): boolean => document.visibilityState === "visible";

const documentVisibilityChange = (listener: () => void): (() => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/**
 * Interval poller implementing decision 4: tick every ~intervalMs while the
 * tab is visible, tick once immediately on becoming visible, never overlap
 * ticks, and keep the loop alive across tick errors.
 */
export const createPoller = (options: PollerOptions): Poller => {
  const {
    intervalMs,
    tick,
    onError,
    timers = defaultTimers,
    isVisible = documentVisible,
    onVisibilityChange = documentVisibilityChange,
  } = options;

  let started = false;
  let running = false;
  let handle: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const runTick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
    }
  };

  const arm = (): void => {
    // Re-arm before ticking so the chain survives whatever the tick does.
    handle = timers.set(() => {
      arm();
      if (isVisible()) void runTick();
    }, intervalMs);
  };

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribe = onVisibilityChange(() => {
        if (isVisible()) void runTick();
      });
      if (isVisible()) void runTick();
      arm();
    },
    stop() {
      if (!started) return;
      started = false;
      if (handle !== null) timers.clear(handle);
      handle = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
};

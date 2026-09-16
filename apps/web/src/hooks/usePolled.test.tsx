/**
 * Tests for the shared polled core (usePolled / usePolledResource) rendered
 * through react-dom on happy-dom. This is the race class the core exists to
 * prevent: a slow response from a previous generation must never clobber a
 * newer generation's data.
 *
 * happy-dom v20 dropped the separate @happy-dom/global-registrators package,
 * so the realm's globals are registered here by hand: every own property of
 * a fresh GlobalWindow that Bun does not already provide (document, the DOM
 * element classes, …) is copied onto globalThis.
 */
import { describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePolled } from "./usePolled";

const win = new GlobalWindow();
for (const [key, value] of Object.entries(win)) {
  if (!(key in globalThis)) Reflect.set(globalThis, key, value);
}
Reflect.set(globalThis, "window", win);
// Lets React's act() treat this as a test environment (flushing updates).
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type ProbeProps = {
  fetcher: () => Promise<string>;
  deps: number[];
};

/** Captures the hook's latest return for assertions outside the component. */
let observed: { data: string | null; error: string | null } = {
  data: null,
  error: null,
};

const Probe = ({ fetcher, deps }: ProbeProps) => {
  const { data, error } = usePolled(fetcher, deps);
  observed = { data, error: error?.message ?? null };
  return <p>data:{data ?? "none"}</p>;
};

type Harness = {
  root: Root;
  container: HTMLElement;
  rerender: (props: ProbeProps) => Promise<void>;
  text: () => string;
};

const renderProbe = async (props: ProbeProps): Promise<Harness> => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const harness: Harness = {
    root,
    container,
    rerender: async (next) => {
      await act(async () => {
        root.render(<Probe {...next} />);
      });
    },
    text: () => container.textContent ?? "",
  };
  await act(async () => {
    root.render(<Probe {...props} />);
  });
  return harness;
};

const unmountProbe = async (harness: Harness): Promise<void> => {
  await act(async () => {
    harness.root.unmount();
  });
  harness.container.remove();
};

describe("usePolled", () => {
  test("fetches immediately on mount and renders the data", async () => {
    const harness = await renderProbe({
      deps: [0],
      fetcher: () => Promise.resolve("hello"),
    });
    expect(harness.text()).toBe("data:hello");
    expect(observed).toEqual({ data: "hello", error: null });
    await unmountProbe(harness);
  });

  test("a deps change re-runs the new fetcher; the old fetcher's slow stale response never clobbers the new data", async () => {
    let releaseStale: (value: string) => void = () => {};
    const harness = await renderProbe({
      deps: [0],
      // Generation 1 hangs until the test releases it.
      fetcher: () =>
        new Promise<string>((resolve) => {
          releaseStale = resolve;
        }),
    });
    expect(harness.text()).toBe("data:none");

    // Generation 2: deps change, the new fetcher resolves immediately.
    await harness.rerender({
      deps: [1],
      fetcher: () => Promise.resolve("fresh"),
    });
    expect(harness.text()).toBe("data:fresh");

    // The old generation's in-flight fetch lands late — it must be dropped
    // instead of overwriting the new generation's data.
    await act(async () => {
      releaseStale("stale");
    });
    expect(harness.text()).toBe("data:fresh");
    expect(observed).toEqual({ data: "fresh", error: null });
    await unmountProbe(harness);
  });

  test("a failed fetch sets the PollError; the next generation recovers", async () => {
    let attempt = 0;
    const failing = (): Promise<string> => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve("recovered");
    };
    const harness = await renderProbe({ deps: [0], fetcher: failing });
    expect(harness.text()).toBe("data:none");
    expect(observed).toEqual({ data: null, error: "boom" });

    await harness.rerender({ deps: [1], fetcher: failing });
    expect(harness.text()).toBe("data:recovered");
    expect(observed).toEqual({ data: "recovered", error: null });
    await unmountProbe(harness);
  });
});

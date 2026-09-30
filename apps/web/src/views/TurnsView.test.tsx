import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TurnImageRef } from "@slopwatch/events";
import type { SessionTimeline } from "../lib/timeline";
import { TurnsView } from "./TurnsView";

// Turn messages render as markdown (escaped HTML, no rehype-raw). These pins
// hold the safety posture and the user-message fragment flow in place:
// markdown markup becomes elements, raw markup stays text, attachment chips
// still split the fragments inline, and soft line breaks survive.

const win = new Window({ url: "http://localhost/" });
// happy-dom's node classes are structurally incompatible with lib.dom's —
// project once at the boundary; the objects at runtime are happy-dom's
const doc = win.document as unknown as Document;
Object.defineProperty(globalThis, "window", {
  value: win,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "document", {
  value: doc,
  configurable: true,
  writable: true,
});
// react's act() wants the test env flagged
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const image = (n: number): TurnImageRef => ({ n, sha256: `sha-${n}` });

const timeline = (turn: {
  userMessage?: string;
  assistantMessage?: string;
  images?: TurnImageRef[];
}): SessionTimeline => ({
  starts: [],
  ends: [],
  metas: [],
  summaries: [],
  turns: [{ turnId: "t1", modelRequests: [], tools: [], ...turn }],
  orphans: { requests: [], tools: [] },
});

const renderTurns = (tl: SessionTimeline): HTMLElement => {
  const container = doc.createElement("div");
  doc.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TurnsView sessionId="s1" timeline={tl} />);
  });
  return container;
};

const message = (container: HTMLElement, cls: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`blockquote.${cls}`);
  if (el === null) throw new Error(`${cls} not rendered`);
  return el;
};

describe("TurnsView markdown messages", () => {
  test("assistant message renders markdown and escapes raw html", () => {
    const c = renderTurns(
      timeline({
        assistantMessage: "done **fast**\n\n<script>alert(1)</script>",
      }),
    );
    const msg = message(c, "assistant-msg");
    expect(msg.querySelector("strong")?.textContent).toBe("fast");
    expect(msg.querySelector("script")).toBeNull();
    expect(msg.textContent).toContain("<script>alert(1)</script>");
  });

  test("assistant message renders a gfm table", () => {
    const c = renderTurns(
      timeline({ assistantMessage: "| a | b |\n|---|---|\n| 1 | 2 |" }),
    );
    expect(message(c, "assistant-msg").querySelector("table")).not.toBeNull();
  });

  test("user message keeps soft line breaks in its text", () => {
    const c = renderTurns(timeline({ userMessage: "line one\nline two" }));
    expect(message(c, "user-msg").textContent).toContain("line one\nline two");
  });

  test("user message renders markdown around attachment chips", () => {
    const c = renderTurns(
      timeline({ userMessage: "look [image #1] **now**", images: [image(1)] }),
    );
    const msg = message(c, "user-msg");
    expect(msg.querySelector(".msg-img")).not.toBeNull();
    expect(msg.querySelector("strong")?.textContent).toBe("now");
    expect(msg.textContent).not.toContain("[image #1]");
  });

  test("cleanup", () => {
    doc.body.innerHTML = "";
  });
});

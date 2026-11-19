import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionSummary } from "../api/types";
import { SessionList } from "./SessionList";

// A subagent row renders inside its parent's <li>, so a plain click handler
// fires twice — child first, then the bubbling ancestor, whose onSelect wins
// the same React batch. These pins hold the stopPropagation in place: click
// (or Enter) on a nested row selects the nested row and nothing else.

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

const click = (node: Element): void => {
  node.dispatchEvent(
    new win.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent,
  );
};

const session = (
  sessionId: string,
  parentSessionId: string | null = null,
): SessionSummary => ({
  session_id: sessionId,
  agent: "claude-code",
  user_id: "alice",
  first_seen_at: "2026-09-30T00:00:00.000Z",
  last_event_at: null,
  last_seq: 1,
  title: sessionId,
  task_preview: null,
  total_input_tokens: 1,
  total_output_tokens: 1,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
  failed_tool_calls: 0,
  repeated_calls: 0,
  parent_session_id: parentSessionId,
});

const renderList = (
  selectedId: string | null,
  onSelect: (id: string) => void,
): { childRow: HTMLElement } => {
  const container = doc.createElement("div");
  doc.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionList
        sessions={[session("child", "parent"), session("parent")]}
        selectedId={selectedId}
        onSelect={onSelect}
      />,
    );
  });
  // subagent branches start folded — unfold the parent's twistie first
  const twistie = container.querySelector<HTMLButtonElement>("button.twistie");
  if (twistie === null) throw new Error("twistie not found");
  act(() => {
    click(twistie);
  });
  const childRow = container.querySelector<HTMLElement>(
    "ul.sessions ul.sub li",
  );
  if (childRow === null) throw new Error("nested child row not rendered");
  return { childRow };
};

describe("SessionList nested selection", () => {
  test("clicking a subagent row selects the child, not its bubbling ancestor", () => {
    const picked: string[] = [];
    const { childRow } = renderList(null, (id) => picked.push(id));
    act(() => {
      click(childRow);
    });
    expect(picked).toEqual(["child"]); // the bug shipped ["child", "parent"]
  });

  test("Enter on a subagent row selects the child only", () => {
    const picked: string[] = [];
    const { childRow } = renderList(null, (id) => picked.push(id));
    act(() => {
      childRow.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }) as unknown as KeyboardEvent,
      );
    });
    expect(picked).toEqual(["child"]);
  });

  test("cleanup", () => {
    doc.body.innerHTML = "";
  });
});

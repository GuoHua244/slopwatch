import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../api/types";
import { buildSessionForest, stripSubagentPrefix } from "./sessionTree";

const session = (
  sessionId: string,
  parentSessionId: string | null = null,
): SessionSummary => ({
  session_id: sessionId,
  agent: "zcode",
  user_id: "alice",
  first_seen_at: "2026-09-29T00:00:00.000Z",
  last_event_at: null,
  last_seq: 1,
  title: "hello",
  task_preview: null,
  total_input_tokens: 1,
  total_output_tokens: 1,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
  parent_session_id: parentSessionId,
});

describe("buildSessionForest", () => {
  test("nests children under their parent, input order kept", () => {
    const { roots, childrenOf } = buildSessionForest([
      session("child-1", "parent"),
      session("parent"),
      session("child-2", "parent"),
    ]);
    expect(roots.map((s) => s.session_id)).toEqual(["parent"]);
    expect(childrenOf.get("parent")?.map((s) => s.session_id)).toEqual([
      "child-1",
      "child-2",
    ]);
  });

  test("a child whose parent is outside the fetched window stays a root", () => {
    const { roots, childrenOf } = buildSessionForest([
      session("orphan", "gone"),
      session("top"),
    ]);
    expect(roots.map((s) => s.session_id)).toEqual(["orphan", "top"]);
    expect(childrenOf.size).toBe(0);
  });

  test("grandchildren nest under their nested parent", () => {
    const { roots, childrenOf } = buildSessionForest([
      session("grandchild", "child"),
      session("child", "parent"),
      session("parent"),
    ]);
    expect(roots.map((s) => s.session_id)).toEqual(["parent"]);
    expect(childrenOf.get("parent")?.map((s) => s.session_id)).toEqual([
      "child",
    ]);
    expect(childrenOf.get("child")?.map((s) => s.session_id)).toEqual([
      "grandchild",
    ]);
  });
});

describe("stripSubagentPrefix", () => {
  test("removes the listener's ↳ marker", () => {
    expect(stripSubagentPrefix("↳ Search the codebase")).toBe(
      "Search the codebase",
    );
  });

  test("leaves plain titles and null alone", () => {
    expect(stripSubagentPrefix("plain title")).toBe("plain title");
    expect(stripSubagentPrefix(null)).toBeNull();
  });
});

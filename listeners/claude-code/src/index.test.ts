import { describe, expect, test } from "bun:test";
import * as listener from "./index";

describe("claude-code listener", () => {
  test("exports the adapter surface", () => {
    expect(typeof listener.eventsFromRecord).toBe("function");
    expect(typeof listener.metaFromRecord).toBe("function");
    expect(typeof listener.planHook).toBe("function");
    expect(typeof listener.mergeHookConfig).toBe("function");
    expect(listener.HOOK_EVENTS).toContain("SessionEnd");
  });
});

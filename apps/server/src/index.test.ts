import { describe, expect, test } from "bun:test";
import {
  isNormalEvent,
  SCHEMA_VERSION,
  type SessionStartEvent,
} from "@slopwatch/events";

describe("server", () => {
  test("accepts a valid normalized event", () => {
    const event: SessionStartEvent = {
      schema_version: SCHEMA_VERSION,
      agent: "zcode",
      session_id: "s1",
      occurred_at: new Date().toISOString(),
      kind: "session",
      event: "start",
      cwd: "D:\\demo",
      hostname: "DEV-01",
    };
    expect(isNormalEvent(event)).toBe(true);
  });
});

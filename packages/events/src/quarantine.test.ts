import { describe, expect, test } from "bun:test";
import {
  QUARANTINE_MAX_LINE_BYTES,
  isNormalEvent,
  quarantineLine,
} from "./index";

describe("quarantineLine", () => {
  test("builds a valid quarantine event with defaults", () => {
    const event = quarantineLine({
      agent: "zcode",
      session_id: "sess_test",
      reason: "unknown record type: future_thing",
      line: '{"type":"future_thing"}',
    });
    expect(isNormalEvent(event)).toBe(true);
    expect(event.kind).toBe("quarantine");
    expect(event.event).toBe("line");
    expect(event.agent).toBe("zcode");
    expect(event.session_id).toBe("sess_test");
    expect(event.occurred_at).toBeTruthy();
  });

  test("accepts an explicit occurred_at", () => {
    const event = quarantineLine({
      agent: "zcode",
      session_id: "sess_test",
      occurred_at: "2026-09-13T00:00:00.000Z",
      reason: "unparsable json",
      line: "{oops",
    });
    expect(event.occurred_at).toBe("2026-09-13T00:00:00.000Z");
  });

  test("truncates oversized lines with a marker", () => {
    const big = "x".repeat(QUARANTINE_MAX_LINE_BYTES * 4);
    const event = quarantineLine({
      agent: "zcode",
      session_id: "sess_test",
      reason: "unparsable json",
      line: big,
    });
    expect(Buffer.byteLength(event.line, "utf8")).toBeLessThanOrEqual(
      QUARANTINE_MAX_LINE_BYTES + Buffer.byteLength("…[truncated]", "utf8"),
    );
    expect(event.line.endsWith("…[truncated]")).toBe(true);
  });

  test("respects a custom cap", () => {
    const event = quarantineLine({
      agent: "zcode",
      session_id: "sess_test",
      reason: "unparsable json",
      line: "y".repeat(10_000),
      maxLineBytes: 1_000,
    });
    expect(Buffer.byteLength(event.line, "utf8")).toBeLessThanOrEqual(1_100);
    expect(event.line.endsWith("…[truncated]")).toBe(true);
  });

  test("guard rejects malformed quarantine events", () => {
    const base = {
      schema_version: 1,
      agent: "zcode",
      session_id: "sess_test",
      occurred_at: "2026-09-13T00:00:00.000Z",
      kind: "quarantine",
      event: "line",
      reason: "why",
      line: "raw",
    };
    expect(isNormalEvent(base)).toBe(true);
    expect(isNormalEvent({ ...base, reason: "" })).toBe(false);
    expect(isNormalEvent({ ...base, line: 42 })).toBe(false);
    expect(isNormalEvent({ ...base, event: "blob" })).toBe(false);
    expect(isNormalEvent({ ...base, schema_version: 2 })).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  assistantToolUseRecord,
  aiTitleRecord,
  promptRecord,
  summaryRecord,
} from "./fixtures/transcript-record";
import { driftFromRecord } from "./normalizer";

describe("claude-code driftFromRecord (v2 decision 21)", () => {
  test("handled record types are not drift", () => {
    expect(driftFromRecord(promptRecord)).toBeNull();
    expect(driftFromRecord(assistantToolUseRecord)).toBeNull();
    expect(driftFromRecord(summaryRecord)).toBeNull();
    expect(driftFromRecord(aiTitleRecord)).toBeNull();
  });

  test("known-but-ignored client bookkeeping types are not drift", () => {
    for (const type of [
      "queue-operation",
      "attachment",
      "atis-latch",
      "last-prompt",
      "mode",
      "file-history-snapshot",
      "file-history-delta",
      "system",
      "cost-state",
      "permission-mode",
    ]) {
      expect(driftFromRecord({ type })).toBeNull();
    }
  });

  test("non-object and typeless records drift", () => {
    expect(driftFromRecord([1, 2])).toBe("record is not an object");
    expect(driftFromRecord({ uuid: "x" })).toBe("record without a type field");
  });

  test("unknown record types drift", () => {
    expect(driftFromRecord({ type: "compaction" })).toBe(
      "unknown record type: compaction",
    );
    expect(driftFromRecord({ type: "assistant_v2" })).toBe(
      "unknown record type: assistant_v2",
    );
  });
});

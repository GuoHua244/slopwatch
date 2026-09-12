import { describe, expect, test } from "bun:test";
import { mainTurnRecord } from "./fixtures/rollout-record";
import { driftFromRecord, eventsFromRecord } from "./normalizer";

describe("zcode driftFromRecord (v2 decision 21)", () => {
  test("known model_io records are not drift", () => {
    expect(driftFromRecord(mainTurnRecord)).toBeNull();
  });

  test("non-object records drift", () => {
    expect(driftFromRecord("a string")).toBe("record is not an object");
    expect(driftFromRecord(42)).toBe("record is not an object");
  });

  test("typeless records drift", () => {
    expect(driftFromRecord({ foo: 1 })).toBe("record without a type field");
  });

  test("unknown record types drift", () => {
    expect(driftFromRecord({ type: "file_snapshot" })).toBe(
      "unknown record type: file_snapshot",
    );
    expect(driftFromRecord({ type: "model_io_v2" })).toBe(
      "unknown record type: model_io_v2",
    );
  });

  test("model_io records missing required fields drift", () => {
    expect(driftFromRecord({ type: "model_io" })).toBe(
      "model_io record without model.modelId",
    );
    expect(
      driftFromRecord({ type: "model_io", model: { modelId: "glm-4" } }),
    ).toBe("model_io record without durationMs");
    expect(
      driftFromRecord({
        type: "model_io",
        model: { modelId: "glm-4" },
        durationMs: 5,
      }),
    ).toBe("model_io record without a timestamp");
  });

  test("drift and eventsFromRecord stay consistent on valid records", () => {
    // a record that passes the manifest must still produce events
    expect(eventsFromRecord(mainTurnRecord, "sess_x").length).toBeGreaterThan(
      0,
    );
    expect(driftFromRecord(mainTurnRecord)).toBeNull();
  });
});

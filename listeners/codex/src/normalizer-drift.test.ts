import { describe, expect, test } from "bun:test";
import { driftFromRecord, eventsFromRecord, newTailState } from "./normalizer";
import {
  compactedRecord,
  sessionMetaRecord,
  subagentMetaRecord,
  turnContextRecord,
  worldStateRecord,
} from "./fixtures/rollout-record";

describe("codex drift manifest", () => {
  test("known records pass, bookkeeping records stay quiet", () => {
    expect(driftFromRecord(sessionMetaRecord)).toBeNull();
    expect(driftFromRecord(subagentMetaRecord)).toBeNull();
    expect(driftFromRecord(turnContextRecord)).toBeNull();
    expect(driftFromRecord(worldStateRecord)).toBeNull();
    expect(driftFromRecord(compactedRecord)).toBeNull();
    expect(
      driftFromRecord({
        type: "event_msg",
        payload: { type: "item_completed", item: {} },
      }),
    ).toBeNull();
  });

  test("structural breaks quarantine", () => {
    expect(driftFromRecord(null)).toBe("record is not an object");
    expect(driftFromRecord([1, 2])).toBe("record is not an object");
    expect(driftFromRecord({ payload: {} })).toBe(
      "record without a type field",
    );
    expect(driftFromRecord({ type: "response_item" })).toBe(
      "response_item record without a payload object",
    );
    expect(
      driftFromRecord({ type: "session_meta", payload: { session_id: "x" } }),
    ).toBe("session_meta without payload.id");
  });

  test("unknown types quarantine with their name", () => {
    expect(driftFromRecord({ type: "brand_new_envelope", payload: {} })).toBe(
      "unknown record type: brand_new_envelope",
    );
    expect(
      driftFromRecord({
        type: "response_item",
        payload: { type: "collab_agent_spawn" },
      }),
    ).toBe("unknown response_item payload type: collab_agent_spawn");
    expect(
      driftFromRecord({
        type: "event_msg",
        payload: { type: "guardian_review_end" },
      }),
    ).toBe("unknown event_msg payload type: guardian_review_end");
  });

  test("known types with missing optional payload fields stay lenient", () => {
    const state = newTailState();
    // a token_count without info produces nothing — no quarantine
    expect(
      driftFromRecord({ type: "event_msg", payload: { type: "token_count" } }),
    ).toBeNull();
    expect(
      eventsFromRecord(
        { type: "event_msg", payload: { type: "token_count" } },
        "sess_x",
        state,
      ),
    ).toEqual([]);
    // a response_item without a payload type field stays lenient (only
    // string payload types are manifest-checked)
    expect(driftFromRecord({ type: "response_item", payload: {} })).toBeNull();
  });
});

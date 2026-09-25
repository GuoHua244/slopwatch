import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { NormalEvent } from "@slopwatch/events";
import type { Store } from "./store";

// Feedback persistence semantics (ADR 0009): rows anchor optionally to a
// session, attachments land content-addressed and cascade with their row.
// DB-backed like the other store tests — skipped when no test database is
// configured.
const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const startEvent = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-25T00:00:00.000Z",
  kind: "session",
  event: "start",
  cwd: "C:\\work",
  hostname: "test-host",
});

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

const file = (bytes: Buffer, filename = "shot.png", mime = "image/png") => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  filename,
  mime,
  size: bytes.length,
  data: bytes,
});

describe.skipIf(!dbTests())("feedback store (ADR 0009)", () => {
  let store: Store | undefined;
  const ensure = async (): Promise<Store> => {
    if (store) return store;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    return store;
  };

  test("a session-anchored feedback round-trips; the list is newest first with totals", async () => {
    const s = await ensure();
    const sessionId = `sess_fb-${randomUUID()}`;
    await s.appendEvents([startEvent(sessionId)], null);

    const first = await s.addFeedback({
      filerId: "alice",
      kind: "missing_content",
      body: "turn 3 vanished",
      sessionId,
    });
    expect(first).not.toBeNull();
    expect(first!.filer_id).toBe("alice");
    expect(first!.session_id).toBe(sessionId);
    expect(first!.kind).toBe("missing_content");
    expect(first!.body).toBe("turn 3 vanished");

    const second = await s.addFeedback({
      filerId: "bob",
      kind: "feature_suggestion",
      body: "add charts",
      sessionId: null,
    });
    expect(second).not.toBeNull();
    expect(second!.session_id).toBeNull();

    const list = await s.listFeedback({ limit: 10, offset: 0 });
    expect(list.total).toBeGreaterThanOrEqual(2);
    const ids = list.rows.map((r) => r.feedback_id);
    expect(ids.indexOf(second!.feedback_id)).toBeLessThan(
      ids.indexOf(first!.feedback_id),
    );
  });

  test("an unknown session anchors nothing — null, not a row", async () => {
    const s = await ensure();
    const row = await s.addFeedback({
      filerId: "alice",
      kind: "wrong_data",
      body: "tokens look off",
      sessionId: `sess_fb-${randomUUID()}`,
    });
    expect(row).toBeNull();
  });

  test("the kind filter narrows rows; pagination slices without losing total", async () => {
    const s = await ensure();
    const sessionId = `sess_fb-${randomUUID()}`;
    await s.appendEvents([startEvent(sessionId)], null);
    const a = await s.addFeedback({
      filerId: "alice",
      kind: "wrong_data",
      body: "a",
      sessionId: null,
    });
    await s.addFeedback({
      filerId: "alice",
      kind: "other",
      body: "b",
      sessionId: null,
    });
    expect(a).not.toBeNull();

    const only = await s.listFeedback({
      limit: 10,
      offset: 0,
      kind: "wrong_data",
    });
    expect(only.total).toBeGreaterThanOrEqual(1);
    expect(only.rows.every((r) => r.kind === "wrong_data")).toBe(true);

    const page = await s.listFeedback({ limit: 1, offset: 0 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBeGreaterThanOrEqual(2);
  });

  test("delete removes one row; an unknown id is false", async () => {
    const s = await ensure();
    const row = await s.addFeedback({
      filerId: "alice",
      kind: "compatibility",
      body: "codex events unhandled",
      sessionId: null,
    });
    expect(row).not.toBeNull();
    expect(await s.deleteFeedback(row!.feedback_id)).toBe(true);
    expect(await s.getFeedback(row!.feedback_id)).toBeNull();
    expect(await s.deleteFeedback(row!.feedback_id)).toBe(false);
  });

  test("attachment bytes are content-addressed, deduped, and cascade with the row", async () => {
    const s = await ensure();
    const row = await s.addFeedback({
      filerId: "alice",
      kind: "missing_content",
      body: "see screenshot",
      sessionId: null,
    });
    expect(row).not.toBeNull();
    const id = row!.feedback_id;
    expect(row!.attachments).toHaveLength(0);

    const bytes = file(png);
    await s.addFeedbackAttachments(id, [bytes, bytes]); // duplicate sha
    const stored = await s.getFeedback(id);
    expect(stored!.attachments).toHaveLength(1);
    expect(stored!.attachments[0]!.sha256).toBe(bytes.sha256);
    expect(stored!.attachments[0]!.filename).toBe("shot.png");
    expect(stored!.attachments[0]!.mime).toBe("image/png");
    expect(stored!.attachments[0]!.size).toBe(png.length);

    const read = await s.getFeedbackAttachment(id, bytes.sha256);
    expect(read).not.toBeNull();
    expect(read!.mime).toBe("image/png");
    expect(Buffer.from(read!.data).equals(png)).toBe(true);
    expect(await s.getFeedbackAttachment(id, "f".repeat(64))).toBeNull();

    expect(await s.deleteFeedback(id)).toBe(true);
    expect(await s.getFeedback(id)).toBeNull();
    expect(await s.getFeedbackAttachment(id, bytes.sha256)).toBeNull();
  });

  test("deleting the anchored session cascades the feedback and its attachments", async () => {
    const s = await ensure();
    const sessionId = `sess_fb-${randomUUID()}`;
    await s.appendEvents([startEvent(sessionId)], null);
    const row = await s.addFeedback({
      filerId: "alice",
      kind: "wrong_data",
      body: "cost looks doubled",
      sessionId,
    });
    expect(row).not.toBeNull();
    const id = row!.feedback_id;
    await s.addFeedbackAttachments(id, [file(png, "chart.png")]);

    expect(await s.deleteSession(sessionId)).toBe(true);
    expect(await s.getFeedback(id)).toBeNull();
    expect(
      await s.getFeedbackAttachment(id, file(png, "chart.png").sha256),
    ).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { AttachmentEvent, NormalEvent } from "@slopwatch/events";
import type { Store } from "./store";

// Captured-image storage semantics: bytes land content-addressed in the
// attachments table, never in the event log. DB-backed like the other store
// tests — skipped when no test database is configured.
const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([1, 2, 3]),
]);

const attachmentEvent = (
  sessionId: string,
  bytes: Buffer = png,
): AttachmentEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-17T00:00:00.000Z",
  kind: "attachment",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  mime: "image/png",
  size: bytes.length,
  data: bytes.toString("base64"),
  origin: "user_message",
});

const startEvent = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-17T00:00:00.000Z",
  kind: "session",
  event: "start",
  cwd: "C:\\work",
  hostname: "test-host",
});

describe.skipIf(!dbTests())("attachment store semantics", () => {
  let store: Store | undefined;
  const ensure = async (): Promise<Store> => {
    if (store) return store;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    return store;
  };

  test("bytes land in the attachments table, never the event log", async () => {
    const s = await ensure();
    const sessionId = `sess_att-${randomUUID()}`;
    const attachment = attachmentEvent(sessionId);
    const { accepted } = await s.appendEvents(
      [startEvent(sessionId), attachment],
      null,
    );
    expect(accepted).toBe(2);

    const events = await s.eventsSince(sessionId, 0);
    expect(events.map((e) => e.event.kind)).toEqual(["session"]);

    const stored = await s.getAttachment(sessionId, attachment.sha256);
    expect(stored).not.toBeNull();
    expect(stored!.mime).toBe("image/png");
    expect(Buffer.from(stored!.data).equals(png)).toBe(true);
  });

  test("re-shipping the same sha is a no-op, not an error", async () => {
    const s = await ensure();
    const sessionId = `sess_att-${randomUUID()}`;
    const attachment = attachmentEvent(sessionId);
    await s.appendEvents([startEvent(sessionId), attachment], null);
    await expect(
      s.appendEvents([attachmentEvent(sessionId)], null),
    ).resolves.toEqual({ accepted: 1 });
    expect((await s.getAttachment(sessionId, attachment.sha256)) !== null).toBe(
      true,
    );
  });

  test("a payload failing integrity is skipped; the batch still lands", async () => {
    const s = await ensure();
    const sessionId = `sess_att-${randomUUID()}`;
    const corrupted = attachmentEvent(sessionId);
    // declared sha no longer matches the bytes — the ingest must skip it
    const other = Buffer.concat([png, Buffer.from([9])]);
    corrupted.data = other.toString("base64");
    corrupted.size = other.length;
    const { accepted } = await s.appendEvents(
      [startEvent(sessionId), corrupted],
      null,
    );
    expect(accepted).toBe(2);
    expect(await s.getAttachment(sessionId, corrupted.sha256)).toBeNull();
  });

  test("deleteSession removes the session's attachments with it", async () => {
    const s = await ensure();
    const sessionId = `sess_att-${randomUUID()}`;
    const attachment = attachmentEvent(sessionId);
    await s.appendEvents([startEvent(sessionId), attachment], null);
    expect(await s.deleteSession(sessionId)).toBe(true);
    expect(await s.getAttachment(sessionId, attachment.sha256)).toBeNull();
  });
});

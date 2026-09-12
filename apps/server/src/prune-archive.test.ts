import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NormalEvent } from "@slopwatch/events";
import type { Store } from "./store";

// v2 decision 24: raw payloads expire on the owning user's current team TTL
// (else the global default), and each payload lands in the archive sink
// before the column is nulled. A failing upload keeps the row for retry.
const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const eventWithRaw = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-13T00:00:00.000Z",
  kind: "session",
  event: "start",
  cwd: "C:\\work",
  hostname: "test-host",
  raw: { type: "session_start", blob: "precious-payload" },
});

describe.skipIf(!dbTests())("per-team retention and archive", () => {
  let store: Store | undefined;
  const ensure = async (): Promise<Store> => {
    if (store) return store;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    return store;
  };

  const backdate = async (sessionId: string, days: number): Promise<void> => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: testDsn() });
    await pool.query(
      `UPDATE events SET received_at = now() - ($2 || ' days')::interval WHERE session_id = $1`,
      [sessionId, days],
    );
    await pool.end();
  };

  test("team TTL override governs; archive-before-null; no double archive", async () => {
    const s = await ensure();
    const user = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(user, null);
    const team = await s.createTeam(`ttl-${randomUUID().slice(0, 8)}`, 1);
    await s.setUserTeam(user, team.id);

    // in the team (1-day TTL, backdated 2 days) → expires
    const shortId = `sess_ttl-${randomUUID()}`;
    await s.appendEvents([eventWithRaw(shortId)], user);
    await backdate(shortId, 2);
    // no team → global default (90 days) → far from expiry
    const noTeamUser = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(noTeamUser, null);
    const longId = `sess_ttl-${randomUUID()}`;
    await s.appendEvents([eventWithRaw(longId)], noTeamUser);
    await backdate(longId, 2);

    const archivedKeys: string[] = [];
    const result = await s.pruneRaw({
      defaultDays: 90,
      archive: {
        putObject: async (key) => {
          archivedKeys.push(key);
        },
      },
    });
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    expect(archivedKeys.some((k) => k.includes(shortId))).toBe(true);
    expect(archivedKeys.some((k) => k.includes(longId))).toBe(false);

    // a second run must not re-archive: nulled rows are no longer candidates
    const second: string[] = [];
    await s.pruneRaw({
      defaultDays: 90,
      archive: {
        putObject: async (key) => {
          second.push(key);
        },
      },
    });
    expect(second.some((k) => k.includes(shortId))).toBe(false);
  });

  test("a failing archive upload keeps the payload for the next run", async () => {
    const s = await ensure();
    const user = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(user, null);
    const team = await s.createTeam(`ttl-${randomUUID().slice(0, 8)}`, 1);
    await s.setUserTeam(user, team.id);
    const sessionId = `sess_ttl-${randomUUID()}`;
    await s.appendEvents([eventWithRaw(sessionId)], user);
    await backdate(sessionId, 2);

    await s.pruneRaw({
      defaultDays: 90,
      archive: {
        putObject: async () => {
          throw new Error("minio unreachable");
        },
      },
    });
    // the row survives — and a later successful run archives it
    const keys: string[] = [];
    const result = await s.pruneRaw({
      defaultDays: 90,
      archive: {
        putObject: async (key) => {
          keys.push(key);
        },
      },
    });
    expect(keys.some((k) => k.includes(sessionId))).toBe(true);
    expect(result.pruned).toBeGreaterThanOrEqual(1);
  });

  test("without a sink, pruning still nulls expired payloads", async () => {
    const s = await ensure();
    const user = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(user, null);
    const team = await s.createTeam(`ttl-${randomUUID().slice(0, 8)}`, 1);
    await s.setUserTeam(user, team.id);
    const sessionId = `sess_ttl-${randomUUID()}`;
    await s.appendEvents([eventWithRaw(sessionId)], user);
    await backdate(sessionId, 2);
    const result = await s.pruneRaw({ defaultDays: 90 });
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    expect(result.archived).toBe(0);
  });
});

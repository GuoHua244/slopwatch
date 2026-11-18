import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { createPgStore } from "./index";
import type { Store } from "./types";

// ADR 0011, against real Postgres: the SQL the http-layer tests can only
// script — hash round-trips, session resolution exclusions, cascade
// deletes, and the revoke-all-but-mine sweep. Skipped cleanly when no test
// database is configured, like every DB-backed suite.
const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

describe.skipIf(!dbTests())("auth sessions store (ADR 0011)", () => {
  let store: Store;
  let pool: Pool;
  // Run-unique names keep the persistent test database clean.
  const user = `pw-${crypto.randomUUID().slice(0, 8)}`;
  const other = `pw-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    store = createPgStore(testDsn());
    pool = new Pool({ connectionString: testDsn() });
    await store.migrate();
    await store.createUser(user, null);
    await store.createUser(other, null);
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  test("password hashes round-trip and light up password_set", async () => {
    expect((await store.getPasswordAuth(user))?.passwordHash).toBeNull();
    expect((await store.getUser(user))?.password_set).toBe(false);
    expect(await store.setPasswordHash(user, "$argon2id$stored-hash")).toBe(
      true,
    );
    expect((await store.getPasswordAuth(user))?.passwordHash).toBe(
      "$argon2id$stored-hash",
    );
    expect((await store.getUser(user))?.password_set).toBe(true);
  });

  test("getPasswordAuth carries the disabled flag", async () => {
    await store.setUserDisabled(user, true);
    expect(await store.getPasswordAuth(user)).toEqual({
      passwordHash: "$argon2id$stored-hash",
      disabled: true,
    });
    await store.setUserDisabled(user, false);
  });

  test("a created session resolves for its user — and refreshes without losing resolve", async () => {
    const { token, session_id } = await store.createAuthSession(user);
    expect(token.startsWith("swsess_")).toBe(true);
    expect(session_id).toBeDefined();
    expect(await store.resolveAuthSession(token)).toBe(user);
    // The one-hour freshness guard means a back-to-back resolve still hits.
    expect(await store.resolveAuthSession(token)).toBe(user);
    expect(await store.revokeAuthSession(token)).toBe(true);
    expect(await store.resolveAuthSession(token)).toBeNull();
    // A second revoke finds nothing left to do.
    expect(await store.revokeAuthSession(token)).toBe(false);
  });

  test("an unknown token resolves to nothing", async () => {
    expect(
      await store.resolveAuthSession("swsess_not-a-real-session"),
    ).toBeNull();
  });

  test("a disabled user's session does not resolve; re-enabled it does", async () => {
    const { token } = await store.createAuthSession(user);
    await store.setUserDisabled(user, true);
    expect(await store.resolveAuthSession(token)).toBeNull();
    await store.setUserDisabled(user, false);
    expect(await store.resolveAuthSession(token)).toBe(user);
    await store.revokeAuthSession(token);
  });

  test("revokeAllAuthSessions spares only the exceptHash", async () => {
    const a = await store.createAuthSession(user);
    const b = await store.createAuthSession(user);
    const c = await store.createAuthSession(user);
    const { hashToken } = await import("./rows");
    const count = await store.revokeAllAuthSessions(user, hashToken(b.token));
    expect(count).toBe(2);
    expect(await store.resolveAuthSession(a.token)).toBeNull();
    expect(await store.resolveAuthSession(b.token)).toBe(user);
    expect(await store.resolveAuthSession(c.token)).toBeNull();
    await store.revokeAllAuthSessions(user);
    expect(await store.resolveAuthSession(b.token)).toBeNull();
  });

  test("revokeAllAuthSessions never touches another user's sessions", async () => {
    const theirs = await store.createAuthSession(other);
    await store.revokeAllAuthSessions(user);
    expect(await store.resolveAuthSession(theirs.token)).toBe(other);
  });

  test("clearPassword blanks the hash and password_set", async () => {
    await store.setPasswordHash(user, "$argon2id$stored-hash");
    expect(await store.clearPassword(user)).toBe(true);
    expect((await store.getPasswordAuth(user))?.passwordHash).toBeNull();
    expect((await store.getUser(user))?.password_set).toBe(false);
  });

  test("clearPassword is false for an unknown user", async () => {
    expect(await store.clearPassword("pw-nobody-here")).toBe(false);
  });

  test("deleting the user cascades their sessions away", async () => {
    const { token } = await store.createAuthSession(other);
    await store.deleteUser(other);
    expect(await store.resolveAuthSession(token)).toBeNull();
    expect(await store.getPasswordAuth(other)).toBeNull();
  });
});

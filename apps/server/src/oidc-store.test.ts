import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { OidcIdentity } from "./oidc";
import type { Store } from "./store";

// ADR 0005: mapping a verified identity onto users rows is SQL semantics —
// email precedence, first-sight provisioning, disabled lockout — so this is
// DB-backed like the other store tests.
const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const identity = (overrides: Partial<OidcIdentity> = {}): OidcIdentity => ({
  subject: `sub-${randomUUID().slice(0, 8)}`,
  email: `${randomUUID().slice(0, 8)}@corp.dev`,
  preferredUsername: `pu-${randomUUID().slice(0, 8)}`,
  name: null,
  ...overrides,
});

describe.skipIf(!dbTests())("OIDC identity mapping (ADR 0005)", () => {
  let store: Store | undefined;
  const ensure = async (): Promise<Store> => {
    if (store) return store;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    return store;
  };

  test("a first sighting provisions the user row", async () => {
    const s = await ensure();
    const id = identity();
    expect(await s.resolveOidcUser(id)).toBe(id.preferredUsername);
    const row = await s.getUser(id.preferredUsername!);
    expect(row).not.toBeNull();
    expect(row!.email).toBe(id.email);
    expect(row!.disabled).toBe(false);
    // team and DRI stay admin decisions
    expect(row!.team_id).toBeNull();
    expect(row!.is_dri).toBe(false);
  });

  test("a second sighting reuses the provisioned row", async () => {
    const s = await ensure();
    const id = identity();
    expect(await s.resolveOidcUser(id)).toBe(id.preferredUsername);
    expect(await s.resolveOidcUser(id)).toBe(id.preferredUsername);
  });

  test("the email claim wins over the username claim", async () => {
    const s = await ensure();
    const existing = `u-${randomUUID().slice(0, 8)}`;
    const email = `${randomUUID().slice(0, 8)}@corp.dev`;
    await s.createUser(existing, email);
    const id = identity({
      email,
      preferredUsername: `other-${randomUUID().slice(0, 6)}`,
    });
    expect(await s.resolveOidcUser(id)).toBe(existing);
  });

  test("an existing username claims the identity when no email matches", async () => {
    const s = await ensure();
    const existing = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(existing, null);
    const id = identity({
      email: `${randomUUID().slice(0, 8)}@corp.dev`,
      preferredUsername: existing,
    });
    expect(await s.resolveOidcUser(id)).toBe(existing);
  });

  test("a disabled user stays locked out", async () => {
    const s = await ensure();
    const id = identity();
    const name = await s.resolveOidcUser(id);
    expect(name).not.toBeNull();
    await s.setUserDisabled(name!, true);
    expect(await s.resolveOidcUser(id)).toBeNull();

    // a disabled row holding the email locks the email path out too
    const other = identity({
      preferredUsername: `pu-${randomUUID().slice(0, 8)}`,
    });
    const first = await s.resolveOidcUser(other);
    expect(first).not.toBeNull();
    await s.setUserDisabled(first!, true);
    const reissue = identity({
      email: other.email,
      preferredUsername: other.preferredUsername,
    });
    expect(await s.resolveOidcUser(reissue)).toBeNull();
  });
});

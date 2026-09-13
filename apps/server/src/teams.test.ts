import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NormalEvent } from "@slopwatch/events";
import { NoSuchTeamError, type Store } from "./store";

// v2 decision 23 / ADR 0004: teams, one-team-per-user, and the session team
// snapshot. DB-backed like the other store tests — the SQL semantics (FK,
// ON DELETE SET NULL, snapshot isolation) are exactly what is under test.
const dbTests = () =>
  (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) !== undefined;
const testDsn = () =>
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!;

const startEvent = (sessionId: string): NormalEvent => ({
  schema_version: 1,
  agent: "zcode",
  session_id: sessionId,
  occurred_at: "2026-09-13T00:00:00.000Z",
  kind: "session",
  event: "start",
  cwd: "C:\\work",
  hostname: "test-host",
});

describe.skipIf(!dbTests())("team store semantics", () => {
  let store: Store | undefined;
  const ensure = async (): Promise<Store> => {
    if (store) return store;
    const { createPgStore } = await import("./store");
    store = createPgStore(testDsn());
    await store.migrate();
    return store;
  };

  test("team lifecycle: create, list, rename, retention, delete", async () => {
    const s = await ensure();
    const name = `team-${randomUUID().slice(0, 8)}`;
    const team = await s.createTeam(name, 30);
    expect(team.name).toBe(name);
    expect(team.raw_retention_days).toBe(30);
    expect(team.member_count).toBe(0);

    // duplicate names are rejected
    expect(s.createTeam(name, null)).rejects.toMatchObject({
      name: "TeamExistsError",
    });

    const listed = await s.listTeams();
    expect(listed.some((t) => t.id === team.id)).toBe(true);

    const renamed = await s.updateTeam(team.id, {
      name: `${name}-renamed`,
      raw_retention_days: null,
    });
    expect(renamed!.name).toBe(`${name}-renamed`);
    expect(renamed!.raw_retention_days).toBeNull();
    expect(await s.updateTeam(randomUUID(), { name: "x" })).toBeNull();

    expect(await s.deleteTeam(team.id)).toBe(true);
    expect(await s.deleteTeam(team.id)).toBe(false);
  });

  test("setUserTeam validates the team, one team per user, unassign works", async () => {
    const s = await ensure();
    const user = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(user, null);
    const a = await s.createTeam(`a-${randomUUID().slice(0, 8)}`, null);
    const b = await s.createTeam(`b-${randomUUID().slice(0, 8)}`, null);

    await expect(s.setUserTeam(user, randomUUID())).rejects.toMatchObject({
      name: "NoSuchTeamError",
    });

    const inA = await s.setUserTeam(user, a.id);
    expect(inA!.team_id).toBe(a.id);
    expect(inA!.team_name).toBe(a.name);

    // moving the user does not error — the new team only owns future sessions
    const inB = await s.setUserTeam(user, b.id);
    expect(inB!.team_id).toBe(b.id);

    const unassigned = await s.setUserTeam(user, null);
    expect(unassigned!.team_id).toBeNull();

    expect(await s.setUserTeam(`nope-${randomUUID()}`, a.id)).toBeNull();
  });

  test("teamsWithMembers groups users by their current team", async () => {
    const s = await ensure();
    const user = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(user, null);
    const team = await s.createTeam(`m-${randomUUID().slice(0, 8)}`, null);
    await s.setUserTeam(user, team.id);
    const teams = await s.teamsWithMembers();
    const mine = teams.find((t) => t.id === team.id)!;
    expect(mine.members).toContain(user);
  });

  test("a session snapshots the creator's team at ingest; reassignment never moves it", async () => {
    const s = await ensure();
    const user = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(user, null);
    const a = await s.createTeam(`snap-a-${randomUUID().slice(0, 6)}`, null);
    const b = await s.createTeam(`snap-b-${randomUUID().slice(0, 6)}`, null);
    await s.setUserTeam(user, a.id);

    const sessionId = `sess_team-${randomUUID()}`;
    await s.appendEvents([startEvent(sessionId)], user);

    // user moves to team B after the session was created
    await s.setUserTeam(user, b.id);

    const sessions = await s.listSessions();
    const mine = sessions.find((row) => row.session_id === sessionId)!;
    expect(mine.team_id).toBe(a.id); // ADR 0004: history follows where it happened
    expect(mine.user_id).toBe(user);
  });

  test("a session created before any team assignment stays unassigned", async () => {
    const s = await ensure();
    const user = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(user, null);
    const sessionId = `sess_team-${randomUUID()}`;
    await s.appendEvents([startEvent(sessionId)], user);
    const sessions = await s.listSessions();
    const mine = sessions.find((row) => row.session_id === sessionId)!;
    expect(mine.team_id).toBeNull();
  });

  test("listSessions filters on the team snapshot; unassigned picks the NULL bucket", async () => {
    const s = await ensure();
    const user = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(user, null);
    const team = await s.createTeam(`f-${randomUUID().slice(0, 6)}`, null);
    await s.setUserTeam(user, team.id);
    const inTeam = `sess_filter-${randomUUID()}`;
    await s.appendEvents([startEvent(inTeam)], user);

    const loner = `u-${randomUUID().slice(0, 8)}`;
    await s.createUser(loner, null);
    const unassigned = `sess_filter-${randomUUID()}`;
    await s.appendEvents([startEvent(unassigned)], loner);

    const teamSessionIds = (await s.listSessions(team.id)).map(
      (row) => row.session_id,
    );
    expect(teamSessionIds).toContain(inTeam);
    expect(teamSessionIds).not.toContain(unassigned);

    const unassignedIds = (await s.listSessions("unassigned")).map(
      (row) => row.session_id,
    );
    expect(unassignedIds).toContain(unassigned);
    expect(unassignedIds).not.toContain(inTeam);

    const everything = (await s.listSessions()).map((row) => row.session_id);
    expect(everything).toContain(inTeam);
    expect(everything).toContain(unassigned);
  });
});

/**
 * Acceptance smoke for a RUNNING server: exercise the planes a real
 * deployment serves — health, event ingest (including the assistant's
 * response text riding on model_request), the sessions/events reads,
 * the rollups snapshot and its team scope, the review-note lifecycle
 * (add → listed → author delete → gone), and the audit trail those
 * mutations leave behind (needs ACCEPTANCE_ADMIN_TOKEN). Every check
 * prints a PASS line; the first failure exits nonzero.
 *
 * Usage: bun apps/server/src/acceptance.ts   (env: ACCEPTANCE_URL,
 * ACCEPTANCE_TOKEN, ACCEPTANCE_ADMIN_TOKEN — defaults match a local dev
 * server)
 */
const base = (process.env.ACCEPTANCE_URL ?? "http://127.0.0.1:8787").replace(
  /\/+$/,
  "",
);
const token = process.env.ACCEPTANCE_TOKEN ?? "acceptance-token";
let failures = 0;

const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const req = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
  });
  return res;
};

const SCHEMA_VERSION = 1;
const sessionId = `sess_acceptance-${crypto.randomUUID().slice(0, 8)}`;
const answer = "Acceptance: the agent's final answer round-trips.";

// 1. The ops probe stays anonymous and answers.
const health = await fetch(`${base}/healthz`);
check(
  "GET /healthz is 200 ok",
  health.status === 200 && (await health.json()).ok === true,
);

// 2. A listener-shaped batch lands: session start, turn, request (with the
// assistant's answer), tool call.
const post = await req("/events", {
  method: "POST",
  body: JSON.stringify({
    schema_version: SCHEMA_VERSION,
    events: [
      {
        schema_version: SCHEMA_VERSION,
        agent: "zcode",
        session_id: sessionId,
        occurred_at: new Date().toISOString(),
        kind: "session",
        event: "start",
        cwd: "D:\\acceptance",
        hostname: "CI",
      },
      {
        schema_version: SCHEMA_VERSION,
        agent: "zcode",
        session_id: sessionId,
        occurred_at: new Date().toISOString(),
        kind: "turn",
        event: "start",
        turn_id: "turn_acc_1",
        user_message: "acceptance prompt",
      },
      {
        schema_version: SCHEMA_VERSION,
        agent: "zcode",
        session_id: sessionId,
        occurred_at: new Date().toISOString(),
        kind: "model_request",
        provider: "builtin:acceptance",
        model: "GLM-5.3-Flash",
        duration_ms: 1200,
        turn_id: "turn_acc_1",
        usage: { input_tokens: 10, output_tokens: 5 },
        response_text: answer,
      },
      {
        schema_version: SCHEMA_VERSION,
        agent: "zcode",
        session_id: sessionId,
        occurred_at: new Date().toISOString(),
        kind: "tool",
        event: "call",
        tool_call_id: "tc_acc_1",
        tool: "Bash",
        args: { command: "echo acceptance" },
      },
    ],
  }),
});
check(
  "POST /events accepts a listener batch",
  post.status === 202 || post.status === 200,
);

// 3. The read plane answers org-wide and carries the round-tripped answer.
const sessions = await (await req("/sessions")).json();
const listed = (sessions.sessions ?? []).find(
  (s: { session_id: string }) => s.session_id === sessionId,
);
check(
  "GET /sessions lists the ingested session with last_event_at",
  listed !== undefined && typeof listed.last_event_at === "string",
);
const page = await (
  await req(`/sessions/${sessionId}/events?since_seq=0`)
).json();
const events = page.events ?? [];
const withAnswer = events.some(
  (e: { event: { kind?: string; response_text?: string } }) =>
    e.event.kind === "model_request" && e.event.response_text === answer,
);
check("GET events round-trips the assistant response text", withAnswer);

// 4. Rollups answer with the snapshot shape, scoped and unscoped.
const rollups = await (await req("/rollups")).json();
check(
  "GET /rollups returns the six-window snapshot",
  [
    "totals",
    "model_totals",
    "daily",
    "user_hourly",
    "model_daily",
    "model_hourly",
  ].every((k) => Array.isArray(rollups[k])),
);
const scoped = await req("/rollups?team_id=unassigned");
check("GET /rollups?team_id answers 200", scoped.status === 200);

// 5. Review notes: add → listed → author delete → gone (404 after).
const added = await req(`/sessions/${sessionId}/comments`, {
  method: "POST",
  body: JSON.stringify({ body: "acceptance note" }),
});
const note = added.status === 201 ? (await added.json()).comment : null;
check("POST comment returns 201 with the stored row", note !== null);
const listedComments = await (
  await req(`/sessions/${sessionId}/comments`)
).json();
check(
  "GET comments lists the note",
  (listedComments.comments ?? []).some(
    (c: { comment_id: number }) => c.comment_id === note?.comment_id,
  ),
);
const gone = await req(`/sessions/${sessionId}/comments/${note?.comment_id}`, {
  method: "DELETE",
});
check("DELETE own note returns 204", gone.status === 204);
const repeat = await req(
  `/sessions/${sessionId}/comments/${note?.comment_id}`,
  { method: "DELETE" },
);
check("DELETE an already-deleted note returns 404", repeat.status === 404);

// 6. Anonymous reads stay rejected (decision 22).
const anon = await fetch(`${base}/sessions`);
check("anonymous GET /sessions is 401", anon.status === 401);

// 7. Audit trail (ADR 0007): the note lifecycle above must be traceable, the
// operator can page and filter the log, and non-admins cannot read it. Runs
// only when the server was booted with an operator bypass token.
const adminToken = process.env.ACCEPTANCE_ADMIN_TOKEN;
if (adminToken) {
  const adminReq = (path: string): Promise<Response> =>
    fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
  const audit = await (
    await adminReq("/admin/audit?kind=note&limit=10")
  ).json();
  const actions = (audit.rows ?? []).map((r: { action?: string }) => r.action);
  check(
    "GET /admin/audit records the note lifecycle",
    actions.includes("note.add") && actions.includes("note.delete"),
  );
  check(
    "GET /admin/audit filters by kind",
    (audit.rows ?? []).every((r: { action?: string }) =>
      String(r.action).startsWith("note."),
    ),
  );
  check(
    "GET /admin/audit pages with a total",
    typeof audit.total === "number" && audit.total >= 2,
  );
  const byActor = await adminReq("/admin/audit?actor=tester&limit=5");
  check("GET /admin/audit filters by actor", byActor.status === 200);
  // Member-vs-admin 403 is covered by the route unit tests; against a live
  // server the deterministic variant is an unknown bearer (401 everywhere,
  // regardless of which roles the local roster carries).
  const stranger = await fetch(`${base}/admin/audit`, {
    headers: { authorization: "Bearer sw_not-a-real-token" },
  });
  check("GET /admin/audit rejects unknown tokens", stranger.status === 401);
}

if (failures > 0) {
  console.error(`acceptance: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("acceptance: all checks passed");

// Top-level await needs a module; this file is a script.
export {};

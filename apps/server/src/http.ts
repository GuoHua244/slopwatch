import {
  isNormalEvent,
  SCHEMA_VERSION,
  type NormalEvent,
} from "@slopwatch/events";
import type { Store } from "./store";

export type App = { fetch: (req: Request) => Promise<Response> };

export type AppOptions = {
  /** bearer token → user name (v0: from env; later: admin-minted, decision 6). */
  tokens: Map<string, string>;
  store: Store;
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const identify = (req: Request, tokens: Map<string, string>): string | null => {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return tokens.get(header.slice("Bearer ".length).trim()) ?? null;
};

export const createApp = ({ tokens, store }: AppOptions): App => ({
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return json(200, { ok: true });

    if (url.pathname === "/events" && req.method === "POST") {
      const user = identify(req, tokens);
      if (user === null) return json(401, { error: "unauthorized" });

      let body: { schema_version?: number; events?: unknown[] };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json(400, { error: "invalid json" });
      }
      if (body.schema_version !== SCHEMA_VERSION) {
        return json(400, {
          error: `expected schema_version ${SCHEMA_VERSION}`,
        });
      }
      if (!Array.isArray(body.events))
        return json(400, { error: "events must be an array" });
      const events: NormalEvent[] = [];
      for (const [i, candidate] of body.events.entries()) {
        if (!isNormalEvent(candidate)) {
          return json(400, { error: `event at index ${i} failed validation` });
        }
        events.push(candidate);
      }
      const { accepted } = await store.appendEvents(events, user);
      return json(202, { accepted });
    }

    const eventsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const sinceSeq = Number(url.searchParams.get("since_seq") ?? 0);
      const events = await store.eventsSince(
        decodeURIComponent(eventsMatch[1]!),
        Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0,
      );
      return json(200, {
        session_id: decodeURIComponent(eventsMatch[1]!),
        events,
      });
    }

    if (url.pathname === "/sessions" && req.method === "GET") {
      return json(200, { sessions: await store.listSessions() });
    }

    return json(404, { error: "not found" });
  },
});

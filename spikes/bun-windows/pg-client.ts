/**
 * Spike: pg driver under Bun/Windows. This machine has no Postgres (5432 free,
 * no Docker), so the fact we can settle today: the module loads, the client
 * initializes, and the TCP dial fails cleanly (ECONNREFUSED, no native crash).
 * The full query round-trip stays open until a Postgres instance is reachable.
 */
import { Client } from "pg";

const c = new Client({
  host: "127.0.0.1",
  port: 5432,
  user: "spike",
  password: "spike",
  connectionTimeoutMillis: 1500,
});
const t0 = Date.now();
try {
  await c.connect();
  console.log(
    "SPIKE pg: UNEXPECTED-SUCCESS — something is listening on 5432; run a real round-trip now",
  );
  await c.end();
} catch (e) {
  const err = e as Error & { code?: string };
  const ms = Date.now() - t0;
  const clean =
    err.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(err.message);
  console.log(
    `SPIKE pg: ${clean ? "PASS" : "FAIL"} — driver loaded, connect failed cleanly in ${ms}ms: ${err.code ?? "?"} ${err.message.slice(0, 120)}`,
  );
}

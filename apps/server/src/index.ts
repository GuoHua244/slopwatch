import { loadConfig } from "./config";
import { createApp } from "./http";
import { createPgStore } from "./store";

const config = loadConfig();
if (config.tokens.size === 0) {
  console.warn(
    "warning: SLOPWATCH_TOKENS is empty — every POST /events will be rejected",
  );
}

const store = createPgStore(config.databaseUrl);
await store.migrate();

// Decision 11: prune expired raw payloads daily (and once at boot).
const prune = () =>
  store
    .pruneRawOlderThan(config.rawTtlDays)
    .then((n) => n > 0 && console.log(`pruned raw payloads from ${n} events`))
    .catch((e: unknown) => console.error("prune failed:", e));
void prune();
setInterval(prune, 24 * 60 * 60 * 1000);

const app = createApp({ tokens: config.tokens, store });

Bun.serve({ port: config.port, fetch: (req) => app.fetch(req) });
console.log(`slopwatch server listening on http://localhost:${config.port}`);

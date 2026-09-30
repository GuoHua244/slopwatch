import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NormalEvent } from "@slopwatch/events";

// A child tail used to drain exactly once — at registration. Everything a
// subagent appended afterwards stayed unread until a fresh listener
// generation re-registered the file, so the child's final records (its
// answer, above all) were captured only by luck of the respawn cadence, and
// a child that outlived the last generation was never finished. The pin:
// records appended AFTER registration reach the server within a few ticks.

const dir = mkdtempSync(join(tmpdir(), "slopwatch-live-listener-"));
const home = join(dir, "home");
const mainFile = join(dir, "main.jsonl");
const childFile = join(dir, "child.jsonl");

const received: NormalEvent[][] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok");
    if (path === "/summary/llm") return Response.json({ configured: false });
    const body = (await req.json()) as { events: NormalEvent[] };
    received.push(body.events);
    return Response.json({ accepted: body.events.length });
  },
});

// The driver runs as its own process (createLiveListener exits the process
// on finish) and imports the listener by absolute URL — a temp-dir script
// cannot resolve the workspace's bare module names.
const driver = join(dir, "driver.mjs");
writeFileSync(
  driver,
  `
const [mainFile, childFile, port] = process.argv.slice(2);
const { createLiveListener } = await import(${JSON.stringify(
    pathToFileURL(join(import.meta.dir, "live-listener.ts")).href,
  )});
const record = (r) => ({
  schema_version: 1,
  agent: "test",
  session_id: r.session,
  occurred_at: new Date().toISOString(),
  kind: "tool",
  event: "call",
  tool_call_id: "c" + r.n,
  tool: "Read",
});
await createLiveListener({
  agent: "test",
  file: mainFile,
  sessionId: "sess_main",
  cwd: ${JSON.stringify(dir)},
  idleMs: 30_000,
  maxLifetimeMs: 120_000,
  serverUrl: \`http://127.0.0.1:\${port}\`,
  token: "test-token",
  adapter: {
    driftFromRecord: () => null,
    eventsFromRecord: (r) => [record(r)],
  },
  childTails: {
    discover: () => [{ file: childFile, sessionId: "sess_child" }],
  },
  probeBeforeFold: false,
});
`,
);

const spawnDriver = (): Bun.Subprocess<"ignore", "pipe", "pipe"> =>
  Bun.spawn({
    cmd: [process.execPath, driver, mainFile, childFile, String(server.port)],
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

const childEvents = (): string[] =>
  received
    .flat()
    .filter((e) => e.session_id === "sess_child")
    .map((e) => ("tool_call_id" in e ? e.tool_call_id : ""));

const waitFor = async (
  what: string,
  has: () => boolean,
  deadlineMs: number = 15_000,
): Promise<void> => {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (has()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe("live-listener child tails", () => {
  test("a child file's records appended after registration are drained", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      mainFile,
      `${JSON.stringify({ n: 0, session: "sess_main" })}\n`,
    );
    writeFileSync(
      childFile,
      `${JSON.stringify({ n: 1, session: "sess_child" })}\n`,
    );
    const proc = spawnDriver();
    try {
      // the registration drain captures the pre-existing record
      await waitFor(
        "the registration backlog (c1)",
        () => childEvents().includes("c1"),
        15_000,
      );

      // growth after registration — the bug shipped nothing here until a
      // fresh listener generation happened to re-register the file
      appendFileSync(
        childFile,
        `${JSON.stringify({ n: 2, session: "sess_child" })}\n`,
      );
      await waitFor(
        "the post-registration record (c2)",
        () => childEvents().includes("c2"),
        15_000,
      );
      appendFileSync(
        childFile,
        `${JSON.stringify({ n: 3, session: "sess_child" })}\n`,
      );
      await waitFor(
        "the second post-registration record (c3)",
        () => childEvents().includes("c3"),
        15_000,
      );
    } finally {
      proc.kill();
      await proc.exited;
      // reading stderr only after the exit: the pipe never closes while the
      // driver runs, so a mid-flight text() would block the whole test
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toBe("");
    }
  }, 60_000);

  test("cleanup", () => {
    server.stop(true);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "./http";
import type { Store } from "./store";

// Static-serving tests run everywhere against a throwaway dist tree — the
// store must never be touched for GETs.
const refusingStore = (): Store => ({
  migrate: () => {
    throw new Error("store must not be touched");
  },
  appendEvents: () => {
    throw new Error("store must not be touched");
  },
  listSessions: () => {
    throw new Error("store must not be touched");
  },
  eventsSince: () => {
    throw new Error("store must not be touched");
  },
  getAttachment: () => {
    throw new Error("store must not be touched");
  },
  deleteSession: () => {
    throw new Error("store must not be touched");
  },
  getSetting: async () => null,
  setSetting: async () => {},
  clearSetting: async () => {},
  listSettings: async () => ({}),
  appendAudit: async () => {},
  listAudit: async () => ({ rows: [], total: 0 }),
  getSession: async () => null,
  getComment: async () => null,
  getTeam: async () => null,
  getToken: async () => null,
  pruneRaw: () => {
    throw new Error("store must not be touched");
  },
  backfillResponseText: () => {
    throw new Error("store must not be touched");
  },
  backfillTokenTotals: () => {
    throw new Error("store must not be touched");
  },
  listRollups: async () => ({
    totals: [],
    model_totals: [],
    daily: [],
    model_daily: [],
    user_hourly: [],
    model_hourly: [],
  }),
  backfillRollups: () => {
    throw new Error("store must not be touched");
  },
  createUser: () => {
    throw new Error("store must not be touched");
  },
  getUser: () => {
    throw new Error("store must not be touched");
  },
  listUsers: () => {
    throw new Error("store must not be touched");
  },
  setUserDisabled: () => {
    throw new Error("store must not be touched");
  },
  deleteUser: () => {
    throw new Error("store must not be touched");
  },
  mintToken: () => {
    throw new Error("store must not be touched");
  },
  listTokens: () => {
    throw new Error("store must not be touched");
  },
  revokeToken: () => {
    throw new Error("store must not be touched");
  },
  resolveTokenUser: async () => null,
  resolveOidcUser: async () => null,
  markReviewed: () => {
    throw new Error("store must not be touched");
  },
  unmarkReviewed: () => {
    throw new Error("store must not be touched");
  },
  reviewFor: async () => null,
  addComment: () => {
    throw new Error("store must not be touched");
  },
  listComments: async () => [],
  deleteComment: () => {
    throw new Error("store must not be touched");
  },
  isDri: async () => false,
  setUserDri: async () => null,
  roleOf: async () => "member" as const,
  setUserRole: async () => null,
  ensureUser: async () => false,
  ensureAdmin: async () => {},
  sessionOwner: async () => null,
  ownUsage: async () => ({
    sessions: 0,
    first_seen_at: null,
    last_seen_at: null,
    turns: 0,
    tool_calls: 0,
    model_totals: [],
  }),
  health: () => {
    throw new Error("store must not be touched");
  },
  listQuarantine: async () => [],
  createTeam: () => {
    throw new Error("store must not be touched");
  },
  listTeams: () => {
    throw new Error("store must not be touched");
  },
  updateTeam: () => {
    throw new Error("store must not be touched");
  },
  deleteTeam: () => {
    throw new Error("store must not be touched");
  },
  setUserTeam: () => {
    throw new Error("store must not be touched");
  },
  teamsWithMembers: () => {
    throw new Error("store must not be touched");
  },
  createRetro: async () => {
    throw new Error("store must not be touched");
  },
  getRetro: async () => null,
  listRetros: async () => [],
  setRetroRunning: async () => {},
  setRetroProgress: async () => {},
  setRetroCompleted: async () => {},
  setRetroFailed: async () => {},
  failStaleRetros: async () => 0,
  hasOpenRetroFor: async () => false,
  allEvents: async () => [],
  rawForEvents: async () => [],
  childRollups: async () => [],
  getLlmConfig: async () => null,
  setLlmConfig: async () => {},
  clearLlmConfig: async () => {},
  addFeedback: async () => null,
  getFeedback: async () => null,
  listFeedback: async () => ({ rows: [], total: 0 }),
  deleteFeedback: async () => false,
  addFeedbackAttachments: async () => {},
  getFeedbackAttachment: async () => null,
  close: async () => {},
});

const makeDist = (): string => {
  const root = mkdtempSync(join(tmpdir(), "slopwatch-dist-"));
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><title>slopwatch</title><div id=root></div>",
  );
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-Q1w2e3.js"), "console.log(1)");
  writeFileSync(join(root, "assets", "style-A1b2c3.css"), "body{}");
  return root;
};

const appWith = (staticRoot: string | undefined): App =>
  createApp({ tokens: new Map(), store: refusingStore(), staticRoot });

describe("static serving of the built dashboard", () => {
  const dist = makeDist();

  test("GET / serves index.html, no-cache, without touching the store", async () => {
    const res = await appWith(dist).fetch(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("slopwatch");
  });

  test("GET /index.html serves the same entry", async () => {
    const res = await appWith(dist).fetch(new Request("http://x/index.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("hashed assets are immutable with a JS content-type", async () => {
    const res = await appWith(dist).fetch(
      new Request("http://x/assets/app-Q1w2e3.js"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("CSS assets get the CSS content-type", async () => {
    const res = await appWith(dist).fetch(
      new Request("http://x/assets/style-A1b2c3.css"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  test("unknown paths 404 — hash routing needs no catch-all fallback", async () => {
    const res = await appWith(dist).fetch(new Request("http://x/nope"));
    expect(res.status).toBe(404);
  });

  test("missing assets 404 instead of returning the entry HTML", async () => {
    const res = await appWith(dist).fetch(
      new Request("http://x/assets/missing.js"),
    );
    expect(res.status).toBe(404);
  });

  test("path traversal outside the dist root is rejected", async () => {
    const res = await appWith(dist).fetch(
      new Request("http://x/%2e%2e%2fhttp.test.ts"),
    );
    expect(res.status).toBe(404);
  });

  test("HEAD / reports the entry headers with no body", async () => {
    const res = await appWith(dist).fetch(
      new Request("http://x/", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("a missing dist tree yields 503 with a build hint", async () => {
    const res = await appWith(join(dist, "does-not-exist")).fetch(
      new Request("http://x/"),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("build");
  });

  test("without a dist root GET / yields 503 too", async () => {
    const res = await appWith(undefined).fetch(new Request("http://x/"));
    expect(res.status).toBe(503);
  });

  test("cleanup", () => {
    rmSync(dist, { recursive: true, force: true });
  });
});

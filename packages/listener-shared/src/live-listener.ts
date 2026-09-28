import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  envelope,
  type NormalEvent,
  type SessionStartEvent,
  type TokenUsage,
} from "@slopwatch/events";
import { foldSummary, summaryStore, type FoldLlm } from "@slopwatch/summary";
import { spawnDrainSweep } from "./sweep";
import { createShipPipeline } from "./ship";
import { createTailLoop, type RecordAdapter } from "./tail";
import { createTurnDigest } from "./turn-digest";

/**
 * The shared live-tail listener skeleton: everything after argv parsing that
 * every agent listener needs — state paths, liveness heartbeat, the detached
 * sweep closure, the ship pipeline, summary gating, idle/max-lifetime
 * teardown, and the tail/watch/start wiring. The per-agent part is only the
 * RecordAdapter plus where the capture file and git remote come from.
 */
export type LiveListenerOptions = {
  agent: string;
  /** The capture file to tail (transcript / rollout JSONL). */
  file: string;
  sessionId: string;
  /** Reported in session:start; also the git-remote probe's directory. */
  cwd: string;
  gitRemote?: string;
  idleMs: number;
  maxLifetimeMs: number;
  serverUrl?: string;
  token?: string;
  adapter: RecordAdapter;
  /** Touch `<stateBase>.heartbeat` at boot and every 30s (liveness proof). */
  heartbeat: boolean;
  /**
   * Probe `<server>/healthz` before the summary fold so tokens are never
   * spent on a summary that cannot ship (digests are kept for the next end
   * instead). Off for agents whose every end is worth an offline fold.
   */
  probeBeforeFold: boolean;
  /** This listener package's drain.ts — the target of the detached sweep. */
  drainScript: string;
};

export const createLiveListener = async (
  opts: LiveListenerOptions,
): Promise<void> => {
  const stateDir = join(homedir(), ".slopwatch", "listeners");
  const cursorFile = join(stateDir, `${opts.agent}-${opts.sessionId}.cursor`);
  mkdirSync(stateDir, { recursive: true });
  const stateBase = cursorFile.slice(0, -".cursor".length);
  const summaries = summaryStore(stateBase);

  const sweep = (): void => spawnDrainSweep(opts.drainScript);
  const { flush } = createShipPipeline({
    agent: opts.agent,
    sessionId: opts.sessionId,
    serverUrl: opts.serverUrl,
    token: opts.token,
    stateBase,
    onQueued: sweep,
  });

  // Rolling summaries (open question 15): only while shipping. Decision 28:
  // the fold's LLM call executes server-side on the caller's own profile
  // credentials, so the listener holds no key — and a user without
  // credentials gets no summary at all, silently, exactly like an install
  // before the feature existed.
  const summaryServer =
    opts.serverUrl && opts.token
      ? { base: opts.serverUrl.replace(/\/+$/, ""), token: opts.token }
      : undefined;

  const serverReachable = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/healthz`, {
        signal: AbortSignal.timeout(2_500),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const summaryConfigured = async (): Promise<boolean> => {
    if (!summaryServer) return false;
    try {
      const res = await fetch(`${summaryServer.base}/summary/llm`, {
        headers: { authorization: `Bearer ${summaryServer.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as {
        configured?: unknown;
      } | null;
      return body?.configured === true;
    } catch {
      return false;
    }
  };

  const cleanUsage = (raw: unknown): TokenUsage | undefined => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const usage: TokenUsage = {};
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
    ] as const) {
      const value = (raw as Record<string, unknown>)[key];
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        usage[key] = value;
    }
    return Object.keys(usage).length > 0 ? usage : undefined;
  };

  // One fold completion = one server round trip. The server owns the
  // per-attempt LLM timeout and the ×4 budget-raising retry, so the client
  // budget only has to cover both attempts plus the hop.
  const foldLlm: FoldLlm | null = summaryServer
    ? async ({ system, user, maxTokens }) => {
        try {
          const res = await fetch(`${summaryServer.base}/summary/fold`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${summaryServer.token}`,
            },
            body: JSON.stringify({ system, user, max_tokens: maxTokens }),
            signal: AbortSignal.timeout(150_000),
          });
          if (!res.ok) return { text: null, model: "" };
          const body = (await res.json().catch(() => null)) as {
            text?: unknown;
            model?: unknown;
            usage?: unknown;
          } | null;
          return {
            text:
              typeof body?.text === "string" && body.text.trim().length > 0
                ? body.text.trim()
                : null,
            model: typeof body?.model === "string" ? body.model : "",
            usage: cleanUsage(body?.usage),
          };
        } catch {
          return { text: null, model: "" };
        }
      }
    : null;

  // Liveness heartbeat for the spawner's respawn decision: Windows reuses
  // PIDs, so signal-0 alone can mistake a dead listener for a live one — the
  // freshness of this file is what actually proves we are running.
  const heartbeatFile = `${stateBase}.heartbeat`;
  const touchHeartbeat = (): void =>
    writeFileSync(heartbeatFile, String(Date.now()));
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.heartbeat) {
    touchHeartbeat();
    heartbeatTimer = setInterval(touchHeartbeat, 30_000);
  }

  const digest = createTurnDigest(summaries);

  let idleTimer: ReturnType<typeof setTimeout>;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void finish("idle-timeout"), opts.idleMs);
  };

  const { drain } = createTailLoop({
    file: opts.file,
    cursorFile,
    agent: opts.agent,
    sessionId: opts.sessionId,
    adapter: opts.adapter,
    digest,
    flush,
    resetIdle,
  });

  let finished = false;
  const finish = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    digest.close();
    // fold the summary first so summary → end ships in one POST; an LLM
    // failure leaves the digests pending and only costs this end's summary.
    // When probing, tokens are only spent when the result can actually ship:
    // a fold computed offline is lost with the failed POST and re-burned on
    // the next end.
    let shipable = true;
    if (foldLlm && opts.probeBeforeFold) {
      shipable = opts.serverUrl ? await serverReachable(opts.serverUrl) : false;
    }
    if (foldLlm && !shipable) {
      console.error(
        "live: server unreachable — summary fold skipped, digests kept for retry",
      );
    }
    const batch: NormalEvent[] = [];
    if (foldLlm && shipable && (await summaryConfigured())) {
      try {
        const summaryEvent = await foldSummary({
          stateBase,
          agent: opts.agent,
          sessionId: opts.sessionId,
          llm: foldLlm,
        });
        if (summaryEvent) batch.push(summaryEvent);
        else if (summaries.pendingDigests().length > 0) {
          console.error(
            "live: fold returned no summary — digests kept for the next end",
          );
        }
      } catch (e) {
        console.error(
          `live: summary fold skipped (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
    batch.push({
      ...envelope(opts.agent, opts.sessionId, new Date().toISOString()),
      kind: "session",
      event: "end",
      reason,
    });
    await flush(batch);
    // grace period so in-flight POSTs can complete before exiting
    setTimeout(() => process.exit(0), opts.serverUrl ? 1500 : 50);
  };

  const start = (): void => {
    void drain(); // backfill everything written before we attached
    watch(opts.file, () => void drain());
    setInterval(() => void drain(), 2000); // belt-and-braces alongside fs.watch
    setTimeout(() => void finish("max-lifetime"), opts.maxLifetimeMs);
  };

  // Every generation opens with its own start: after an idle-timeout end the
  // re-spawn must re-assert start so the dashboard's last-end-wins status
  // flips the session back to live. It lands BEFORE any drained record can
  // flush, so the event stream begins with the session envelope.
  const startEvent: SessionStartEvent = {
    ...envelope(opts.agent, opts.sessionId, new Date().toISOString()),
    kind: "session",
    event: "start",
    cwd: opts.cwd,
    hostname: hostname(),
    ...(opts.gitRemote ? { git_remote: opts.gitRemote } : {}),
  };
  await flush([startEvent]);
  resetIdle();

  if (existsSync(opts.file)) {
    start();
  } else {
    // SessionStart can fire before the first transcript/rollout write — wait
    // for the file.
    const poll = setInterval(() => {
      if (existsSync(opts.file)) {
        clearInterval(poll);
        start();
      }
    }, 500);
  }
};

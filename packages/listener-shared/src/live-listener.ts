import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
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
  /**
   * Child capture files discovered while running, polled on the same cadence
   * as the primary tail. Each discovered file gets its own cursor (resumed
   * across listener generations, so a re-spawn never re-ships drained
   * records) and its drains reset the shared idle clock — child activity
   * keeps the listener alive exactly like primary activity.
   */
  childTails?: { discover: () => ChildTail[] };
};

/**
 * A secondary capture file tailed alongside the primary one — a child
 * session's capture (ZCode subagent rollouts). Its events carry the child's
 * own sessionId and ship through the same pipeline as the parent session's;
 * the lifecycle markers bracket them so the dashboard's last-write-wins
 * status shows the child as its own live/ended row.
 */
export type ChildTail = {
  /** Absolute path of the capture file to tail. */
  file: string;
  /** The session id the drained events carry (the child session). */
  sessionId: string;
  /** Shipped when the tail begins — the child's session:start. */
  onStart?: () => NormalEvent[];
  /**
   * Shipped once when the file is gone, quiet past idleMs, or the listener
   * tears down. Never called again until a fresh onStart (the quiet end
   * re-arms itself when the file grows again).
   */
  onEnd?: (reason: string) => NormalEvent[];
  /**
   * Drained events feed the parent session's rolling digest through this
   * transform; without it the file is not observed at all. (ZCode filters
   * child turn:start out so a child's turns do not close the parent turn
   * being digested.)
   */
  digestTransform?: (events: NormalEvent[]) => NormalEvent[];
};

export const createLiveListener = async (
  opts: LiveListenerOptions,
): Promise<void> => {
  const stateDir = join(homedir(), ".slopwatch", "listeners");
  const cursorFile = join(stateDir, `${opts.agent}-${opts.sessionId}.cursor`);
  mkdirSync(stateDir, { recursive: true });
  const stateBase = cursorFile.slice(0, -".cursor".length);
  const summaries = summaryStore(stateBase);
  /**
   * Graceful-stop handshake (Claude Code's SessionEnd): the hook writes this
   * file instead of relying on signals — Windows cannot deliver SIGTERM to a
   * detached process (ADR 0001), and a hard kill would lose the teardown
   * flush (the adapter's held-back events) and the end batch. Checked on the
   * tick cadence; the pid file is removed as the listener's last act so the
   * hook can await a clean exit without signals.
   */
  const stopFile = `${stateBase}.stop`;
  const pidFile = `${stateBase}.pid`;

  const sweep = (): void => spawnDrainSweep(opts.drainScript);
  const { flush: flushBatch } = createShipPipeline({
    agent: opts.agent,
    sessionId: opts.sessionId,
    serverUrl: opts.serverUrl,
    token: opts.token,
    stateBase,
    onQueued: sweep,
  });

  // Every flush source — the primary tail, child tails, lifecycle markers —
  // funnels through one promise chain: the flusher replays the disk queue
  // before each batch, so concurrent callers would interleave replays and
  // sends out of order.
  let flushChain: Promise<unknown> = Promise.resolve();
  const flush = (
    batch: NormalEvent[],
  ): Promise<"sent" | "queued" | "stdout"> => {
    const next = flushChain.then(() => flushBatch(batch));
    flushChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

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

  // Child capture files (ZCode subagent rollouts), each with its own tail
  // loop and cursor. Lifecycle: start marker at registration, end marker on
  // deletion / quiet past idleMs / listener teardown — a quiet end re-arms
  // when the file grows again, so the last-write-wins dashboard status stays
  // truthful without per-child timers.
  type ActiveChild = {
    tail: ChildTail;
    cursorFile: string;
    drain: () => Promise<void>;
    ended: boolean;
    endedAtMtimeMs: number;
  };
  const children = new Map<string, ActiveChild>();
  const shipChildEnd = async (
    child: ActiveChild,
    reason: string,
  ): Promise<void> => {
    child.ended = true;
    if (child.tail.onEnd) await flush(child.tail.onEnd(reason));
  };
  const pollChildTails = async (): Promise<void> => {
    if (!opts.childTails || finished) return;
    for (const tail of opts.childTails.discover()) {
      if (children.has(tail.file)) continue;
      const cursorFile = `${stateBase}.sub-${tail.sessionId}.cursor`;
      const { drain: drainChild } = createTailLoop({
        file: tail.file,
        cursorFile,
        agent: opts.agent,
        sessionId: tail.sessionId,
        adapter: opts.adapter,
        digest: {
          close: () => {},
          observe: (events) => {
            if (tail.digestTransform)
              digest.observe(tail.digestTransform(events));
          },
        },
        flush,
        resetIdle,
      });
      const child: ActiveChild = {
        tail,
        cursorFile,
        drain: drainChild,
        ended: false,
        endedAtMtimeMs: 0,
      };
      children.set(tail.file, child);
      if (tail.onStart) await flush(tail.onStart());
      void drainChild();
    }
    for (const [file, child] of [...children]) {
      let mtimeMs: number | null = null;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        mtimeMs = null; // deleted — ZCode removes child rollouts at session end
      }
      if (mtimeMs === null) {
        children.delete(file);
        if (!child.ended) await shipChildEnd(child, "file-gone");
        try {
          unlinkSync(child.cursorFile);
        } catch {
          // already gone
        }
        continue;
      }
      if (!child.ended && Date.now() - mtimeMs > opts.idleMs) {
        child.endedAtMtimeMs = mtimeMs;
        await shipChildEnd(child, "idle-timeout");
      } else if (child.ended && mtimeMs > child.endedAtMtimeMs) {
        child.ended = false;
        if (child.tail.onStart) await flush(child.tail.onStart());
      }
    }
    // Every registered child drains each tick — the one-shot drain at
    // registration only sees the backlog up to that moment, and a subagent
    // keeps appending long after (its final answer included). The drain
    // no-ops on an unchanged file (one stat), so the per-tick cost is the
    // child count; the tail loop's re-entrancy guard absorbs overlap.
    for (const child of children.values()) {
      void child.drain();
    }
  };
  const finish = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    // lifecycle files must not outlive the listener: a stale pid file would
    // make the next hook fire skip a needed respawn (the heartbeat check
    // covers the gap while this teardown is still flushing)
    try {
      unlinkSync(pidFile);
    } catch {
      // already gone
    }
    try {
      unlinkSync(stopFile);
    } catch {
      // already gone
    }
    // the adapter's held-back events (e.g. Claude Code's open message)
    // fold into the digest and the end batch before the session ends
    const teardownEvents = opts.adapter.onTeardown?.() ?? [];
    digest.observe(teardownEvents);
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
    // child sessions still open at teardown end first, so the parent's end
    // stays the last write for the group
    for (const child of children.values()) {
      if (!child.ended && child.tail.onEnd) {
        batch.push(...child.tail.onEnd("listener-exit"));
      }
      child.ended = true;
    }
    // the adapter's held-back evidence precedes the digest of that evidence
    batch.push(...teardownEvents);
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

  // One tick = primary drain, then the child poll. The order matters once:
  // a re-spawned listener can only claim surviving child files after the
  // boot backfill has established its identity (the zcode adapter learns the
  // parent traceId from the first drained record), so discovery rides the
  // same async chain instead of racing it.
  const tick = (): void => {
    void (async () => {
      if (existsSync(stopFile)) {
        // hook-requested graceful stop (see stopFile). Only fresh markers
        // count: a marker left unconsumed by a listener that died before its
        // next tick must not insta-finish a respawn of the same session.
        let fresh = false;
        try {
          const writtenAt = Number(readFileSync(stopFile, "utf8").trim());
          fresh = Number.isFinite(writtenAt) && Date.now() - writtenAt < 30_000;
        } catch {
          fresh = false;
        }
        try {
          unlinkSync(stopFile);
        } catch {
          // already gone
        }
        if (fresh) {
          await finish("hook-stop");
          return;
        }
      }
      await drain();
      await pollChildTails();
    })().catch((e) =>
      console.error(
        `live: tick failed (${e instanceof Error ? e.message : String(e)})`,
      ),
    );
  };

  const start = (): void => {
    tick();
    watch(opts.file, tick);
    setInterval(tick, 2000); // belt-and-braces alongside fs.watch
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

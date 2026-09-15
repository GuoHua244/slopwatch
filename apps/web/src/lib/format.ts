/** 0 → "0", 713 → "713", 136384 → "136.4k", 2125000 → "2.1M" */
export const fmtTokens = (n: number): string => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};

/**
 * Delta against a baseline: null (no baseline) → "—", 0.25 → "↑ 25%",
 * -0.25 → "↓ 25%". Deliberately colorless — on a spend metric "up" is not
 * good, so the arrow carries the direction and nothing carries a verdict.
 */
export const fmtDelta = (ratio: number | null): string => {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  const pct = Math.round(Math.abs(ratio) * 100);
  return `${ratio >= 0 ? "↑" : "↓"} ${pct}%`;
};

/** 0 → "$0", 0.0042 → "$0.0042", 12.345 → "$12.35" */
export const fmtCost = (usd: number): string =>
  usd === 0 ? "$0" : usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** ISO 8601 timestamp → local "15:26:58". */
export const clock = (iso: string): string => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** 0 → "0ms", 850 → "850ms", 49261 → "49.3s", 130000 → "2m10s" */
export const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${pad2(total % 60)}s`;
};

/** ISO 8601 timestamp → local "2026-09-15 17:39". */
export const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate(),
  )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * Elapsed time since an ISO timestamp, coarse: 90min → "1h", 6days → "6d",
 * 40days → "1.3mo", 400days → "1.1y". The "how long has this been live"
 * number for the profile page.
 */
export const sinceDuration = (iso: string, now = Date.now()): string => {
  const ms = now - new Date(iso).getTime();
  if (ms < 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  const months = days / 30.44;
  if (months < 24) return `${months.toFixed(1)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
};

/** "sess_ec0623ae-…" → "ec0623ae"; ids without a kind prefix pass through. */
export const shortId = (id: string): string =>
  id.replace(/^[a-z]+_/, "").slice(0, 8);

const truncate = (s: string, max = 40): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** Best display text for a caught-unknown (Error message or String). */
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** First three entries of a tool-args object as "k=v" pairs. */
export const summarizeArgs = (args: unknown): string => {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return truncate(String(args));
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
  return entries
    .map(([key, value]) => {
      const raw =
        typeof value === "string" ? value : (JSON.stringify(value) ?? "");
      return `${key}=${truncate(raw)}`;
    })
    .join(" ");
};

import { HttpError, json } from "./respond";

/** Parse a JSON body, or null when it is not an object-shaped JSON payload. */
export const readJson = async (
  req: Request,
): Promise<Record<string, unknown> | null> => {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * readJson plus the shared 400 prologue: an object-shaped body, or the
 * `400 {"error":"invalid json"}` sentinel thrown for the top-level catch.
 */
export const readJsonOr400 = async (
  req: Request,
): Promise<Record<string, unknown>> => {
  const body = await readJson(req);
  if (body === null) throw new HttpError(json(400, { error: "invalid json" }));
  return body;
};

/** A trimmed string field within maxLen, or null when absent/oversized. */
export const trimField = (value: unknown, maxLen: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLen ? trimmed : null;
};

/** Team retention override (decision 23): absent passes through, null inherits
 * the global default, otherwise a positive integer. */
export const isRetention = (
  value: unknown,
): value is number | null | undefined =>
  value === undefined ||
  value === null ||
  (typeof value === "number" && Number.isInteger(value) && value >= 1);
export const RETENTION_ERROR =
  "raw_retention_days must be null or a positive integer";

/** Positive int query param clamped to 1..max; fallback when absent/garbage. */
export const windowParam = (
  raw: string | null,
  max: number,
  fallback: number,
): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
};

/** decodeURIComponent that never throws — a malformed escape answers 400. */
export const decodeParam = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

/**
 * decodeParam plus the shared session-route 400: every session-scoped route
 * rejects a malformed id before touching the store.
 */
export const requireSessionId = (raw: string): string => {
  const sessionId = decodeParam(raw);
  if (sessionId === null)
    throw new HttpError(json(400, { error: "malformed session id" }));
  return sessionId;
};

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

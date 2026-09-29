import type { SessionSummary } from "../api/types";

/** A session list folded into parent → children groups, input order kept. */
export type SessionForest = {
  /** Top-level rows: sessions with no parent in the fetched window. */
  roots: SessionSummary[];
  /** Child rows per parent id, in the server's newest-first order. */
  childrenOf: Map<string, SessionSummary[]>;
};

/**
 * Nest subagent sessions under their parent. A row whose parent is missing
 * from the fetched window (older than the server's 1000-row cut, or deleted)
 * falls back to a root — the server returns a flat newest-first page, so a
 * child can outrank its parent.
 */
export const buildSessionForest = (
  sessions: SessionSummary[],
): SessionForest => {
  const ids = new Set(sessions.map((s) => s.session_id));
  const childrenOf = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];
  for (const s of sessions) {
    if (s.parent_session_id !== null && ids.has(s.parent_session_id)) {
      const group = childrenOf.get(s.parent_session_id);
      if (group) group.push(s);
      else childrenOf.set(s.parent_session_id, [s]);
    } else {
      roots.push(s);
    }
  }
  return { roots, childrenOf };
};

/**
 * The listener prefixes subagent titles with "↳ " (the historical marker);
 * the rail expresses the same fact structurally — nesting plus a chip — so
 * the raw glyph never renders.
 */
export const stripSubagentPrefix = (title: string | null): string | null =>
  title === null ? null : title.replace(/^↳\s*/, "");

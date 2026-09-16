import type { AuditActor, Store } from "../store";

/** The audit signature shared by the user planes and the admin plane. */
export type Audit = (
  actor: AuditActor,
  action: string,
  target: string,
  detail?: Record<string, unknown>,
) => Promise<void>;

/**
 * ADR 0007: every successful mutation leaves one audit entry. Best-effort
 * by design — the change has already committed, so a failed append must
 * not fail the response and tempt a retry of a non-idempotent operation.
 */
export const createAudit = (store: Store): Audit => {
  return (actor, action, target, detail) =>
    store
      .appendAudit({ actor, action, target, detail })
      .catch((e: unknown) => console.error("audit append failed:", e));
};

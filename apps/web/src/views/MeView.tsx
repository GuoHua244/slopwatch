import { useEffect, useState } from "react";
import type { MeInfo, ModelRollupRow } from "../api";
import { createReviewApi } from "../api";
import { storedToken } from "../auth";
import {
  errorMessage,
  fmtCost,
  fmtDate,
  fmtTokens,
  sinceDuration,
} from "../lib/format";
import { estimateCost, priceFor } from "../lib/pricing";

/**
 * Same costing rule as the leaderboard: an unpriced model with requests
 * poisons the whole sum, so the estimate reads "—" instead of understating.
 */
const costEstimate = (rows: ModelRollupRow[]): number | null => {
  let cost = 0;
  for (const row of rows) {
    const price = priceFor(row.model);
    if (price === null && row.model_requests > 0) return null;
    if (price === null) continue;
    cost += estimateCost(row, price);
  }
  return cost;
};

const sumTokens = (rows: ModelRollupRow[]): number =>
  rows.reduce(
    (acc, r) =>
      acc +
      r.input_tokens +
      r.output_tokens +
      r.cache_read_tokens +
      r.cache_write_tokens,
    0,
  );

/**
 * The "me" page (profile): everything that belongs to the signed-in user —
 * identity, role, team, their lifetime footprint, and sign-out — in one view.
 * The token lives in this browser's localStorage only; signing out clears it.
 */
export const MeView = ({ onSignOut }: { onSignOut: () => void }) => {
  const [me, setMe] = useState<MeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void createReviewApi(storedToken)
      .me()
      .then(setMe)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <p className="banner-error">{error}</p>;
  if (me === null) return <p className="empty">loading…</p>;

  const cost = costEstimate(me.usage.model_totals);
  const unpriced = me.usage.model_totals.some(
    (r) => priceFor(r.model) === null && r.model_requests > 0,
  );

  return (
    <section className="admin me">
      <h2>my profile</h2>
      <dl className="facts">
        <div>
          <dt>name</dt>
          <dd>{me.user}</dd>
        </div>
        <div>
          <dt>email</dt>
          <dd>{me.email ?? "—"}</dd>
        </div>
        <div>
          <dt>role</dt>
          <dd className={me.role === "admin" ? "cell-live" : undefined}>
            {me.role}
          </dd>
        </div>
        <div>
          <dt>team</dt>
          <dd>{me.team_name ?? "unassigned"}</dd>
        </div>
        <div>
          <dt>reviewer (dri)</dt>
          <dd>{me.is_dri ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>member since</dt>
          <dd>
            {me.created_at ? (
              <>
                {fmtDate(me.created_at)}
                <span className="dim"> · {sinceDuration(me.created_at)}</span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      <h2>my usage</h2>
      <dl className="facts">
        <div>
          <dt>sessions</dt>
          <dd>{me.usage.sessions}</dd>
        </div>
        <div>
          <dt>turns</dt>
          <dd>{me.usage.turns}</dd>
        </div>
        <div>
          <dt>tool calls</dt>
          <dd>{me.usage.tool_calls}</dd>
        </div>
        <div>
          <dt>tokens (all time)</dt>
          <dd>{fmtTokens(sumTokens(me.usage.model_totals))}</dd>
        </div>
        <div>
          <dt>cost est.</dt>
          <dd>
            {cost === null ? (
              <span title="some model traffic has no list price">—</span>
            ) : (
              fmtCost(cost)
            )}
            {unpriced && (
              <span className="dim"> (unpriced models present)</span>
            )}
          </dd>
        </div>
        <div>
          <dt>live since</dt>
          <dd>
            {me.usage.first_seen_at ? (
              <>
                {fmtDate(me.usage.first_seen_at)}
                <span className="dim">
                  {" "}
                  · {sinceDuration(me.usage.first_seen_at)}
                </span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>last activity</dt>
          <dd>
            {me.usage.last_seen_at ? fmtDate(me.usage.last_seen_at) : "—"}
          </dd>
        </div>
      </dl>

      <h2>account</h2>
      <p className="dim">
        Signed in with a user token kept in this browser's localStorage only.
        Tokens are minted by an admin; ask one if you need a new one.
      </p>
      <button className="signout" onClick={onSignOut}>
        sign out
      </button>
    </section>
  );
};

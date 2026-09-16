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
import { pricedCost } from "../lib/leaderboard";
import { priceFor } from "../lib/pricing";

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
 * identity, role, team, their lifetime footprint, and the one sign-out — in
 * one view. Every identity/auth affordance in the product lives here.
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
  if (me === null) return <p className="empty">Loading…</p>;

  // Same costing rule as the leaderboard: an unpriced model with requests
  // poisons the whole sum, so the estimate reads "—" instead of understating.
  const cost = pricedCost(me.usage.model_totals);
  const unpriced = me.usage.model_totals.some(
    (r) => priceFor(r.model) === null && r.model_requests > 0,
  );

  return (
    <>
      <h2 className="page-title">My profile</h2>
      <p className="page-sub">Your identity, footprint, and account.</p>

      <div className="panel-card">
        <div className="profile-head">
          <span className="avatar-lg">{me.user.slice(0, 1).toUpperCase()}</span>
          <div>
            <div className="profile-name">
              {me.user}{" "}
              {me.role === "admin" && <span className="role-chip">admin</span>}
            </div>
            <div className="profile-sub">
              {me.email ?? "no email on file"} · team{" "}
              {me.team_name ?? "unassigned"} · reviewer (DRI):{" "}
              {me.is_dri ? "yes" : "no"}
            </div>
            <div className="profile-sub">
              Member since {me.created_at ? fmtDate(me.created_at) : "—"}
              {me.created_at ? ` · ${sinceDuration(me.created_at)}` : ""}
            </div>
          </div>
        </div>
      </div>

      <div className="panel-card">
        <div className="card-head">
          <h3 className="card-title">My usage</h3>
          <span className="dim" style={{ fontSize: "12px" }}>
            lifetime, all agents
          </span>
        </div>
        <div className="kpi-row">
          <div className="kpi-card">
            <div className="kpi-value">{me.usage.sessions}</div>
            <div className="kpi-label">Sessions</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value">{me.usage.turns}</div>
            <div className="kpi-label">Turns</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value">{me.usage.tool_calls}</div>
            <div className="kpi-label">Tool calls</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value">
              {fmtTokens(sumTokens(me.usage.model_totals))}
            </div>
            <div className="kpi-label">Tokens (all time)</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value live">
              {cost === null ? (
                <span title="some model traffic has no list price">—</span>
              ) : (
                fmtCost(cost)
              )}
            </div>
            <div className="kpi-label">
              Cost est.{unpriced ? " (unpriced models present)" : ""}
            </div>
          </div>
        </div>
        <p className="dim" style={{ margin: "0 0 4px", fontSize: "12.5px" }}>
          Live since{" "}
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
          )}{" "}
          · Last activity{" "}
          {me.usage.last_seen_at ? fmtDate(me.usage.last_seen_at) : "—"}
        </p>
      </div>

      <div className="panel-card">
        <div className="card-head">
          <h3 className="card-title">Account</h3>
        </div>
        <p className="card-lede">
          You are signed in with a user token kept in this browser's
          localStorage only. Tokens are minted by an admin on the Admin → Users
          page; ask one if you need a new one.
        </p>
        <button
          className="signout"
          onClick={onSignOut}
          style={{ marginTop: 14 }}
        >
          Sign out
        </button>
      </div>
    </>
  );
};

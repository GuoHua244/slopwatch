import { useEffect, useState } from "react";
import type { MeInfo, ModelRollupRow } from "../api";
import { createRetroApi, createReviewApi } from "../api";
import { storedToken } from "../auth";
import { useFormFeedback } from "../hooks/useFormFeedback";
import {
  errorMessage,
  fmtCost,
  fmtDate,
  fmtTokens,
  sinceDuration,
} from "../lib/format";
import { pricedCost } from "../lib/leaderboard";
import { priceFor } from "../lib/pricing";
import { ConfirmButton } from "./admin-shared";

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
 * ADR 0008: the user's own LLM credentials for session retrospectives. The
 * api key is write-only — the form shows a masked hint, a blank field keeps
 * the stored key, and no read ever returns it.
 */
const LlmCard = ({ me, onChanged }: { me: MeInfo; onChanged: () => void }) => {
  const retroApi = useState(() => createRetroApi(storedToken))[0];
  const [endpoint, setEndpoint] = useState(me.llm?.endpoint ?? "");
  const [model, setModel] = useState(me.llm?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const { formError, setFormError, notice, setNotice, run } =
    useFormFeedback(onChanged);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!endpoint.trim() || !model.trim()) {
      setFormError("Endpoint and model are both required.");
      return;
    }
    void run(async () => {
      await retroApi.setLlm({
        endpoint: endpoint.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      setApiKey("");
      setNotice("LLM credentials saved — retrospectives are now available.");
    });
  };

  return (
    <div className="panel-card">
      <div className="card-head">
        <h3 className="card-title">LLM for retrospectives &amp; summaries</h3>
        <span
          className={`settings-status ${me.llm ? "live" : "off"}`}
          title={me.llm ? `key ${me.llm.api_key_hint}` : "not configured"}
        >
          {me.llm
            ? `Configured · key ${me.llm.api_key_hint}`
            : "Not configured"}
        </span>
      </div>
      <p className="card-lede">
        Session retrospectives and rolling session summaries run with{" "}
        <em>your own</em> OpenAI-compatible LLM credentials — the tokens they
        spend are billed to your key, never to anyone else's. GLM Coding Plan
        keys must use the coding endpoint (
        {"https://open.bigmodel.cn/api/coding/paas/v4"}), not the standard
        pay-as-you-go one. The key is stored server-side and never shown again.
      </p>
      <form className="settings-form llm-form" onSubmit={save}>
        <label className="field wide">
          <span>API base URL</span>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://llm.example.com/v1"
          />
        </label>
        <label className="field">
          <span>Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="glm-5.3-flash"
          />
        </label>
        <label className="field">
          <span>API key {me.llm ? "(blank = keep current)" : ""}</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={me.llm ? `stored · ${me.llm.api_key_hint}` : "sk-…"}
            autoComplete="off"
          />
        </label>
        <div className="field actions">
          <button className="primary" type="submit">
            Save
          </button>
          {me.llm && (
            <ConfirmButton
              message="clear your LLM credentials? Retrospectives will be unavailable until you configure them again."
              onClick={() =>
                void run(async () => {
                  await retroApi.clearLlm();
                  setNotice("LLM credentials cleared.");
                })
              }
            >
              Clear
            </ConfirmButton>
          )}
        </div>
      </form>
      {formError && <p className="banner-error">{formError}</p>}
      {notice && <p className="dim">{notice}</p>}
    </div>
  );
};

/**
 * The "me" page (profile): everything that belongs to the signed-in user —
 * identity, role, team, their lifetime footprint, and the one sign-out — in
 * one view. Every identity/auth affordance in the product lives here.
 */
export const MeView = ({ onSignOut }: { onSignOut: () => void }) => {
  const [me, setMe] = useState<MeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void createReviewApi(storedToken)
      .me()
      .then(setMe)
      .catch((e) => setError(errorMessage(e)));
  }, [version]);

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

      <LlmCard me={me} onChanged={() => setVersion((v) => v + 1)} />

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

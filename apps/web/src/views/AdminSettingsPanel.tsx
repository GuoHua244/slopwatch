import { useState } from "react";
import type { AdminApi } from "../api";
import { useFormFeedback } from "../hooks/useFormFeedback";
import { usePolled, type PollError } from "../hooks/usePolled";
import { ErrorBanner } from "./admin-shared";
import { Select } from "./Select";

type Props = {
  api: AdminApi;
  refreshKey: number;
  refresh: () => void;
};

type AngleDraft = { id: string; title: string; prompt: string };

/**
 * The org's retrospective angle texts (ADR 0008) as one editable JSON
 * setting: seeded defaults shipped with the server, editable here, reset
 * to the defaults by clearing the stored override.
 */
const RetroAnglesCard = ({
  api,
  refresh,
  stored,
}: {
  api: AdminApi;
  refresh: () => void;
  stored: string;
}) => {
  const parsed: AngleDraft[] | null = (() => {
    try {
      const list = JSON.parse(stored) as AngleDraft[];
      return Array.isArray(list) &&
        list.every(
          (a) =>
            typeof a?.id === "string" &&
            typeof a?.title === "string" &&
            typeof a?.prompt === "string",
        )
        ? list
        : null;
    } catch {
      return null;
    }
  })();
  const [drafts, setDrafts] = useState<AngleDraft[] | null>(null);
  const { formError, setFormError, notice, setNotice, run } =
    useFormFeedback(refresh);

  if (parsed === null)
    return (
      <p className="dim">
        The stored retrospective angles are not valid JSON — reset them to the
        shipped defaults below.
      </p>
    );
  const current = drafts ?? parsed;

  const save = () => {
    if (current.some((a) => !a.title.trim() || !a.prompt.trim())) {
      setFormError("Every angle needs a title and a non-empty prompt.");
      return;
    }
    void run(async () => {
      await api.updateSettings({
        retro_angles: JSON.stringify(
          current.map((a) => ({
            ...a,
            title: a.title.trim(),
            prompt: a.prompt.trim(),
          })),
        ),
      });
      setDrafts(null);
      setNotice("Retrospective angles saved — new runs use them immediately.");
    });
  };

  const reset = () =>
    void run(async () => {
      await api.updateSettings({ retro_angles: "" });
      setDrafts(null);
      setNotice("Angles reset to the shipped defaults.");
    });

  return (
    <>
      <p className="card-lede">
        The preset angles every user can run a session retrospective with.
        Prompts decide the quality of the analysis — edit with intent; more
        specific instruction reads better than more general.
      </p>
      <div className="retro-angles">
        {current.map((angle, i) => (
          <details key={angle.id} className="retro-angle" open={i === 0}>
            <summary>
              <span className="mono">{angle.id}</span>
              <span className="retro-angle-title">{angle.title}</span>
            </summary>
            <label className="field">
              <span>Title</span>
              <input
                value={angle.title}
                onChange={(e) =>
                  setDrafts(
                    current.map((a, j) =>
                      j === i ? { ...a, title: e.target.value } : a,
                    ),
                  )
                }
              />
            </label>
            <label className="field">
              <span>Prompt</span>
              <textarea
                rows={8}
                value={angle.prompt}
                onChange={(e) =>
                  setDrafts(
                    current.map((a, j) =>
                      j === i ? { ...a, prompt: e.target.value } : a,
                    ),
                  )
                }
              />
            </label>
          </details>
        ))}
      </div>
      <div className="field actions" style={{ marginTop: 12 }}>
        <button className="primary" type="button" onClick={save}>
          Save angles
        </button>
        <button type="button" onClick={reset}>
          Reset to defaults
        </button>
      </div>
      {formError && <p className="banner-error">{formError}</p>}
      {notice && <p className="dim">{notice}</p>}
    </>
  );
};

/**
 * Operator settings (v2 decision 25, broadened), written for the lead who
 * just wants the outcome: "my team chat hears about finished sessions" and
 * "old raw payloads go away". Values shown are the server's effective
 * configuration — stored overrides merged over boot defaults — so what you
 * see is what runs.
 */
export const AdminSettingsPanel = ({ api, refreshKey, refresh }: Props) => {
  const {
    data: settings,
    error,
  }: { data: Record<string, string> | null; error: PollError | null } =
    usePolled(() => api.settings(), [refreshKey]);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [formatDraft, setFormatDraft] = useState<string | null>(null);
  const [enabledDraft, setEnabledDraft] = useState<string | null>(null);
  const [ttlDraft, setTtlDraft] = useState<string | null>(null);
  const [zeroToolDraft, setZeroToolDraft] = useState<string | null>(null);
  const [hourlyDraft, setHourlyDraft] = useState<string | null>(null);
  const { formError, setFormError, notice, setNotice, run } =
    useFormFeedback(refresh);

  const current = settings ?? {};
  const url = urlDraft ?? current.webhook_url ?? "";
  const format = formatDraft ?? current.webhook_format ?? "slack";
  const enabled =
    (enabledDraft ?? current.webhook_enabled ?? "true") === "true";
  const ttl = ttlDraft ?? current.raw_ttl_days ?? "90";
  // v3 decision 33: the alerts ride the session-notification webhook; an
  // empty field means the check is off, matching the server's threshold rule.
  const zeroToolAlert = zeroToolDraft ?? current.alert_zero_tool_tokens ?? "";
  const hourlyAlert = hourlyDraft ?? current.alert_hourly_tokens ?? "";

  const webhookLive = url.trim().length > 0 && enabled;
  const alertsLive =
    webhookLive &&
    ((Number(zeroToolAlert) > 0 && zeroToolAlert.trim() !== "") ||
      (Number(hourlyAlert) > 0 && hourlyAlert.trim() !== ""));

  const saveWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) {
      setFormError(
        "A webhook URL is required — untick enabled to switch pushes off.",
      );
      return;
    }
    void run(async () => {
      await api.updateSettings({
        webhook_url: url.trim(),
        webhook_format: format,
        webhook_enabled: enabled ? "true" : "false",
      });
      setUrlDraft(null);
      setFormatDraft(null);
      setEnabledDraft(null);
      setNotice("Webhook settings saved.");
    });
  };

  const saveTtl = (e: React.FormEvent) => {
    e.preventDefault();
    const days = Number(ttl.trim());
    if (!Number.isInteger(days) || days < 1) {
      setFormError("Retention must be a positive number of days.");
      return;
    }
    void run(async () => {
      await api.updateSettings({ raw_ttl_days: String(days) });
      setTtlDraft(null);
      setNotice("Retention saved — the next prune run applies it.");
    });
  };

  const saveAlerts = (e: React.FormEvent) => {
    e.preventDefault();
    const zero = zeroToolAlert.trim();
    const hourly = hourlyAlert.trim();
    for (const [name, raw] of [
      ["zero-tool burn", zero],
      ["hourly burn", hourly],
    ] as const) {
      if (raw !== "" && (!Number.isInteger(Number(raw)) || Number(raw) < 0)) {
        setFormError(`${name} must be a non-negative whole number or empty.`);
        return;
      }
    }
    void run(async () => {
      await api.updateSettings({
        alert_zero_tool_tokens: zero,
        alert_hourly_tokens: hourly,
      });
      setZeroToolDraft(null);
      setHourlyDraft(null);
      setNotice("Alerts saved — checks apply to the next ingested batches.");
    });
  };

  const sendTest = () =>
    void run(async () => {
      await api.testWebhook();
      setNotice("Test delivery sent — check the chat.");
    });

  return (
    <>
      <h2 className="page-title">Settings</h2>
      <p className="page-sub">
        Org-wide behaviors. Everything applies immediately on save.
      </p>
      <ErrorBanner message={error?.message ?? null} />

      <div className="settings-col">
        <section className="settings-card">
          <div className="card-head">
            <h3 className="card-title">Session notifications</h3>
            <span className={`settings-status ${webhookLive ? "live" : "off"}`}>
              {webhookLive
                ? "Enabled"
                : url.trim()
                  ? "Disabled"
                  : "Not configured"}
            </span>
          </div>
          <p className="card-lede">
            Post one message to your team chat whenever a session ends, so the
            team sees what the agents did without opening the dashboard.
            Delivery never blocks capture — a dead webhook only logs on the
            server.
          </p>
          <form className="settings-form" onSubmit={saveWebhook}>
            <label className="field wide">
              <span>Webhook URL</span>
              <input
                value={url}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="https://hooks.example.com/…"
              />
            </label>
            <div className="field">
              <span>Message format</span>
              <Select
                label="Message format"
                value={format}
                onChange={setFormatDraft}
                options={[
                  { value: "slack", label: "Slack-style {text}" },
                  { value: "feishu", label: "Feishu" },
                  { value: "dingtalk", label: "DingTalk" },
                ]}
              />
            </div>
            <label className="field checkbox">
              <span>Delivery</span>
              <span className="checkbox-row">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) =>
                    setEnabledDraft(e.target.checked ? "true" : "false")
                  }
                />
                Enabled
              </span>
            </label>
            <div className="field actions">
              <button className="primary" type="submit">
                Save
              </button>
              <button
                type="button"
                disabled={url.trim().length === 0}
                title={
                  url.trim().length === 0
                    ? "Configure a URL first"
                    : "Push a real test message to the webhook"
                }
                onClick={sendTest}
              >
                Send test
              </button>
            </div>
          </form>
        </section>

        <section className="settings-card">
          <div className="card-head">
            <h3 className="card-title">Anomaly alerts</h3>
            <span className={`settings-status ${alertsLive ? "live" : "off"}`}>
              {alertsLive ? "Armed" : "Off"}
            </span>
          </div>
          <p className="card-lede">
            Push a chat message when something looks off: a session burning
            tokens with zero tool calls at all, or one user's hourly burn
            crossing a ceiling. Findings are audited and fire once per session
            or hour; empty or 0 keeps a check off.
          </p>
          <form className="settings-form" onSubmit={saveAlerts}>
            <label className="field">
              <span>Zero-tool session burn ≥ (tokens)</span>
              <input
                type="number"
                min={0}
                step={1}
                placeholder="off"
                value={zeroToolAlert}
                onChange={(e) => setZeroToolDraft(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Hourly burn per user ≥ (tokens)</span>
              <input
                type="number"
                min={0}
                step={1}
                placeholder="off"
                value={hourlyAlert}
                onChange={(e) => setHourlyDraft(e.target.value)}
              />
            </label>
            <div className="field actions">
              <button className="primary" type="submit">
                Save
              </button>
            </div>
          </form>
        </section>

        <section className="settings-card">
          <div className="card-head">
            <h3 className="card-title">Data retention</h3>
            <span className="settings-status off">global default</span>
          </div>
          <p className="card-lede">
            How many days raw prompts and responses are kept before expiry. A
            team's own retention override wins over this default; when object
            storage is configured, payloads are archived before they are
            removed.
          </p>
          <form className="settings-form" onSubmit={saveTtl}>
            <label className="field">
              <span>Keep raw payloads for (days)</span>
              <input
                type="number"
                min={1}
                step={1}
                value={ttl}
                onChange={(e) => setTtlDraft(e.target.value)}
              />
            </label>
            <div className="field actions">
              <button className="primary" type="submit">
                Save
              </button>
            </div>
          </form>
        </section>
        <section className="settings-card">
          <div className="card-head">
            <h3 className="card-title">Retrospective angles</h3>
            <span className="settings-status off">org-wide presets</span>
          </div>
          <RetroAnglesCard
            api={api}
            refresh={refresh}
            stored={current.retro_angles ?? "[]"}
          />
        </section>
      </div>

      <ErrorBanner message={formError} />
      {notice && <p className="dim">{notice}</p>}
    </>
  );
};

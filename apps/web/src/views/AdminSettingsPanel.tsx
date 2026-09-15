import { useState } from "react";
import type { AdminApi } from "../api";
import { errorMessage } from "../lib/format";
import { usePolled, type PollError } from "./AdminView";

type Props = {
  api: AdminApi;
  refreshKey: number;
  refresh: () => void;
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
    usePolled(() => api.settings(), refreshKey);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [formatDraft, setFormatDraft] = useState<string | null>(null);
  const [enabledDraft, setEnabledDraft] = useState<string | null>(null);
  const [ttlDraft, setTtlDraft] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setFormError(null);
    setNotice(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  const current = settings ?? {};
  const url = urlDraft ?? current.webhook_url ?? "";
  const format = formatDraft ?? current.webhook_format ?? "slack";
  const enabled =
    (enabledDraft ?? current.webhook_enabled ?? "true") === "true";
  const ttl = ttlDraft ?? current.raw_ttl_days ?? "90";

  const webhookLive = url.trim().length > 0 && enabled;

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

  const sendTest = () =>
    void run(async () => {
      await api.testWebhook();
      setNotice("Test delivery sent — check the chat.");
    });

  return (
    <>
      <h2 className="page-title">Settings</h2>
      <p className="page-sub">
        Two org-wide behaviors. Everything applies immediately on save.
      </p>
      {error && <p className="banner-error">{error.message}</p>}

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
            <label className="field">
              <span>Message format</span>
              <select
                value={format}
                onChange={(e) => setFormatDraft(e.target.value)}
              >
                <option value="slack">Slack-style {"{text}"}</option>
                <option value="feishu">Feishu</option>
                <option value="dingtalk">DingTalk</option>
              </select>
            </label>
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
      </div>

      {formError && <p className="banner-error">{formError}</p>}
      {notice && <p className="dim">{notice}</p>}
    </>
  );
};

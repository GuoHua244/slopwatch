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
 * Operator settings (v2 decision 25, broadened): the org webhook that
 * receives a message whenever a session finishes, and the global raw-payload
 * retention default. Values shown are the server's effective configuration —
 * stored overrides merged over boot defaults — so what you see is what runs.
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
        "webhook URL is required — untick enabled to switch pushes off",
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
      setNotice("webhook settings saved");
    });
  };

  const saveTtl = (e: React.FormEvent) => {
    e.preventDefault();
    const days = Number(ttl.trim());
    if (!Number.isInteger(days) || days < 1) {
      setFormError("retention must be a positive number of days");
      return;
    }
    void run(async () => {
      await api.updateSettings({ raw_ttl_days: String(days) });
      setTtlDraft(null);
      setNotice("retention saved — the next prune run applies it");
    });
  };

  const sendTest = () =>
    void run(async () => {
      await api.testWebhook();
      setNotice("test delivery sent — check the chat");
    });

  return (
    <>
      <h2>settings</h2>
      {error && <p className="banner-error">{error.message}</p>}

      <section className="settings-section">
        <h3>session webhook</h3>
        <p className="dim">
          One org-level incoming-webhook bot. Every finished session pushes a
          single message (user, agent, session id). Delivery never blocks
          capture — a dead webhook only logs on the server.
        </p>
        <p className={`state ${webhookLive ? "live" : ""}`}>
          {webhookLive
            ? "enabled — pushes on every finished session"
            : url.trim()
              ? "disabled — the URL is kept but nothing is pushed"
              : "not configured"}
        </p>
        <form className="settings-form" onSubmit={saveWebhook}>
          <label className="field wide">
            <span>webhook URL</span>
            <input
              value={url}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://hooks.example.com/…"
            />
          </label>
          <label className="field">
            <span>message format</span>
            <select
              value={format}
              onChange={(e) => setFormatDraft(e.target.value)}
            >
              <option value="slack">slack-style {"{text}"}</option>
              <option value="feishu">feishu</option>
              <option value="dingtalk">dingtalk</option>
            </select>
          </label>
          <label className="field checkbox">
            <span>delivery</span>
            <span className="checkbox-row">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) =>
                  setEnabledDraft(e.target.checked ? "true" : "false")
                }
              />
              enabled
            </span>
          </label>
          <div className="field actions">
            <button type="submit">save</button>
            <button
              type="button"
              disabled={url.trim().length === 0}
              title={
                url.trim().length === 0
                  ? "configure a URL first"
                  : "push a real test message to the webhook"
              }
              onClick={sendTest}
            >
              send test
            </button>
          </div>
        </form>
      </section>

      <section className="settings-section">
        <h3>raw payload retention</h3>
        <p className="dim">
          Days before captured raw payloads are expired (and archived first when
          object storage is configured). A team's own retention override wins
          over this global default; clearing the stored value falls back to the
          deployment's boot default.
        </p>
        <form className="settings-form" onSubmit={saveTtl}>
          <label className="field">
            <span>global default (days)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={ttl}
              onChange={(e) => setTtlDraft(e.target.value)}
            />
          </label>
          <div className="field actions">
            <button type="submit">save</button>
          </div>
        </form>
      </section>

      {formError && <p className="banner-error">{formError}</p>}
      {notice && <p className="dim">{notice}</p>}
    </>
  );
};

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
 * Operator settings (v2 decision 25): one org-level webhook that receives a
 * message whenever a session finishes. The URL is any incoming-webhook bot
 * endpoint (Slack-style {text}, Feishu or DingTalk formats supported); the
 * test button pushes a real delivery so misconfiguration surfaces at setup.
 */
export const AdminSettingsPanel = ({ api, refreshKey, refresh }: Props) => {
  const {
    data: settings,
    error,
  }: { data: Record<string, string> | null; error: PollError | null } =
    usePolled(() => api.settings(), refreshKey);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [formatDraft, setFormatDraft] = useState<string | null>(null);
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
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
  const enabled = enabledDraft ?? current.webhook_enabled !== "false";

  return (
    <>
      <h2>settings</h2>
      {error && <p className="banner-error">{error.message}</p>}
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) {
            setFormError("webhook URL is required");
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
            setNotice("settings saved");
          });
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrlDraft(e.target.value)}
          placeholder="webhook URL (https://…)"
        />
        <select value={format} onChange={(e) => setFormatDraft(e.target.value)}>
          <option value="slack">slack-style {"{text}"}</option>
          <option value="feishu">feishu</option>
          <option value="dingtalk">dingtalk</option>
        </select>
        <label className="dim">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabledDraft(e.target.checked)}
          />
          enabled
        </label>
        <button type="submit">save</button>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await api.testWebhook();
              setNotice("test delivery sent — check the chat");
            })
          }
        >
          send test
        </button>
      </form>
      {formError && <p className="banner-error">{formError}</p>}
      {notice && <p className="dim">{notice}</p>}
      <p className="dim">
        Finished sessions push one message each: user, agent, and session id.
        Delivery never blocks capture — a dead webhook only logs on the server.
      </p>
    </>
  );
};

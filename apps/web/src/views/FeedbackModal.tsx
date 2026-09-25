import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createFeedbackApi, type FeedbackKind } from "../api";
import { storedToken } from "../auth";
import { errorMessage, fmtBytes, shortId } from "../lib/format";
import {
  FEEDBACK_ACCEPT,
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_MAX_FILES,
  FEEDBACK_TEXT_MAX,
  feedbackFilesError,
} from "../lib/feedback";
import { ErrorBanner } from "./admin-shared";
import { Select } from "./Select";

type Props = {
  /** Null files a global feedback (the nav entry); a session id anchors it. */
  sessionId: string | null;
  onClose: () => void;
  onSent: () => void;
};

/**
 * The feedback composer (ADR 0009): a kind, the required text, and optional
 * attachments. Portalled over the page; nothing here implies a workflow —
 * the confirmation is the whole feedback loop, by design.
 */
export const FeedbackModal = ({ sessionId, onClose, onSent }: Props) => {
  const api = useMemo(() => createFeedbackApi(() => storedToken()), []);
  const [kind, setKind] = useState<FeedbackKind>("missing_content");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const fileError = files.length > 0 ? feedbackFilesError(files) : null;
  const submitDisabled = busy || text.trim().length === 0 || fileError !== null;

  const submit = async () => {
    if (submitDisabled) return;
    setBusy(true);
    setError(null);
    try {
      await api.submit({
        kind,
        text: text.trim(),
        sessionId: sessionId ?? undefined,
        files,
      });
      onSent();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card panel-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>Send feedback</h3>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="dim modal-sub">
          Something look wrong on{" "}
          {sessionId === null ? "slopwatch" : "this session"}? Tell the
          maintainers — every note is read.
        </p>
        {sessionId !== null && (
          <p className="dim modal-sub">
            Anchored to <span className="mono">{shortId(sessionId)}</span>
          </p>
        )}
        <ErrorBanner message={error} />
        <form
          className="feedback-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="modal-label">Kind</label>
          <Select
            label="Feedback kind"
            value={kind}
            onChange={(next) => setKind(next as FeedbackKind)}
            options={FEEDBACK_KINDS.map((k) => ({
              value: k,
              label: FEEDBACK_KIND_LABELS[k],
            }))}
          />
          <label className="modal-label" htmlFor="feedback-text">
            What happened? <span className="dim">(required)</span>
          </label>
          <textarea
            id="feedback-text"
            value={text}
            maxLength={FEEDBACK_TEXT_MAX}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder="Describe the problem — turn numbers, token counts, what you expected…"
            autoFocus
          />
          <label className="modal-label" htmlFor="feedback-files">
            Attachments{" "}
            <span className="dim">
              (optional — screenshots, logs, documents)
            </span>
          </label>
          <input
            ref={inputRef}
            id="feedback-files"
            type="file"
            multiple
            accept={FEEDBACK_ACCEPT}
            onChange={(e) => {
              setFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {fileError !== null && <p className="banner-error">{fileError}</p>}
          {files.length > 0 && fileError === null && (
            <ul className="feedback-files">
              {files.map((file, i) => (
                <li key={`${file.name}-${i}`}>
                  <span className="file-chip-name">{file.name}</span>
                  <span className="dim">{fmtBytes(file.size)}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setFiles(files.filter((_, index) => index !== i))
                    }
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <span className="dim">
              {text.trim().length}/{FEEDBACK_TEXT_MAX} · up to{" "}
              {FEEDBACK_MAX_FILES} files
            </span>
            <span className="pager">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={submitDisabled}
              >
                {busy ? "Sending…" : "Send feedback"}
              </button>
            </span>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
};

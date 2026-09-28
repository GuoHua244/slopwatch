import { useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// The action-runner hook serves non-admin views too (MeView, session
// detail); it lives with the other hooks and is re-exported here so every
// panel's existing import keeps working.
export { useAsyncAction } from "../hooks/useAsyncAction";

/** The 1-based showing window for the current page, clamped to the total. */
export const pageWindow = (
  total: number,
  page: number,
  pageSize: number,
): { from: number; to: number } => ({
  from: total === 0 ? 0 : page * pageSize + 1,
  to: Math.min((page + 1) * pageSize, total),
});

type PagerProps = {
  page: number;
  setPage: (next: number) => void;
  total: number;
  from: number;
  to: number;
  /** The zero-rows label — "No entries", "No feedback", … */
  emptyLabel: string;
};

/** The standard list pagination: a showing range over Newer/Older pagers. */
export const Pager = ({
  page,
  setPage,
  total,
  from,
  to,
  emptyLabel,
}: PagerProps) => (
  <div className="pagination">
    <span className="dim">
      {total === 0 ? emptyLabel : `Showing ${from}–${to} of ${total}`}
    </span>
    <span className="pager">
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>
        Newer
      </button>
      <button disabled={to >= total} onClick={() => setPage(page + 1)}>
        Older
      </button>
    </span>
  </div>
);

/** The standard red banner; null renders nothing. */
export const ErrorBanner = ({ message }: { message: string | null }) =>
  message === null ? null : <p className="banner-error">{message}</p>;

type ClipTipProps = {
  /** The full text to reveal; null/undefined renders the children with no tooltip. */
  label: string | null | undefined;
  className?: string;
  children: ReactNode;
};

/**
 * The truncated-cell hover tooltip: the native title bubble is light-on-dark
 * hostile, lags about a second, and positions itself. This one is themed,
 * shows the moment the cursor enters, and always sits above the cell —
 * portalled to <body> so scrollable table wrappers cannot clip it.
 */
export const ClipTip = ({ label, className, children }: ClipTipProps) => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  return (
    <span
      className={className}
      onMouseEnter={(e) => setRect(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setRect(null)}
    >
      {children}
      {rect !== null &&
        label !== null &&
        label !== undefined &&
        createPortal(
          <span
            className="tip"
            style={{
              /* Keep the bubble on-screen even for edge cells. */
              left: Math.min(
                Math.max(rect.left + rect.width / 2, 110),
                window.innerWidth - 110,
              ),
              top: rect.top - 6,
            }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
};

type ConfirmButtonProps = {
  className?: string;
  /** The confirm() question; the action runs only when it is accepted. */
  message: string;
  onClick: () => void;
  children: ReactNode;
};

/** A button that asks once before acting — the destructive-action affordance. */
export const ConfirmButton = ({
  className,
  message,
  onClick,
  children,
}: ConfirmButtonProps) => (
  <button
    className={className}
    onClick={() => {
      if (confirm(message)) onClick();
    }}
  >
    {children}
  </button>
);

import { useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../lib/format";

/**
 * The one shape every admin mutation takes: clear the form error, run the
 * action, refresh the polled panels on success, surface the failure
 * otherwise. `onError` is the panel's error-message setter (pass a callback
 * that also clears sibling notices); `refresh` bumps the shared refreshKey.
 */
export const useAsyncAction = (
  onError: (message: string | null) => void,
  refresh?: () => void,
): ((fn: () => Promise<void>) => Promise<void>) => {
  const run = async (fn: () => Promise<void>) => {
    onError(null);
    try {
      await fn();
      refresh?.();
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  return run;
};

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

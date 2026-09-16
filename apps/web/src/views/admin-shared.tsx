import type { ReactNode } from "react";
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

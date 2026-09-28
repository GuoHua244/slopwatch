import { errorMessage } from "../lib/format";

/**
 * The one shape every form mutation takes: clear the form error, run the
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

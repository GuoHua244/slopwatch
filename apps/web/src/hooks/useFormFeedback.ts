import { useState } from "react";
import { useAsyncAction } from "./useAsyncAction";

/**
 * The standard form feedback pair — one error line, one notice line — plus
 * the shared action runner wired to both: every attempt clears the notice
 * alongside the error, a failure lands in the error line, and a success
 * clears both before the caller posts its own notice. `onSettled` bumps the
 * polled refresh key after a successful action.
 */
export const useFormFeedback = (onSettled?: () => void) => {
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = useAsyncAction((message) => {
    setFormError(message);
    if (message === null) setNotice(null);
  }, onSettled);
  return { formError, setFormError, notice, setNotice, run };
};

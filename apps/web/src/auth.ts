/**
 * The browser's user identity (v2 decision 22 / ADR 0003): one user token,
 * pasted once, kept in localStorage, sent as a bearer on every data call.
 * The admin plane keeps its separate token (AdminView).
 *
 * localStorage is optional: bun tests run api code without a DOM.
 */
const hasStorage = (): boolean => typeof localStorage !== "undefined";

const USER_TOKEN_KEY = "slopwatch.token";
/** Pre-decision-22 key that only guarded review actions — migrate silently. */
const LEGACY_REVIEW_TOKEN_KEY = "slopwatch.review-token";

export const storedToken = (): string | null =>
  hasStorage()
    ? (localStorage.getItem(USER_TOKEN_KEY) ??
      localStorage.getItem(LEGACY_REVIEW_TOKEN_KEY))
    : null;

export const saveToken = (token: string): void => {
  if (!hasStorage()) return;
  localStorage.setItem(USER_TOKEN_KEY, token);
  localStorage.removeItem(LEGACY_REVIEW_TOKEN_KEY);
};

export const clearToken = (): void => {
  if (!hasStorage()) return;
  localStorage.removeItem(USER_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REVIEW_TOKEN_KEY);
};

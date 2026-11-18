import { defaultFetch, unwrapJson, type FetchLike } from "./http";

export type LoginResult = { token: string; user: string };

export type AuthApi = {
  /**
   * ADR 0011: exchange a user name and password for a session bearer.
   * Failures throw ApiError whose detail is the server's machine code —
   * `invalid_credentials`, `password_not_set` — so the sign-in gate can
   * speak plainly without the server leaking more than that.
   */
  login(name: string, password: string): Promise<LoginResult>;
  /**
   * Revoke the bearer's server-side session (a no-op for API tokens).
   * Best-effort: resolves even when the server is unreachable — the client
   * clears its own credential regardless.
   */
  logout(token: string | null): Promise<void>;
};

export const createAuthApi = (doFetch: FetchLike = defaultFetch): AuthApi => ({
  login: async (name, password) =>
    unwrapJson<LoginResult>(
      doFetch,
      "/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, password }),
      },
      "POST",
    ),
  logout: async (token) => {
    if (token === null) return;
    await doFetch("/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  },
});

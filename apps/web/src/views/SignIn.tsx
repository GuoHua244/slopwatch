import { useState } from "react";
import { createReviewApi } from "../api";
import { saveToken } from "../auth";

export type Role = "admin" | "member";

/**
 * Sign-in gate (v2 decision 22 / ADR 0003): the dashboard renders nothing
 * until a user token verifies against GET /me — every read needs a token.
 * The verify answer also carries the role, so the whole shell knows what the
 * signed-in user may see.
 */
export const SignInGate = ({
  onSignedIn,
}: {
  onSignedIn: (user: string, role: Role) => void;
}) => {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  return (
    <div className="auth-screen">
      <div className="auth-rings" aria-hidden>
        <span />
        <span />
      </div>
      <div className="auth-card">
        <div className="auth-brand">
          <span className="pulse" />
          slopwatch
        </div>
        <p className="auth-copy">
          Every AI coding session your team runs — captured, reviewable, and
          priced. Paste your user token to look inside.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const token = value.trim();
            if (!token) return;
            setChecking(true);
            setError(null);
            void createReviewApi(() => token)
              .me()
              .then((info) => {
                saveToken(token);
                onSignedIn(info.user, info.role);
              })
              .catch(() => {
                setError("that token did not verify — check it and try again");
              })
              .finally(() => setChecking(false));
          }}
        >
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste your user token (sw_…)"
            autoFocus
          />
          <button className="primary" type="submit" disabled={checking}>
            {checking ? "Checking…" : "Sign in"}
          </button>
        </form>
        {error && <p className="banner-error">{error}</p>}
        <p className="auth-hint">
          The token stays in this browser's localStorage only. Ask an admin to
          mint one on the admin page if you don't have it.
        </p>
      </div>
    </div>
  );
};

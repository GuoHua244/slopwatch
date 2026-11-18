import { useState } from "react";
import { createAuthApi, createReviewApi } from "../api";
import { saveToken, storedToken } from "../auth";
import { errorMessage } from "../lib/format";

export type Role = "admin" | "member";

/** Which door the gate shows: the human one (ADR 0011) or the token one. */
type Mode = "password" | "token";

/**
 * A token that verified against /me but whose user has no password yet —
 * the first-run state ADR 0011 exists for: sign in once with the issued
 * token, then set a password and never paste it again.
 */
type FirstRun = { token: string; user: string; role: Role };

const screenFrame = (inner: React.ReactNode) => (
  <div className="auth-screen">
    <div className="auth-rings" aria-hidden>
      <span />
      <span />
    </div>
    <div className="auth-card">{inner}</div>
  </div>
);

const brandBlock = (copy: string) => (
  <>
    <div className="auth-brand">
      <span className="pulse" />
      slopwatch
    </div>
    <p className="auth-copy">{copy}</p>
  </>
);

/**
 * Sign-in gate (v2 decision 22 / ADR 0003, doors per ADR 0011): the
 * dashboard renders nothing until a credential verifies against GET /me —
 * every read needs one. The password door is primary; the token door
 * covers first sign-in (the admin-issued secret) and password recovery.
 * The verify answer carries the role, so the whole shell knows what the
 * signed-in user may see.
 */
export const SignInGate = ({
  onSignedIn,
}: {
  onSignedIn: (user: string, role: Role) => void;
}) => {
  const [mode, setMode] = useState<Mode>("password");
  const [notice, setNotice] = useState<string | null>(null);
  const [firstRun, setFirstRun] = useState<FirstRun | null>(null);

  if (firstRun !== null)
    return screenFrame(
      <>
        {brandBlock(
          `Welcome, ${firstRun.user} — you are signed in. Choose a password so next time your user name is all you need.`,
        )}
        <SetPasswordForm
          onDone={() => onSignedIn(firstRun.user, firstRun.role)}
        />
      </>,
    );

  return screenFrame(
    <>
      {brandBlock(
        mode === "password"
          ? "Every AI coding session your team runs — captured, reviewable, and priced. Sign in with your user name."
          : "Paste the API token an admin minted for you (Admin → Users). After this one sign-in you can set a password and drop the token habit.",
      )}
      <div className="auth-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={mode === "password"}
          className={mode === "password" ? "active" : ""}
          onClick={() => setMode("password")}
        >
          Sign in
        </button>
        <button
          role="tab"
          aria-selected={mode === "token"}
          className={mode === "token" ? "active" : ""}
          onClick={() => setMode("token")}
        >
          Use a token
        </button>
      </div>
      {mode === "password" ? (
        <PasswordForm
          onSignedIn={onSignedIn}
          onNoPassword={(message) => {
            setNotice(message);
            setMode("token");
          }}
        />
      ) : (
        <TokenForm
          onSignedIn={onSignedIn}
          onFirstRun={(run) => {
            setFirstRun(run);
            setNotice(null);
          }}
          onNotice={setNotice}
        />
      )}
      {notice && <p className="auth-hint">{notice}</p>}
    </>,
  );
};

/** The human door: user name and password → session bearer → the dashboard. */
const PasswordForm = ({
  onSignedIn,
  onNoPassword,
}: {
  onSignedIn: (user: string, role: Role) => void;
  onNoPassword: (message: string) => void;
}) => {
  const authApi = useState(() => createAuthApi())[0];
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !password) return;
    setChecking(true);
    setError(null);
    void authApi
      .login(name.trim(), password)
      .then((res) => {
        saveToken(res.token);
        return createReviewApi(() => res.token).me();
      })
      .then((info) => onSignedIn(info.user, info.role))
      .catch((err: unknown) => {
        if (String(err).includes("password_not_set")) {
          onNoPassword(
            "That account has no password yet — use the token door once (an admin minted yours on Admin → Users) and set a password from there.",
          );
          return;
        }
        if (String(err).includes("invalid_credentials"))
          setError("Wrong user name or password.");
        else if (String(err).includes("429"))
          setError("Too many failed attempts — wait a few minutes.");
        else setError(errorMessage(err));
      })
      .finally(() => setChecking(false));
  };

  return (
    <form onSubmit={submit}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="User name"
        autoFocus
        autoComplete="username"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        autoComplete="current-password"
      />
      <button className="primary" type="submit" disabled={checking}>
        {checking ? "Checking…" : "Sign in"}
      </button>
      {error && <p className="banner-error">{error}</p>}
      <p className="auth-hint">
        First time here, or forgot your password? A token from an admin opens
        the token door.
      </p>
    </form>
  );
};

/**
 * The token door (the original flow): paste the issued API token, verify
 * via /me, keep it in localStorage. A user without a password is invited
 * to set one before entering — the whole point of ADR 0011.
 */
const TokenForm = ({
  onSignedIn,
  onFirstRun,
  onNotice,
}: {
  onSignedIn: (user: string, role: Role) => void;
  onFirstRun: (firstRun: FirstRun) => void;
  onNotice: (message: string | null) => void;
}) => {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setChecking(true);
    setError(null);
    onNotice(null);
    void createReviewApi(() => token)
      .me()
      .then((info) => {
        saveToken(token);
        if (!info.password_set) {
          onFirstRun({ token, user: info.user, role: info.role });
          return;
        }
        onSignedIn(info.user, info.role);
      })
      .catch(() => {
        setError("that token did not verify — check it and try again");
      })
      .finally(() => setChecking(false));
  };

  return (
    <form onSubmit={submit}>
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
      {error && <p className="banner-error">{error}</p>}
      <p className="auth-hint">
        The token stays in this browser's localStorage only. Ask an admin to
        mint one on the admin page if you don't have it.
      </p>
    </form>
  );
};

/** The first-run prompt: set a password now, or step over it (any time on Me). */
const SetPasswordForm = ({ onDone }: { onDone: () => void }) => {
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 8) {
      setError("At least 8 characters, please.");
      return;
    }
    if (next !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setSaving(true);
    setError(null);
    void createReviewApi(storedToken)
      .setPassword({ new_password: next })
      .then(onDone)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setSaving(false));
  };

  return (
    <form onSubmit={submit}>
      <input
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder="New password (8+ characters)"
        autoFocus
        autoComplete="new-password"
      />
      <input
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Repeat it"
        autoComplete="new-password"
      />
      <button className="primary" type="submit" disabled={saving}>
        {saving ? "Saving…" : "Set password and continue"}
      </button>
      <button type="button" className="auth-skip" onClick={onDone}>
        Not now — maybe later
      </button>
      {error && <p className="banner-error">{error}</p>}
    </form>
  );
};

import { Eye, EyeOff } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { API_BASE_URL } from "../api/api";
import { useAuth } from "./auth";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { InlineAlert } from "../ui/InlineAlert";

export function LoginPage() {
  const auth = useAuth();
  const nav = useNavigate();
  const loc = useLocation();

  const fromPath = useMemo(() => {
    const state = loc.state as { from?: { pathname?: string } } | null;
    return state?.from?.pathname ?? "/dashboard";
  }, [loc.state]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (auth.status === "authenticated") return <Navigate to="/dashboard" replace />;

  return (
    <div className="center-page">
      <div className="login-card card">
        <div className="login-header">
          <div className="login-title">Anmeldung</div>
          <div className="login-sub">HTTP Basic Auth zur ERP-API.</div>
        </div>

        {auth.message ? (
          <InlineAlert tone="error" onDismiss={() => auth.clearMessage()}>
            {auth.message}
          </InlineAlert>
        ) : null}

        {error ? (
          <InlineAlert tone="error" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        ) : null}

        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const next = { username: username.trim(), password };
            if (!next.username || !next.password) return;
            setIsSubmitting(true);
            setError(null);
            try {
              await auth.login(next, { remember });
              nav(fromPath, { replace: true });
            } catch {
              setError("Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen.");
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <Field label="Benutzername">
            <input
              className="input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isSubmitting}
            />
          </Field>

          <Field label="Passwort">
            <div className="input-row">
              <input
                className="input"
                type={showPw ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="pw-toggle"
                aria-label={showPw ? "Passwort verbergen" : "Passwort anzeigen"}
                onClick={() => setShowPw((v) => !v)}
              >
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </Button>
            </div>
          </Field>

          <label className="checkbox">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={isSubmitting} />
            Zugangsdaten merken (lokal)
          </label>

          <Button type="submit" variant="primary" disabled={!username.trim() || !password || isSubmitting}>
            {isSubmitting ? "Prüfe…" : "Anmelden"}
          </Button>

          <div className="fineprint">
            API-Basis-URL: <span className="mono">{API_BASE_URL}</span>
          </div>
        </form>
      </div>
    </div>
  );
}

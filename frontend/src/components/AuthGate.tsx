import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../lib/auth";
import { validateBasicAuth } from "../lib/api";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { InlineMessage } from "./ui/inline-message";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { credentials, setCredentials, clearCredentials } = useAuth();
  const [username, setUsername] = useState(credentials?.username ?? "");
  const [password, setPassword] = useState(credentials?.password ?? "");
  const [isChecking, setIsChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hasStoredCredentials = useMemo(() => !!credentials, [credentials]);

  useEffect(() => {
    if (!credentials) return;
    const controller = new AbortController();
    setIsChecking(true);
    setMessage(null);
    validateBasicAuth(credentials, controller.signal)
      .catch(() => {
        clearCredentials();
        setMessage("Gespeicherte Zugangsdaten sind ungültig. Bitte erneut anmelden.");
      })
      .finally(() => {
        setIsChecking(false);
      });
    return () => controller.abort();
  }, [credentials, clearCredentials]);

  if (credentials && !isChecking) return <>{children}</>;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle>Anmeldung</CardTitle>
            <CardDescription>HTTP Basic Auth für die ERP-API.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {message ? <InlineMessage tone="error">{message}</InlineMessage> : null}
            <div className="space-y-2">
              <Label>Benutzername</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" disabled={isChecking} />
            </div>
            <div className="space-y-2">
              <Label>Passwort</Label>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
                disabled={isChecking}
              />
            </div>
            <Button
              className="w-full"
              onClick={async () => {
                const next = { username: username.trim(), password };
                if (!next.username || !next.password) return;
                setIsChecking(true);
                setMessage(null);
                try {
                  await validateBasicAuth(next);
                  setCredentials(next);
                } catch {
                  setMessage("Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen.");
                } finally {
                  setIsChecking(false);
                }
              }}
              disabled={!username.trim() || !password || isChecking}
            >
              {isChecking ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
              {hasStoredCredentials ? "Zugangsdaten prüfen…" : "Anmelden"}
            </Button>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              API-Basis-URL:{" "}
              <span className="font-mono">{import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api/v1"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

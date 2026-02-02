import { useState } from "react";

import { useAuth } from "../lib/auth";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { credentials, setCredentials } = useAuth();
  const [username, setUsername] = useState(credentials?.username ?? "");
  const [password, setPassword] = useState(credentials?.password ?? "");

  if (credentials) return <>{children}</>;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-md px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle>Anmeldung</CardTitle>
            <CardDescription>HTTP Basic Auth für die ERP-API.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Benutzername</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            </div>
            <div className="space-y-2">
              <Label>Passwort</Label>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
              />
            </div>
            <Button
              className="w-full"
              onClick={() => setCredentials({ username: username.trim(), password })}
              disabled={!username.trim() || !password}
            >
              Zugangsdaten speichern
            </Button>
            <div className="text-xs text-gray-500">
              API-Basis-URL:{" "}
              <span className="font-mono">{import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api/v1"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

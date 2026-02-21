import { Navigate, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "./auth";
import { FullPageSpinner } from "../ui/FullPageSpinner";

export function RequireAuth() {
  const auth = useAuth();
  const loc = useLocation();

  if (auth.status === "checking") {
    return <FullPageSpinner label="Prüfe Zugangsdaten…" />;
  }

  if (auth.status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: loc }} />;
  }

  return <Outlet />;
}


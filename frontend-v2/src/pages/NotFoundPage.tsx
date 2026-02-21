import { Link } from "react-router-dom";

import { Button } from "../ui/Button";

export function NotFoundPage() {
  return (
    <div className="center-page">
      <div className="card">
        <div className="h1">Seite nicht gefunden</div>
        <p className="muted">Die angeforderte Route existiert nicht.</p>
        <div style={{ marginTop: 12 }}>
          <Button asChild>
            <Link to="/dashboard">Zur Übersicht</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}


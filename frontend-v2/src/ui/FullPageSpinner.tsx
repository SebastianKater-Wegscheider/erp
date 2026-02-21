export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div className="center-page">
      <div className="card" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <div style={{ marginTop: 10 }} className="muted">
          {label ?? "Lädt…"}
        </div>
      </div>
    </div>
  );
}


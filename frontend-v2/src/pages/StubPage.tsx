export function StubPage({ title }: { title: string }) {
  return (
    <div className="card">
      <div className="h1">{title}</div>
      <p className="muted">Dieses Modul ist in Frontend v2 noch nicht umgesetzt.</p>
    </div>
  );
}


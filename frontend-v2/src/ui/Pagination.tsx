import { Button } from "./Button";

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const safeTotal = Math.max(0, total);
  const maxPage = Math.max(1, Math.ceil(safeTotal / pageSize));
  const safePage = Math.min(Math.max(1, page), maxPage);

  const from = safeTotal === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safeTotal, safePage * pageSize);

  return (
    <div className="toolbar" aria-label="Pagination">
      <Button variant="ghost" size="sm" onClick={() => onPageChange(1)} disabled={safePage <= 1}>
        «
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onPageChange(safePage - 1)} disabled={safePage <= 1}>
        ←
      </Button>
      <div className="muted" style={{ fontSize: 12 }}>
        {from}-{to} / {safeTotal} · Seite {safePage} / {maxPage}
      </div>
      <Button variant="ghost" size="sm" onClick={() => onPageChange(safePage + 1)} disabled={safePage >= maxPage}>
        →
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onPageChange(maxPage)} disabled={safePage >= maxPage}>
        »
      </Button>
    </div>
  );
}


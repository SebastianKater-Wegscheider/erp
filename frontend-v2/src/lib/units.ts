export function fmtBp(bp: number | null | undefined, empty: string = "—"): string {
  if (bp === null || bp === undefined) return empty;
  return `${(bp / 100).toFixed(2)}%`;
}


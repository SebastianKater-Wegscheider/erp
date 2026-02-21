export function formatEur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}${euros},${rest.toString().padStart(2, "0")}`;
}

export function fmtEur(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `${formatEur(cents)} €`;
}

export function parseEurToCents(input: string): number {
  const s = input.trim().replace(/\s+/g, "").replace(",", ".");
  if (s === "") return 0;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error("Ungültiger EUR-Betrag");
  }
  const [intPart, decPart = ""] = s.split(".");
  const sign = intPart.startsWith("-") ? -1 : 1;
  const intDigits = intPart.replace("-", "");
  const euros = Number(intDigits);
  const cents = Number((decPart + "00").slice(0, 2));
  return sign * (euros * 100 + cents);
}


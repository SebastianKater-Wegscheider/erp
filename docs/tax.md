# Umsatzsteuer & Differenzbesteuerung (AT) – Implementationsnotizen

Diese Notizen beschreiben die **aktuelle Auslegung/Implementierung** in diesem ERP für österreichische Gebrauchtwarenhändler (EPU).
Sie sind **keine Steuerberatung** und ersetzen keine Prüfung durch Steuerberatung/Finanz.

## Zielbild (Scope)

- **Einzeldifferenz** (pro Artikel): Marge = Gegenleistung (inkl. Versandanteil) − Anschaffungskosten
- **Versand als Bestandteil der Gegenleistung** (Regel): Versand wird proportional auf die verkauften Positionen verteilt.
- **Mischkörbe** (regelbesteuert + differenzbesteuert in einer Rechnung) sind möglich.

## Datenmodell (Kurz)

- Einkauf:
  - `Purchase.kind`
    - `PRIVATE_DIFF`: Privatankauf (differenzbesteuert)
    - `COMMERCIAL_REGULAR`: Einkauf mit Rechnung (regelbesteuert, Vorsteuer möglich)
  - `Purchase.tax_rate_bp` (nur `COMMERCIAL_REGULAR`)
  - `Purchase.shipping_cost_cents` / `buyer_protection_fee_cents` (nur `PRIVATE_DIFF`, als Anschaffungsnebenkosten)
  - `Purchase.total_net_cents` / `total_tax_cents` (nur sinnvoll bei `COMMERCIAL_REGULAR`)
  - `PurchaseLine.purchase_price_*` + `tax_rate_bp`
  - `PurchaseLine.shipping_allocated_cents` / `buyer_protection_fee_allocated_cents` (proportionale Verteilung auf Artikel)
  - `InventoryItem.purchase_price_cents` ist die **Kostenbasis im Lager**:
    - `REGULAR`: netto (bei abzugsfähiger Vorsteuer)
    - `DIFF`: brutto (weil keine Vorsteuer im Privatankauf)
- Betriebsausgaben / Kostenverteilung:
  - `OpexExpense.amount_net_cents` / `amount_tax_cents`, `tax_rate_bp`, `input_tax_deductible`
  - `CostAllocation.amount_net_cents` / `amount_tax_cents`, `tax_rate_bp`, `input_tax_deductible`
  - Bei `input_tax_deductible=true` wird in `InventoryItem.allocated_costs_cents` **netto** erhöht, sonst brutto.

## Verkauf / Rechnung (Logik)

- Beim Anlegen eines Auftrags werden für `REGULAR` Positionen `sale_net_cents/sale_tax_cents` aus dem Brutto splitten.
- Für `DIFF` Positionen wird **keine USt ausgewiesen**; die tatsächliche Umsatzsteuer entsteht aus der **Marge** und wird intern berechnet.
- Beim Finalisieren:
  - `SalesOrder.shipping_gross_cents` wird proportional auf Positionen verteilt (`SalesOrderLine.shipping_allocated_cents`).
  - Für `DIFF` Positionen wird die interne Marge berechnet:
    - `consideration_gross = sale_gross + shipping_alloc`
    - `cost_basis = purchase_price + allocated_costs` (als Snapshot in `SalesOrderLine.cost_basis_cents`)
    - `margin_tax_cents` ist der aus der Marge herausgerechnete USt‑Anteil (aktuell 20%).
  - Für gemischte Rechnungen wird Versand und Summen in **regelbesteuert** vs. **differenzbesteuert** aufgeteilt.

## Korrekturen / Retouren

- Versand‑Refund wird proportional auf die betroffenen Positionen verteilt (`SalesCorrectionLine.shipping_refund_allocated_cents`).
- `REGULAR`: Steuerkorrektur über `refund_tax_cents` (klassischer Brutto→Netto/USt‑Split).
- `DIFF`: Steuerkorrektur über Änderung der Marge:
  - `margin_vat_adjustment_cents` = (ursprüngliche Margin‑USt) − (neue Margin‑USt nach Refund)

## Reports (UVA‑Vorbereitung)

- Endpoint: `POST /api/v1/reports/vat` mit `{ "year": 2026, "month": 2 }`
- Verwendete Quellen:
  - Output VAT (REGULAR): `SalesOrderLine.sale_tax_cents` + `SalesOrder.shipping_regular_tax_cents`
  - Output VAT (DIFF): `SalesOrderLine.margin_tax_cents`
  - Korrekturen: `SalesCorrectionLine.refund_tax_cents`, `SalesCorrection.shipping_refund_regular_tax_cents`,
    sowie `SalesCorrectionLine.margin_vat_adjustment_cents`
  - Input VAT: `Purchase.total_tax_cents` (`COMMERCIAL_REGULAR`) + `OpexExpense.amount_tax_cents` + `CostAllocation.amount_tax_cents` (wenn abzugsfähig)
- Monatsabschluss ZIP (`POST /api/v1/reports/month-close`) enthält u.a.:
  - `csv/vat_summary.csv`
  - `csv/sales_lines.csv` (inkl. Margin‑Felder)

## Konvolut‑Ankauf (Einzeldifferenz)

Wenn ein Konvolut gekauft wird, kann die Aufteilung auf einzelne Artikel über **Schätzwerte** erfolgen, solange:

- die Summe der Einzel‑EK dem tatsächlich bezahlten Gesamtbetrag entspricht,
- die Methode **plausibel, konsistent und dokumentiert** ist (z.B. Liste/Notiz/Quelle als Upload).

## Bekannte Einschränkungen

- Aktuell wird für die Marge **fix 20%** angenommen. Wenn ermäßigte Sätze relevant werden, muss das auf Positionsebene modelliert werden.
- Bestehende Datensätze vor der Schema‑Erweiterung haben ggf. `0` in neuen Feldern (kein Backfill).
- Schema‑Upgrades passieren derzeit per `ensure_schema()` beim Startup (MVP‑Stopgap); langfristig Alembic‑Migrationen.

# History

## 2026-02-08 - FBA Inbound & Lagerhaltung: Designentscheidungen

### Ausgangslage
- Der bisherige Inventar-Statusmodell war zu grob (`AVAILABLE` deckte stationäres Lager und FBA-Lager nicht getrennt ab).
- Dadurch waren Reporting (Asset-Wert), Kanalverfügbarkeit und operativer Versandprozess an Amazon nicht sauber abbildbar.

### Business-Entscheidungen
- Neue Status im Artikel-Lifecycle:
  - `FBA_INBOUND`: physisch versendet, noch nicht bei Amazon eingebucht.
  - `FBA_WAREHOUSE`: bei Amazon eingelagert, verkaufsbereit.
  - `DISCREPANCY`: Abweichung beim Wareneingang (z. B. nicht eingebucht), offen zur Nachverfolgung/Erstattung.
- Neues Modul „FBA Sendungen“ als operativer Container für Inbound-Batches.
- Versandkosten werden auf Artikelebene als Anschaffungsnebenkosten dauerhaft umgelegt (`allocated_costs_cents`), damit Margen auf Item-/Sales-Ebene korrekt bleiben.
- Beim Abschluss einer Sendung wird ein Soll/Ist-Abgleich erfasst; fehlende Artikel werden nicht automatisch als lagernd übernommen.

### Technische Entscheidungen
- Einführung eigener Tabellen für FBA-Sendungen und Sendungspositionen statt Wiederverwendung von `cost_allocations`, da Status-Workflow + Reconciliation domänenspezifisch sind.
- Versandkostenumlage erfolgt beim Statuswechsel `DRAFT -> SHIPPED` (atomar im gleichen Transaktionskontext wie Statuswechsel der Artikel).
- Verteilungsschlüssel:
  - `EQUAL`: gleichmäßig pro Artikel.
  - `PURCHASE_PRICE_WEIGHTED`: proportional zum Einkaufspreis.
- Dashboard-Lagerwert berücksichtigt zusätzlich FBA-Bestände (`FBA_INBOUND`, `FBA_WAREHOUSE`) und offene Abweichungen (`DISCREPANCY`).
- Verkaufsverfügbarkeit bleibt auf `AVAILABLE` beschränkt, um Doppelverkäufe während des FBA-Prozesses zu verhindern.

### Risiken / Trade-offs
- Ohne vollwertige Migrationstoolchain (aktuell `ensure_schema`) müssen Enum- und Tabellenänderungen robust idempotent gehalten werden.
- Weighted-Verteilung braucht deterministische Rundung, damit Summe der Einzelbeträge exakt den Gesamtversandkosten entspricht.

## 2026-02-08 - Umsetzung abgeschlossen (MVP)

### Ergebnis
- Backend erweitert um FBA-Sendungen inkl. Lifecycle, Kostenumlage und Reconciliation.
- Frontend erweitert um eigenes Modul "FBA Sendungen" inkl. Entwurf/Versenden/Empfangen.
- Reporting/Lagerwert berücksichtigt FBA-Bestände und Abweichungen.

### Offene technische Punkte (bewusst vertagt)
- Kein eigener Inventar-Detail-Endpunkt (`GET /inventory/{id}`), daher im Empfangsdialog aktuell Fokus auf Item-ID statt Produktmetadaten.
- Status `DISCREPANCY` bleibt als operativer Zwischenzustand für Nachverfolgung offen; finale Klärung erfolgt über manuelle Statuspflege (`FBA_WAREHOUSE`/`LOST`).

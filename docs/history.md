# History

## 2026-02-21 - Frontend v2: Minimalistische UX-Neustartlinie (parallel zu v1)

### Ausgangslage
- Frontend v1 ist funktional und feature-reich, wirkt aber visuell und strukturell ueberladen (hohe kognitive Last, inkonsistente Patterns).
- Der UX-Audit (2026-02-17) zeigt zusaetzlich konkrete Guardrail-Themen: Auth-Flow, Sprachmix sowie Betriebs-/Build-Hygiene.

### Business-Entscheidungen
- V2 wird **parallel** zu v1 aufgebaut (kein Big-Bang-Replace). v1 bleibt als Referenz und Fallback fuer Vollstaendigkeit bestehen.
- Ziel ist eine Operator-UX mit maximalem Signal/Rauschen-Verhaeltnis: klare Informationshierarchie, schnelle Navigation, praezise States/Fehlermeldungen.
- Iterationsstrategie: zuerst ein stabiler Kern (Auth + Shell + Kernmodule), danach schrittweises Portieren/Neudenken der restlichen Module.

### Technische Entscheidungen
- Neues Paket `frontend-v2/` als eigenstaendiger Vite+React+TypeScript Client, bewusst **minimal** in Dependencies und UI-Frameworking.
- Auth-Flow wird strikt: kein App-Shell-Render, bevor Basic-Auth gegen die API erfolgreich verifiziert wurde; bei `401` wird Session sofort geloescht.
- Datenlayer via TanStack Query (Caching, Retry, konsistente Loading/Error-States); API-Wrapper bleibt bewusst duenn.
- Routing via React Router mit `AppShell` Layout (Navigation + Content), damit Module konsistent wirken.
- Lokale Runtime: Compose bekommt optionalen `frontend-v2` Service auf eigenem Port; CORS-Defaults werden fuer parallelen Betrieb ergaenzt.

### Trade-offs
- Parallelbetrieb bedeutet kurzfristig doppelte UI-Pflege, senkt aber das Risiko und erlaubt eine saubere Migration mit klaren Cutover-Punkten.
- Minimalismus verzichtet initial auf dekorative UI und manche Komfortfunktionen; Fokus liegt zuerst auf Stabilitaet, Klarheit und Geschwindigkeit.

### Umsetzung (Start)
- `frontend-v2` erhaelt als erstes grosses "Operator-Modul" **Einkaeufe** inkl.:
  - Split-View (Liste links, Editor/Detail rechts) fuer schnelle Bearbeitung ohne Kontextwechsel.
  - Attachment-Flow: Upload sofort, Verknuepfung nach Save; MARKET_COMP kann (PAIV) an konkrete Positionen gebunden werden.
  - Mileage: optionale Fahrt direkt am Einkauf inkl. OSRM/Nominatim Routen-Preview (Leaflet), damit km nicht manuell geschaetzt werden.
  - Minimal UI-Primitives (`Modal`, `SearchCombo`) werden bewusst generisch gehalten, um sie fuer Sales/Marketplace wiederzuverwenden.
- Danach wird **Verkaeufe** portiert (ebenfalls Split-View) mit Fokus auf:
  - Draft → Finalize → Invoice PDF, inkl. Reopen-Guardrails (keine Corrections) und Status-getriebenen Actions.
  - Korrekturen/Returns direkt am Auftrag (inkl. PDF-Generierung), damit Accounting-Durchlauf ohne Kontextwechsel klappt.
- **Marktplatz** wird als Import-Pipeline umgesetzt: CSV → Auto-Matching → Review/Override → Apply; separater Payout-CSV Import erzeugt Ledger-Entries.
- Accounting-Operatoren in v2: **Kostenverteilung**, **OpEx**, **Fahrtenbuch**, **USt-Report** werden portiert (ohne UI-Overhead, mit den gleichen API-Guards wie v1).
- Dashboard v2 wird als **Tagesarbeits-Queue** gedacht statt als "Charts-Page":
  - KPI-Topline (Lagerwert/Profit/Umsatz) als schneller Kontext, ohne visuelle Ablenkung.
  - "Naechste Schritte" sind direkte Links in die operativen Queues (Sales-Drafts, fehlende Fotos/Lagerplaetze, Altbestand).
  - Cash/Accounting Snapshot (inkl. Insights) ist ausklappbar, damit das Tagesgeschaeft nicht blockiert, aber Finance stets greifbar bleibt.
  - Amazon Opportunities und Produkt-Top/Worst sind bewusst tabellarisch (scanbar, klickbar) statt als Diagramm.

## 2026-02-17 - Phase 2 Umsetzung: Hardening mit Fokus auf Beobachtbarkeit, Deduplizierung und Guardrails

### Ausgangslage
- Nach Phase 0/1 sind Verfuegbarkeit und Baseline-Stabilitaet deutlich besser, aber langfristige Regressionsrisiken bleiben in duplizierter Frontend-Logik, stillen Exception-Pfaden und zu weichen Ops-Checks.

### Business-Entscheidungen
- Phase-2-Start wird bewusst auf **riskante Wiederholungsfehler** fokussiert statt auf einen grossen Architektur-Refactor:
  1) shared helpers statt Copy/Paste in High-Churn-Pages
  2) observability auf catch-and-continue Pfaden
  3) strengere Restore/Health Guardrails fuer Deploy-Sicherheit
  4) schlankeres Runtime-Image im Standardpfad
- E2E wird zuerst um sales finalize/return erweitert; sourcing-e2e bleibt separat iterativ, um fragile externe Abhaengigkeiten zu vermeiden.

### Technische Entscheidungen
- Gemeinsame Clipboard-/Storage-/View-Mode Utilities unter `frontend/src/lib/`, angebunden in `Inventory` und `MasterProducts`.
- Silent catches in kritischen Services werden durch strukturierte Logs mit Kontext ersetzt (id/url/error-type), Verhalten bleibt robust.
- `backup_restore_drill.sh` erhaelt expliziten Strict-Alembic-Modus.
- Backend-Dockerfile wird in prod/dev Targets getrennt; Compose nutzt standardmaessig den prod-Target und erlaubt dev opt-in.
- Ops/CI Readiness prueft Deep-Health inkl. Migration-Status explizit.

### Umsetzung (inkrementell)
- Neue Shared-Utilities:
  - `frontend/src/lib/browserStorage.ts`
  - `frontend/src/lib/clipboard.ts`
  - `frontend/src/lib/inventoryStatus.ts`
- Neue Tests:
  - `frontend/src/lib/browserStorage.test.ts`
  - `frontend/src/lib/clipboard.test.ts`
  - `e2e/tests/sales.spec.ts`
- Neue Coverage-Governance:
  - `docs/route-test-coverage-matrix-2026-02-17.md`

### Trade-offs
- Mehr Guardrails bedeuten strengere Fehlerschwellen (frueheres Fail-Fast), dafuer weniger spaete Produktionsueberraschungen.
- Zuschnitt in kleinen Schritten reduziert Refactor-Risiko, erreicht aber noch keine vollstaendige Zerlegung aller Grossmodule in einem Zug.

## 2026-02-17 - Phase 1 Umsetzung: Drift-Reconciliation + Teststabilitaet + Runtime-Paritaet

### Ausgangslage
- Nach Phase 0 bleiben zentrale Stabilisierungsthemen offen: noisy Schema-Drift-Signale, flaky Frontend-Tests und lokale Runtime-Abweichungen zu CI.

### Business-Entscheidungen
- Fokus auf **Release-Vertrauen**:
  1) Drift-Gate wieder aussagekraeftig machen
  2) Frontend-Testsignal stabilisieren
  3) lokale Toolchain auf CI-Versionen ausrichten
- Produktionshygiene wird schrittweise gehaertet (deterministischere Container-Starts, dev-spezifische Reload-Logik explizit opt-in).

### Technische Entscheidungen
- Modell-Definitionen werden auf bestehende Migrationsrealitaet abgeglichen (JSONB + explizite Indexe/Partial-Indexe), damit `check_schema_drift.py` wieder als Gate nutzbar ist.
- Vitest-Lauf wird deterministischer konfiguriert (mehr Zeitbudget, Single-Fork), um Timeout-bedingte Flakes zu reduzieren.
- Runtime-Pinning via Version-Files (`.nvmrc`, `.python-version`) und Dokumentation.

### Trade-offs
- Testlaeufe werden durch konservativere Runner-Einstellungen etwas langsamer, liefern dafuer stabilere Go/No-Go-Signale.
- Striktere Runtime-Pins reduzieren implizite Flexibilitaet, vermeiden aber environment-spezifische Fehlerbilder.

## 2026-02-17 - Phase 0 Umsetzung: Migration Bootstrap + Startup Entkopplung + Deep Health

### Ausgangslage
- Der Standard-Startup (`alembic upgrade head && app start`) ist auf Legacy-Schemas nicht robust und fuehrt in Restart-Loops.
- Ops-Health deckt bisher keine DB-/Migrationslage ab.

### Business-Entscheidungen
- Verfuegbarkeit hat Prioritaet vor Komfort:
  - Migration wird als expliziter Schritt vor App-Start ausgefuehrt.
  - Legacy-Bootstrap wird nur mit explizitem Operator-Opt-in erlaubt.
- Health soll Deployment-Risiken sichtbar machen (nicht nur Prozess lebt / lebt nicht).

### Technische Entscheidungen
- Neue Bootstrap-Migrationsroutine mit Guardrails:
  - erkennt `alembic_version`-Fehlen bei nicht-leerem Schema
  - erfordert explizite Freigabe fuer `stamp`
  - fuehrt danach immer `upgrade head` aus
- Compose wird um einen dedizierten Migrations-Service erweitert; Backend startet erst nach erfolgreichem Migrationslauf.
- Neuer `/healthz/deep` liefert DB- und Migrationsstatus fuer Ops-Gating.

### Trade-offs
- Setup wird etwas komplexer (zusaetzlicher Migrations-Container), reduziert dafuer Ausfallrisiko und unklare Startzustandsfehler deutlich.

## 2026-02-17 - End-to-End Tech Review: Production-Continuity Priorisierung

### Ausgangslage
- Repo und Feature-Scope sind in kurzer Zeit stark gewachsen; operative Risiken lagen vor allem in Migration/Runtime-Drift, Teststabilitaet und steigender Modulkomplexitaet.
- Der aktuelle Compose-Startup scheitert in einem Legacy-DB-Zustand (fehlende `alembic_version` bei vorhandenen Tabellen) reproduzierbar mit Backend-Restart-Loop.

### Business-Entscheidungen
- Reihenfolge wurde explizit auf **Kontinuitaet vor Feature-Tempo** gesetzt:
  1) Backend-Verfuegbarkeit + sichere Migrations-Bootstrap-Strategie
  2) belastbare CI-Signale (Schema-Drift + Frontend-Teststabilitaet)
  3) erst danach strukturelle Refactors/Modularisierung.
- Risiko-orientierte Ausgabe wurde als Standard festgelegt (P0-P3 mit Impact/Likelihood, statt unpriorisierter Longlist), damit Entscheidungen schneller in Releases umgesetzt werden.

### Technische Entscheidungen
- Frisches DB-Szenario und Legacy-Szenario wurden getrennt verifiziert:
  - `alembic upgrade head` funktioniert auf leerer DB.
  - Legacy-DB zeigt starke Drift und Enum-Invariant-Verletzung.
- Als technische Leitplanken wurden priorisiert:
  - explizite Migration-Preflight/Bootstrap-Schnittstelle
  - Migration-Status in Ops-Health
  - Runtime-Paritaet lokal vs CI (Python/Node)
  - Deduplizierung wiederholter Frontend-Helfer und schrittweise Entzerrung grosser Dateien.

### Trade-offs
- Kurzfristig zusaetzlicher Aufwand fuer Betriebsstabilitaet und Testhygiene reduziert kurzfristigen Feature-Durchsatz.
- Mittel-/langfristig sinkt dadurch das Risiko fuer Ausfaelle, regressionsgetriebene Hotfixes und unklare Release-Go/No-Go-Entscheidungen.

## 2026-02-17 - Sourcing Radar v1.1: Multi-Platform (eBay.de), Search Agents, Bidbag-Handoff

### Ausgangslage
- Sourcing laeuft aktuell als globaler Kleinanzeigen-Run mit zentralen Keywords.
- Es fehlt ein operatives Agent-Modell (mehrere Suchstrategien mit eigener Frequenz/Plattform).
- Fuer eBay Auktionen existiert kein automatisierter Ceiling-Preis und kein strukturierter Handoff in den Sniping-Flow.

### Business-Entscheidungen
- Scope v1.1:
  - zweite Plattform `EBAY_DE` (Auktionen, ending soon)
  - Search Agents als First-Class-Konfiguration (pro Agent: Keywords, Plattformen, Intervall)
  - Bidbag-Handoff bewusst manuell ueber Deep-Link/Payload (kein API-Coupling)
- Max Purchase Price wird aus bestehender Bewertungslogik (Revenue/ROI/Profit Floors) abgeleitet, nicht statisch.
- Detail-Enrichment bleibt selektiv (Top-Kandidaten), um Crawl-Breite nicht zu verlieren.

### Technische Entscheidungen
- Schema-Erweiterung:
  - neue Agent-Tabellen (`sourcing_agents`, `sourcing_agent_queries`)
  - Provenance-FKs auf Runs/Items
  - Auktions- und Bidbag-Felder auf `sourcing_items`
  - `sourcing_platform` erweitert um `EBAY_DE` (bestehende Werte bleiben erhalten)
- Orchestrierung:
  - Scheduler wird agent-getrieben (`next_run_at` / `interval_seconds`)
  - bestehende globale Settings (`search_terms`, `scrape_interval_seconds`) bleiben als Fallback kompatibel
- Scraper:
  - `POST /scrape` und `POST /listing-detail` erhalten `platform=ebay_de`
  - eBay-Extraktion ueber agent-browser, keine API-Integration

### Trade-offs
- Kein automatisches Win/Loss-Outcome-Tracking in v1.1 (bewusste Entkopplung fuer schnelleres Time-to-Value).
- Bidbag wird nicht direkt vom Backend gesteuert; dadurch weniger Risiko bei Drittanbieter-Aenderungen, aber manuelle Ausfuehrung bleibt erforderlich.

## 2026-02-17 - Sourcing Radar: Detail-Enrichment fuer Entscheidungsqualitaet + normalisiertes `posted_at`

### Ausgangslage
- Search-Page-Scraping lieferte zwar stabile Basisdaten, aber fuer echte Einkaufsentscheidungen fehlten zentrale Felder (vollstaendige Beschreibung, Seller-Infos, Bildanzahl/URLs, View-Count).
- Der Zeitstempel lag bisher nur als Freitext (`Heute, 07:53`, `Gestern, ...`) vor und war nicht robust sortier-/filterbar.

### Business-Entscheidungen
- Detail-Scraping wird gezielt nur fuer chancenreiche Listings ausgefuehrt (`READY` plus near-READY), um Signalqualitaet zu erhoehen ohne Crawl-Latenz unnoetig zu explodieren.
- Das Ergebnis bleibt "search-first, detail-second": schnelle Breite zuerst, danach Tiefenanreicherung fuer kaufrelevante Kandidaten.
- `posted_at` wird als normalisierte UTC-Zeit persistiert und in API/UI verfuegbar gemacht.

### Technische Entscheidungen
- Neuer Scraper-Endpoint `/listing-detail` fuer Kleinanzeigen-Detailseiten inkl. Agent-Browser-Extraktion und HTTP-Fallback.
- Backend fuehrt nach der Analyse eine Enrichment-Pipeline fuer Kandidaten aus und merged Detailfelder in `raw_data` (ohne die bestehende Match-Logik zu duplizieren).
- Neue DB-Spalte `sourcing_items.posted_at` (+ Index) und Parser fuer Kleinanzeigen-Formate:
  - `Heute, HH:MM`
  - `Gestern, HH:MM`
  - `dd.mm.yyyy` (optional mit Uhrzeit)
- API- und Frontend-DTOs zeigen `posted_at` explizit, damit Sourcing-Operatoren nach Angebotsalter priorisieren koennen.

### Trade-offs
- Detail-Enrichment ist bewusst opportunistisch (best-effort) und darf Runs nicht hart fehlschlagen lassen.
- Bei Textdaten ohne Uhrzeit wird ein Tageszeit-Default genutzt; das ist fuer Ranking ausreichend, aber nicht sekundengenau.

## 2026-02-16 - Per-Item Target Pricing + Recommendation Engine

### Ausgangslage
- Dashboard-Sell-Value basiert bisher ausschliesslich auf Amazon-Marktpreisen; Items ohne ASIN oder ohne Preisdaten werden als "unbepreist" ignoriert.
- Es gibt keinen operativen Weg, pro Inventar-Einheit einen eigenen Zielpreis zu setzen (z.B. fuer Positionen ohne Amazon-Match oder bei gewuenschter Abweichung).
- Bulk-Operationen fuer Pricing fehlen komplett.

### Business-Entscheidungen
- Speichergranularitaet: **pro Inventar-Item**, nicht pro Master-Produkt.
- Manueller Preis hat Vorrang (`MANUAL` wins when set); ansonsten automatische Empfehlung.
- Empfehlungsstrategie: **Margin First** — Amazon-Anker wenn vorhanden, ansonsten Cost-Floor.
- Margin-Floor: `max(20% Netto-Marge, 5 EUR)` als Untergrenze.
- Preiseinheit: Brutto-Listungspreis (EUR Cent).
- UI-Scope (v1): Editing/Empfehlungs-UX nur in Inventory; Dashboard zeigt Transparenz-Zaehler.
- Bulk-Ops: erweiterte Filterbedingungen (Condition + BSR + Offers + ASIN), Preview-first + einmaliges Apply; keine persistenten Regeln.

### Technische Entscheidungen
- Neue DB-Spalten `target_price_mode` (String, default `AUTO`) und `manual_target_sell_price_cents` (Integer, nullable) auf `inventory_items`.
- Neuer deterministischer Engine-Service (`target_pricing.py`): Kostenbasis → Condition-aware Amazon-Anker → Marktsignal-Adjustierung (Rank/Offers/Condition) → Floor-Berechnung via Fee-Profil-Inversion → Empfehlung = max(adjusted, floor), gerundet auf 0.10 EUR.
- Bestehende `_market_price_for_condition_cents` + `_fba_payout_cents` aus `reports.py` werden in den neuen Service extrahiert (shared, keine Duplikation).
- Dashboard-Sell-Value/Margins basieren neu auf **effective target price** statt rohem Amazon-Preis; Transparenz-Zaehler (manual/auto/unpriced).
- Bulk Preview/Apply als POST-Endpoints, Non-Persistent, mit Audit-Logging.

### Schwellenwerte
- `TARGET_PRICING_MARGIN_FLOOR_BP=2000` (20% Netto-Marge)
- `TARGET_PRICING_MARGIN_FLOOR_MIN_CENTS=500` (5 EUR Minimum)
- `TARGET_PRICING_BSR_STRONG_MAX=10000` / `BSR_WEAK_MIN=80000`
- `TARGET_PRICING_OFFERS_LOW_MAX=2` / `OFFERS_HIGH_MIN=12`

### Trade-offs
- Scope bewusst Inventory-first; Master-Products-Seite bleibt Intelligence-only.
- Bulk-Regeln sind One-Time-Apply (keine gespeicherten Presets).
- Waehrung bleibt EUR; alle Preise in Cent.

## 2026-02-16 - Marketplace: Manueller Match-Override fuer Stage-Lines

### Ausgangslage
- Der CSV-Import liefert bereits hohe Auto-Match-Quote ueber `IT-...` und fallback `MP-...`.
- Fuer die verbleibenden `NEEDS_ATTENTION`-Faelle fehlte ein gezielter Korrektur-Flow direkt im Staging.

### Business-Entscheidungen
- Kein Vollabbruch fuer einzelne Ausreisser: Nutzer sollen wenige problematische Lines manuell auf konkrete Einheiten mappen koennen.
- Override bleibt streng validiert (nur verkaeufliche, noch unverbrauchte Einheiten), damit die Buchhaltungs- und Bestandswahrheit erhalten bleibt.

### Technische Entscheidungen
- Neuer API-Flow fuer Line-Override im Marketplace-Staging (line -> `inventory_item_id`).
- Nach Override wird der Order-Status deterministisch neu berechnet:
  - alle Lines gematcht -> `READY`
  - sonst `NEEDS_ATTENTION`
- UI im `/marketplace` Review erhaelt pro problematischer Line eine direkte Override-Aktion inkl. Inventory-Suche (`IT-...` Copy/Search-first).

### Trade-offs
- Der erste Schritt setzt auf bewusst explizite manuelle Auswahl (kein "auto rematch all"), um Fehlzuordnungen zu minimieren.
- Fuer groessere Restmengen kann spaeter ein Bulk-Override folgen.

## 2026-02-15 - Dashboard: Monthly Accounting Intelligence (Cashflow + Accrual)

### Ausgangslage
- Das Dashboard zeigt bereits starke operative Kennzahlen (Sales, Lager, Amazon), aber keine kompakte Monats-Sicht fuer klassische Accounting-Fragen wie "Einnahmen vs. Ausgaben" oder "Cash Runway".
- Nutzer brauchen einen schnellen Monatsueberblick ohne eine zusaetzliche, ueberladene Reporting-Seite.

### Business-Entscheidungen
- Neue Sektion direkt im bestehenden Dashboard statt neuer Top-Level-Seite.
- Zeitraum fix auf die letzten 6 Kalendermonate (inkl. aktuellem Monat), damit Trends sichtbar bleiben und die Karte kompakt bleibt.
- Zwei Perspektiven parallel:
  - Cashflow (ledger-basiert)
  - Operating Accrual View (Income vs. COGS + OpEx + Corrections)
- Drilldown ist standardmaessig eingeklappt, um Informationsdichte niedrig zu halten.

### Technische Entscheidungen
- `GET /reports/company-dashboard` wird um ein neues Objekt `accounting` erweitert (kein neuer Endpoint).
- Monatsaggregation erfolgt als feste Kalender-Buckets (zero-filled), damit fehlende Aktivitaet explizit als `0` sichtbar bleibt.
- Cashflow basiert ausschliesslich auf `ledger_entries` (inflow > 0, outflow = abs(amount < 0)).
- Accrual basiert auf:
  - Income: finalisierte Sales-Lines (`sale_gross + shipping_allocated`)
  - Expenses: COGS (`cost_basis`) + `opex.amount_cents` + `sales_correction` refunds
- Zusatzauswertungen:
  - aktueller VAT-Snapshot via bestehendem `vat_report()`
  - Outflow-Breakdown des aktuellen Monats nach Quelle (`purchase`, `opex`, `cost_allocation`, `sales_correction`, `other`)
  - OpEx-Kategorien des aktuellen Monats

### Schwellenwerte / Insights
- Maximal 3 Insights, priorisiert:
  1. `danger`: Runway < 3 Monate
  2. `warning`: aktueller Monats-Cashflow negativ
  3. `warning`: aktuelles operatives Ergebnis negativ
  4. `info`: VAT payable > 0
  5. `info`: Refund-Anteil > 20% vom aktuellen Monats-Outflow
- Runway-Berechnung:
  - `average_cash_burn_3m = max(0, -avg(last_3_month_cash_net))`
  - `estimated_runway_months = floor(total_cash_balance / average_cash_burn_3m)` bei Burn > 0

### Trade-offs
- Corrections werden bewusst im Monat der Korrektur als Expense/Outflow erfasst (keine Rueckverteilung auf Originalverkaufsmonat), damit Cash- und VAT-Naehe fuer operative Steuerung erhalten bleibt.
- Mileage bleibt vorerst ausserhalb der Accounting-Karte, da keine Ledger-Buchung vorliegt.

## 2026-02-15 - Marketplace (Amazon/eBay): CSV Import + SKU-basiertes Auto-Matching + Payout-Cash

### Ausgangslage
- Amazon/eBay Sales werden heute operativ ausserhalb des ERP ausgefuehrt; das ERP bildet v.a. Inventar/Steuer/Belege ab.
- Fuer die operative Steuerung (Cash-Balance/Runway) ist eine Cash-Buchung zum Order-Datum bei Marktplatzverkaeufen irrefuehrend, weil Auszahlungen gebuendelt und zeitversetzt erfolgen.

### Business-Entscheidungen
- Daten-Ingest zuerst ueber robuste CSV-Imports (kein API-Key-/Rate-Limit-Risiko im MVP).
- Matching auf Inventar-Einheit wird automatisiert ueber eine eindeutige, menschlich nutzbare Artikelnummer pro Einheit (`IT-...`), die im Marktplatz-Export als SKU auftaucht.
- Marktplatz-Sales werden im ERP als finalisierte Sales Orders abgebildet (historische Wahrheit), PDFs bleiben manuell.
- Cash fuer Marktplatz-Sales/Returns wird erst bei Auszahlung gebucht (Payout/Settlement), nicht bei Order-Finalize.

### Technische Entscheidungen
- Neues Feld `InventoryItem.item_code` (unique, nicht-null) und Suche/Copy in der UI, damit `IT-...` operativ schnell nutzbar ist.
- Marketplace-Import erfolgt als Staging:
  - Orders + Lines werden persistiert, auto-gematcht und als `READY/NEEDS_ATTENTION/APPLIED` markiert.
  - Matching-Regeln sind deterministisch:
    - `IT-...` -> exakte Einheit
    - fallback `MP-...` -> FIFO-Allocation aus sellable Stock (`FBA_WAREHOUSE` vor `AVAILABLE`)
- Neue Cash-Policy pro Sales Order (`cash_recognition`):
  - `AT_FINALIZE` (bisheriges Verhalten) vs. `AT_PAYOUT` (Marktplatz)
  - Sales/Corrections unter `AT_PAYOUT` erzeugen keine `ledger_entries`; Payout-Import erzeugt Bank-Ledger-Eintrag.

### Risiken / Trade-offs
- Auto-Matching setzt disziplinierte Pflege der SKU im Marktplatz voraus; ohne SKU steigt der manuelle Aufwand drastisch.
- FIFO-Allocation bei `MP-...` ist deterministisch, kann aber in Edge-Cases (Mehrfachbestand) nicht die reale Einheit spiegeln; `IT-...` bleibt der Preferred Path.

## 2026-02-15 - Frontend: Purchases Render-Loop behoben + stabile Unit-Tests

### Ausgangslage
- `PurchasesPage` konnte waehrend des initialen Query-Loadings in eine Render-Loop geraten (hohe CPU, UI wirkt "eingefroren").
- `vitest run` war dadurch flaky bzw. konnte haengen, insbesondere in `src/pages/Purchases.test.tsx`.

### Business-Impact
- Potenzieller "Freeze" im Einkaufs-Modul genau in der Phase, in der Nutzer Daten eingeben wollen.
- Unzuverlaessige Tests bremsen Entwicklung und machen Releases riskanter.

### Technische Entscheidungen
- `purchaseRows` wird aus `list.data` per `useMemo` abgeleitet, um waehrend `undefined` nicht pro Render ein neues `[]` zu erzeugen (stabilere Effect-Dependencies).
- `Purchases.test.tsx` mockt `/mileage` und die Map-Libraries (`leaflet`/`react-leaflet`), da der Test nur den Formular-Flow validiert und Map-Rendering in jsdom nicht relevant ist.

## 2026-02-12 - PAIV: Private Sacheinlagen als eigener Einkaufstyp (cash-neutral)

### Ausgangslage
- Der bestehende Einkaufsflow deckt externe Beschaffung (`PRIVATE_DIFF`, `COMMERCIAL_REGULAR`) ab, nicht jedoch die interne Ueberfuehrung privater Assets ins Betriebsvermoegen.
- Fuer steuerlich belastbare Einlagen fehlten positionsspezifische Teilwertdaten (Marktwert, Einlagewert), Besitzdauer-Bestaetigung und strukturierte Vergleichsnachweise.
- Das bestehende Ledger ist cash-orientiert; private Sacheinlagen duerfen die Cash-Balance nicht verfaelschen.

### Business-Entscheidungen
- Neuer Einkaufstyp `PRIVATE_EQUITY` innerhalb des bestehenden Purchases-Moduls (kein separates Modul).
- PAIV bleibt cash-neutral: kein Cash-Ledger-Eintrag fuer diese Einkaeufe.
- Eigenbeleg-PDF bleibt ein manueller Schritt (Button), bekommt aber eigene Nummernserie `PAIV-YYYY-XXXXXX`.
- Nachweis-Compliance ist warnend, nicht blockierend:
  - pro Position Hinweis bei `< 3` Vergleichsnachweisen (`MARKET_COMP`)
  - pro Position Hinweis bei fehlender 12-Monats-Bestaetigung
- Kein Signaturfeld im PAIV-PDF.

### Technische Entscheidungen
- Enums erweitert: `PurchaseKind.PRIVATE_EQUITY`, `PaymentSource.PRIVATE_EQUITY`, `DocumentType.PRIVATE_EQUITY_NOTE`.
- `purchase_lines` erweitert um PAIV-Felder:
  - `market_value_cents`
  - `held_privately_over_12_months`
  - `valuation_reason`
- `purchase_attachments` erweitert um optionales `purchase_line_id`, damit Vergleichsnachweise positionsgenau referenziert werden.
- Attachment-Typ `MARKET_COMP` eingefuehrt; bei diesem Typ ist in der API eine Position-Zuordnung verpflichtend.
- Auto-Vorschlag Einlagewert: Wenn bei PAIV kein `purchase_price_cents` gesetzt ist, wird serverseitig `floor(market_value_cents * 0.85)` verwendet.
- Month-Close ZIP bekommt zusaetzlich `csv/private_equity_bookings.csv` mit Soll/Haben-Sicht:
  - Soll: `Wareneingang 0%` bei Kleinunternehmer, sonst `Wareneingang 19%`
  - Haben: `Privateinlagen`

### Risiken / Trade-offs
- `payment_source` bleibt aus Kompatibilitaetsgruenden technisch belegt (`PRIVATE_EQUITY`), obwohl kein Cashflow gebucht wird.
- Warnungen statt Hard-Block erhoehen Flexibilitaet, verlangen aber disziplinierte Nachpflege bei unvollstaendigen Nachweisen.
- Positionszuordnung fuer Nachweise steigert Datenqualitaet, macht den Upload-Flow im Frontend komplexer.

## 2026-02-12 - PDF-Dokumente: visuelle Angleichung an das neue Frontend-Design

### Ausgangslage
- Die UI wurde kuerzlich auf ein neues visuelles System umgestellt (warmer Hintergrund, ruhige Karten, teal Akzent, klarere Typo-Hierarchie).
- Die generierten PDFs (Rechnung, Rechnungskorrektur, Gutschrift) nutzen noch den alten neutral-blauen Stil und wirken dadurch wie ein anderes Produkt.

### Business-Entscheidungen
- PDFs sollen den gleichen Markenauftritt wie die App transportieren, damit Kunden- und Pruefbelege konsistent wahrgenommen werden.
- Lesbarkeit und formale Eindeutigkeit bleiben priorisiert; Design darf den Belegcharakter nicht schwaechen.

### Technische Entscheidungen
- Gemeinsame PDF-Basisstile (`base.css`) werden auf dasselbe Designsystem wie das Frontend gehoben (Farbtokens, Panel-/Tabellenstil, Typo-Kontrast).
- `sales_correction.html` wird strukturell an Invoice/Gutschrift angeglichen (Letterhead, Meta-Block, Subject/Subline, einheitlicher Totals-Bereich).
- Optionales Firmenlogo wird fuer Rechnung und Rechnungskorrektur ebenfalls im Letterhead unterstuetzt.

### Risiken / Trade-offs
- WeasyPrint-Font-Verfuegbarkeit kann je Deployment variieren; deshalb bleibt ein robuster Fallback-Stack aktiv.
- Staerkere visuelle Flaechen (Panels/Farbtoene) muessen druckfreundlich bleiben; Farben werden bewusst gedeckt gewaehlt.

## 2026-02-12 - PDF-Druckbild: weisser Seitenhintergrund statt globaler Flaechentoene

### Ausgangslage
- Nach der Design-Angleichung wirkte die gesamte PDF-Seite durch warme Hintergrundtoene zu stark eingefaerbt.

### Business-Entscheidung
- Die Grundflaeche von PDF-Belegen bleibt rein weiss fuer maximale Drucktauglichkeit und formale Anmutung.
- Hintergrundfarben bleiben nur fuer klar markierte Highlight-Elemente (z. B. Tags, Tabellenkopf, Summen-Highlights) erlaubt.

### Technische Entscheidung
- `--pdf-bg` und `--pdf-surface` werden auf Weiss gesetzt; Zebra-Hintergruende in Positionstabellen entfallen.

## 2026-02-12 - Einkaufs-Create stabilisiert: Async ORM Lazy-Load Crash entfernt

### Ausgangslage
- Beim Speichern neuer Einkaeufe kam es serverseitig zu einem Async ORM Fehler (`MissingGreenlet`) waehrend der Create-Transaktion.
- Im Frontend erschien dies als fehlgeschlagene Netzwerk-Anfrage beim Save.

### Technische Entscheidung
- In `create_purchase()` wird fuer Audit-Daten nicht mehr auf lazy geladene Relationships (`purchase.lines`) zugegriffen.
- Stattdessen werden die bereits im Create-Flow erzeugten `PurchaseLine`-Objekte aus dem lokalen `created_line_items`-Kontext verwendet.

## 2026-02-12 - CI-Haertung: stabilere Playwright-Signale + E2E fuer Einkauf-Create

### Ausgangslage
- Die CI schlug gleichzeitig in Lint und im Playwright-Smoke fehl.
- Der Smoke-Test nutzte einen zu breiten Text-Locator (`/bersicht/i`) und wurde durch Strict-Mode mehrdeutig.
- Die kuerzliche `Einkauf`-Save-Regressionsklasse (Netzwerkfehler durch Backend-Crash) war im E2E-Set nicht abgedeckt.

### Business-Entscheidung
- CI muss bei UI-/Backend-Regressionen frueh und mit klaren Fehlersignalen ausfallen, nicht an fragilen Selektoren.
- Kaufkritische Flows (Login + Einkauf speichern) erhalten explizite End-to-End-Abdeckung.

### Technische Entscheidungen
- Smoke-Assertion wird auf einen eindeutigen Dashboard-Navigationszustand (`aria-current`) umgestellt.
- Neuer Playwright-Test erstellt einen Master-Artikel via API und speichert anschliessend einen Einkauf ueber die UI; der Test validiert explizit den erfolgreichen `POST /api/v1/purchases` Response.
- Ruff-Breaker (ungenutzte Variablen/Imports) werden bereinigt, um wieder gruene Lint-Laeufe sicherzustellen.

## 2026-02-12 - Einkaeufe: Fahrten-Block mit Fahrtenbuch-Paritaet + Cash-ohne-Fahrt Hinweis

### Ausgangslage
- Der Inline-Fahrtenblock im Einkaufsdialog war funktional deutlich abgespeckt (nur manuelle km-/Ort-Felder), waehrend das Fahrtenbuch bereits OSM-Routenberechnung inkl. Kartenvorschau und Einweg/Rueckweg-Modus bietet.
- In der Einkaufsliste fehlte ein schneller Sichtbarkeits-Hinweis fuer Bargeld-Einkaeufe ohne verknuepfte Fahrt.

### Business-Entscheidungen
- Der Einkaufsdialog soll fuer Fahrten die gleiche operative Qualitaet wie das Fahrtenbuch liefern, damit Nutzer den Kontext nicht wechseln muessen.
- Bargeld-Einkaeufe ohne Fahrt werden als schneller Hinweis markiert, um potenzielle steuerliche Dokumentationsluecken frueh sichtbar zu machen.

### Technische Entscheidungen
- Inline-Fahrtenblock in `Purchases` uebernimmt OSM-Routenflow (Geocoding + OSRM-Route, Kartenvorschau, Einweg/Hin-und-Rueckfahrt Umschalter, km-Uebernahme).
- `PurchaseOut` exponiert `primary_mileage_log_id`, damit Frontend den Hinweis ohne N+1-Abfragen berechnen kann.
- Liste zeigt ein klares Warning-Badge fuer `payment_source == CASH` und fehlende `primary_mileage_log_id`.
- E2E-Login-Helper loescht gespeicherte Basic-Auth-Credentials deterministisch vor jedem Loginlauf, um flaky Tests durch alte Browser-Sessiondaten zu vermeiden.

## 2026-02-12 - Bugfix: Cash-ohne-Fahrt Hinweis beruecksichtigt verknuepfte Mileage-Logs

### Ausgangslage
- Der Badge "Bar ohne Fahrt" nutzte nur `primary_mileage_log_id`.
- Fahrten, die im Fahrtenbuch ueber `purchase_ids` verknuepft wurden (ohne Primary-Link), wurden dadurch nicht erkannt.

### Entscheidung
- Frontend berechnet den Hinweis auf Basis beider Signale:
  - `primary_mileage_log_id` (direkter Link)
  - verknuepfte Kauf-IDs aus `/mileage` (`purchase_ids`)
- Damit werden bestehende Altdaten und Fahrtenbuch-Workflows konsistent abgedeckt.

## 2026-02-12 - Loeschfunktion fuer Einkaeufe (Produktiv-Bereinigung)

### Ausgangslage
- In Produktion wurden Test-Einkaeufe angelegt; bisher existiert keine dedizierte Loeschfunktion fuer Einkaeufe.
- Manuelle DB-Eingriffe waeren fehleranfaellig und audit-technisch unguenstig.

### Business-Entscheidung
- Einkaeufe sollen direkt in der UI loeschbar sein, damit fehlerhafte/Test-Daten schnell entfernt werden koennen.
- Loeschen bleibt fachlich eingeschraenkt: nur wenn die zugehoerigen Bestandspositionen noch unverbraucht sind.

### Technische Entscheidung
- Neuer Backend-Service + API `DELETE /purchases/{id}` mit Konsistenzpruefungen:
  - nur moeglich, wenn verknuepfte Inventory-Items `AVAILABLE` und nicht in Sales/Kostenallokationen/Bildern referenziert sind.
  - bereinigt verknuepfte Ledger- und Mileage-Links; primary Mileage-Log wird entfernt.
- Frontend erhaelt pro Einkauf einen klaren "Loeschen"-Action-Button mit Confirm-Dialog und Query-Invalidation.

## 2026-02-12 - UI-Update: Einkauf-Loeschen nur ueber Mehrfachauswahl

### Ausgangslage
- Ein direkter roter "Loeschen"-Button pro Zeile wurde als zu dominant wahrgenommen.

### Entscheidung
- Loeschen wird auf einen ruhigeren Batch-Flow umgestellt:
  - Auswahl per Checkbox (Zeile/Karte, plus "Seite auswaehlen").
  - Eine zentrale Aktion "Ausgewaehlte loeschen" mit Confirm.
- Dadurch sinkt das Risiko von versehentlichen Einzel-Loeschungen und die Oberflaeche bleibt ruhiger.

## 2026-02-12 - Amazon-Scraper Zuverlaessigkeit: transienten Netzwerkfehler abfedern

### Ausgangslage
- Operativ zeigte der Scraper unregelmaessige Ausfaelle trotz laufendem Scheduler-Lock.
- Fehlerbild in den Runs war primaer transient: `ConnectError` und einzelne HTTP `500` vom Upstream-Scraper-Service.

### Business-Entscheidung
- Einzelne kurzfristige Netz-/Upstream-Fehler sollen nicht sofort als fachlicher Scrape-Fehlschlag persistiert werden.
- 429/BUSY bleibt weiterhin ein explizites Signal fuer Laststeuerung und wird nicht lokal "wegretried".

### Technische Entscheidungen
- `fetch_scraper_json()` bekommt gezielte Retries (3 Versuche) fuer:
  - Transportfehler (`httpx.RequestError`)
  - retrybare HTTP-Statuscodes (`408`, `425`, `500`, `502`, `503`, `504`)
- Backoff ist kurz und linear (`0.4s * attempt`), damit Tick-Durchsatz erhalten bleibt.
- Fuer `429` wird wie bisher sofort `ScraperBusyError` geworfen (kein lokaler Retry).
- Unit-Tests wurden fuer alle drei Faelle ergaenzt:
  - Transportfehler -> spaeterer Erfolg
  - retrybarer 5xx -> spaeterer Erfolg
  - 429 -> Busy ohne Retry
- Bestehende Bild-Download-Tests wurden auf `tmp_path` entkoppelt, damit CI/Lokal nicht von `/data`-Rechten abhaengt.

### Beobachtung nach Check
- Status waehrend Diagnose: `enabled=true`, `total_with_asin=83`, `blocked_last=0`; `stale` sank im Live-Lauf bis auf `0`.
- Drei manuelle Trigger auf zuvor stale Produkte liefen erfolgreich durch (`ok=true`, `blocked=false`, `error=null`).

## 2026-02-12 - Amazon Intelligence im Dashboard: Sell Value (net) + kompakte Chancen

### Ausgangslage
- Amazon-Metriken (BSR, Preislevel, Offer Counts, Freshness) liegen bereits pro Produkt vor, werden aber im Dashboard kaum zur operativen Priorisierung genutzt.
- Nutzer benoetigen eine schnelle, nicht ueberladene Sicht auf den potentiellen Verkaufswert des aktuellen Bestands.

### Business-Entscheidungen
- Dashboard bleibt kompakt; keine neue Analytics-Seite im ersten Schritt.
- Primaere Kennzahl wird `Amazon Sell Value (net)` (geschaetzter FBA payout) statt Brutto-Marktpreis, weil sie naeher am erwarteten Cash-In liegt.
- Berechnungsbasis ist der gesamte In-Stock-Bestand (inkl. DRAFT/INBOUND/RESERVED/RETURNED/DISCREPANCY), damit der KPI den realen Bestand abbildet.
- Actionable Liste "Top Chancen" wird auf direkt verkaeufliche Einheiten (`AVAILABLE`, `FBA_WAREHOUSE`) begrenzt.

### Technische Entscheidungen
- `GET /reports/company-dashboard` wird um ein aggregiertes Objekt `amazon_inventory` erweitert (Totals, Coverage, Fresh/Stale/Blocked, Top-Chancen).
- Marktpreis pro Item folgt exakt der bestehenden Condition-Logik (Neu/Used-Fallbacks), damit Dashboard und Inventar konsistent sind.
- FBA payout nutzt bestehendes Fee-Profil aus Settings; Referral-Fee-Rundung erfolgt deterministisch per Integer-Half-Up.
- Top-Chancen werden auf Master-Produkt-Ebene gruppiert und nach Gesamtmarge sortiert, um doppelte Zeilen bei Mehrfachbestand zu vermeiden.
- UI zeigt zusaetzlich Offer-Kontext in der Inventar-Ansicht, aber nur als kompakte Meta-Information ohne neue komplexe Controls.

## 2026-02-17 - Per-Item Target Pricing v1: Contract-Fix + klare operative Steuerung

### Business-Intent
- Zielpreise muessen pro Inventory-Item explizit steuerbar sein, auch wenn Amazon-Daten vorhanden sind.
- Dashboard-Bewertung soll nachvollziehbar werden: manuell gesetzt vs. automatisch empfohlen vs. unbepreist.
- Bulk-Steuerung fuer viele Artikel braucht sichere Vorschau vor mutierenden Aenderungen.

### Technisches Modell
- Persistiertes Item-Preismodell bleibt `AUTO|MANUAL` mit manueller Preis-Override auf Item-Ebene.
- Empfehlung bleibt `MARGIN_FIRST`: Amazon-Anker (Condition, fallback Buybox) + Marktanpassung, sonst Kosten-Floor.
- Floor basiert auf `max(20%, 5 EUR)` Netto-Marge auf Cost-Basis und wird auf Brutto-Zielpreis invertiert.
- Bulk-API wird auf regelbasierte Filter (`condition`, `asin_state`, `bsr`, `offers`) + `preview/apply` mit expliziten Operationen vereinheitlicht.

### Schwellwerte
- Mindestmarge: `TARGET_PRICING_MARGIN_FLOOR_BP=2000` und `TARGET_PRICING_MARGIN_FLOOR_MIN_CENTS=500`.
- Angebots-Signale: low `<=2`, high `>=12`.
- BSR-Signale: strong `<=10000`, weak `>=80000`.
- Insight-/Dashboard-Transparenz bleibt erhalten: effective/manual/auto/unpriced Counter.

### Tradeoffs
- Scope bleibt Inventory-first; keine Preisbearbeitung auf Master-Produkt-Seite in dieser Iteration.
- Bulk-Regeln bleiben one-time apply (kein persisted Rule Scheduling/Preset-Management).
- Korrekturen/Refunds bleiben periodisiert im Korrekturmonat; keine nachtraegliche Reallokation.

## 2026-02-17 - Sourcing Radar v3.0: Architektur-Festlegung vor Umsetzung

### Ausgangslage
- Es gibt eine neue Produktanforderung fuer automatisiertes Sourcing auf Kleinanzeigen.
- Das ERP nutzt bereits einen monolithischen FastAPI-Backend-Stack mit bestehendem Scheduler-Lock-Pattern, zentralem Audit-Log und etablierter Purchase-Domain.
- Die PRD-Annahmen (eigene Nginx-Proxy-Schicht, separates Audit-Log, eigenes Draft-Purchase-Modell) passen nicht 1:1 zum aktuellen Repo.

### Business-Entscheidungen
- Ziel bleibt ein 4-Wochen-Pilot mit schneller Time-to-Value und kontrolliertem Operations-Risiko.
- V1-Scope wird auf Kleinanzeigen begrenzt; Matching startet konservativ (Confidence >= 80), um False Positives zu reduzieren.
- Conversion bleibt explizit nutzerbestaetigt (Prefill + Confirm), keine automatische Kaufanlage ohne Review.

### Technische Entscheidungen
- Architektur: neues `sourcing-scraper` Container-Service + bestehender ERP-Backend-Domainmodul fuer Persistenz, Matching, Valuation, API und Scheduler-Orchestrierung.
- API-Expose erfolgt unter bestehendem Prefix `/api/v1/sourcing` (kein neuer Reverse-Proxy-Layer im Repo).
- Zentrales `audit_logs` bleibt Single Source of Truth; kein zweites Sourcing-spezifisches Audit-Table.
- Sourcing-Status-Enum enthaelt zusaetzlich `ERROR`, damit technische Fehler explizit modelliert werden.
- `sourcing_settings` bekommt `value_json`, damit `search_terms` und weitere strukturierte Settings robust gespeichert werden.
- Conversion nutzt bestehende Purchase-Domain (`PRIVATE_DIFF`) und wiederverwendet etablierte Fee-/Payout-Logik aus `target_pricing`.
- Scheduler bleibt im Backend (Lock/Backoff konsistent zum Amazon-Scheduler); Scraper-Service liefert normalisierte Listings ohne eigene Scheduling-Verantwortung.

### Tradeoffs
- Agent-browser Sidecar wird vorbereitet, aber fachliche Entscheidungen bleiben im ERP-Backend, um doppelte Business-Logik zu vermeiden.
- Pilot-Fast Modus akzeptiert rechtliches Restrisiko; technische Gegenmassnahmen: konservatives Rate-Limit, Jitter, Blocked-State Monitoring, Kill-Switch via Env-Flag.

## 2026-02-17 - Sourcing Radar v3.0: UI-Integrationsentscheidungen vor Frontend-Umsetzung

### Ausgangslage
- Backend-API fuer Sourcing wird unter `/api/v1/sourcing` bereitgestellt.
- Bestehende Navigation ist in Module gruppiert (`Stammdaten`, `Belege`, `Finanzen`) und nutzt Lazy-Loaded Routes.

### Entscheidungen
- Sourcing wird als eigener Beleg-Workflow mit drei Routen umgesetzt:
  - `/sourcing` (Feed + Trigger)
  - `/sourcing/:id` (Detail + Match-Review + Conversion)
  - `/sourcing/settings` (Threshold-/Search-Term-Verwaltung)
- Navigationseintrag wird in `Belege` aufgenommen, um den Einkauf-nahen Entscheidungsfluss beizubehalten.
- Conversion-Flow bleibt explizit zweistufig: Preview laden, danach bestaetigte Conversion ausloesen.

### Tradeoffs
- V1-UI priorisiert operative Geschwindigkeit und Transparenz gegenueber Design-Feinschliff.
- Live-Kalkulation erfolgt serverseitig via Match-Patch/Recalc, statt komplexe parallele Client-Formel im Frontend zu duplizieren.

## 2026-02-17 - Amazon-Scraper Stabilitaet: Retry-Amplifikation im ERP reduziert

### Ausgangslage
- Auf Produktion war der externe Scraper zeitweise instabil (`503`), waehrend der ERP-Scheduler weiter due ASINs abarbeitet.
- Mit 3 Fetch-Versuchen pro Request entstand Last-Amplifikation auf einen bereits degradierten Scraper.

### Entscheidung
- Fetch-Retries im ERP werden konfigurierbar gemacht und standardmaessig auf `2` reduziert.
- Ziel: weniger Druck auf den Scraper in Störphasen, ohne die Robustheit bei transienten Einzel-Fehlern ganz zu verlieren.

### Technische Umsetzung
- Neues Setting `AMAZON_SCRAPER_FETCH_MAX_ATTEMPTS` (Default `2`) in `Settings`.
- `fetch_scraper_json()` nutzt das Setting statt eines harten Konstantenwerts.
- `.env.example` dokumentiert den neuen Schalter.

### Tradeoff
- Bei kurzen Upstream-Flaps kann ein Fail minimal frueher persistiert werden als mit 3 Versuchen.
- Dafuer sinkt das Risiko, dass wiederholte Fehler den Upstream dauerhaft in einen schlechten Zustand treiben.

## 2026-02-17 - Hotfix: Sourcing discard endpoint startup assertion

### Ausgangslage
- Nach Deploy schlug der Backend-Startup fehl (FastAPI Assertion: `Status code 204 must not have a response body`) am Endpoint `POST /sourcing/items/{item_id}/discard`.

### Entscheidung
- Minimaler Runtime-Hotfix, um den Service sofort wieder stabil zu booten.

### Technische Umsetzung
- Endpoint-Status von `204` auf `200` gesetzt.
- Fachlogik bleibt unveraendert (`discard_item` wird wie bisher ausgefuehrt).

### Tradeoff
- Semantisch ist `204` fuer "no content" strikter, aber `200` ist hier operativ sicherer mit der aktuellen FastAPI-Route-Konfiguration.

## 2026-02-17 - Sourcing Radar Hotfix: Live Kleinanzeigen Parsing + agent-browser Runtime

### Ausgangslage
- Live Validierung zeigte 0 Listings im aktuellen Scraper, obwohl Zielseiten Ergebnisse liefern.
- Ursache 1: Such-URL war fachlich falsch (`c278` = Notebooks statt Videospiele).
- Ursache 2: Implementierung lief ohne agent-browser und damit ohne geplantes Browser-Runtime-Verhalten.

### Entscheidungen
- Suchpfad auf private Angebote normalisieren (`/s-anbieter:privat/anzeige:angebote/{term}/k0`, paginiert via `seite:n`).
- Scraper auf agent-browser Runtime umstellen (CLI-basierte Navigation + DOM-Extraktion), mit HTTP-HTML-Fallback fuer Umgebungen ohne agent-browser Binary.
- Extraktionsskript auf robuste `article.aditem[data-adid]`-Struktur mit korrekten Selektoren und normalisierten Feldern anpassen.
- E2E-Verifikation wird als Muss behandelt: Live-Scrape muss echte Listings liefern und via Backend-Run in `sourcing_items` persistiert sichtbar sein.

### Tradeoffs
- Direkte Sidecar-Nutzung per Docker-Image bleibt vorerst fragil, da aktueller Image-Pull fehlschlaegt; CLI-Runtime sichert Funktionsfaehigkeit bis ein stabiles Sidecar-Image geklaert ist.

## 2026-02-17 - Sourcing Radar Hotfix umgesetzt: agent-browser + Live-E2E Ingestion nachweisbar

### Umgesetzte Aenderungen
- Kleinanzeigen-Search-URLs korrigiert auf private Angebote (`/s-anbieter:privat/anzeige:angebote/{term}/k0`) statt falscher Kategorie-Pfade.
- Scraper-Runtime auf agent-browser CLI erweitert (`open` + `eval`) mit persistentem Profil/Session.
- DOM-Extraktion in `extract_listings.js` auf stabile `article.aditem[data-adid]`-Struktur inkl. Preis/Ort/Bild normalisiert.
- Python-Fallback-Pfad (HTTP+HTML) behalten, damit Scrapes auch ohne agent-browser-Binary nicht komplett ausfallen.
- Neue Env-Konfiguration fuer agent-browser runtime in `sourcing-scraper` + Compose/.env-Beispiel.
- Live-Integrationstest hinzugefuegt: startet echten Scraper-Prozess, zieht Live-Kleinanzeigen-Daten, fuehrt Backend-Run aus und verifiziert Persistenz in `sourcing_items`.

### Verifikation
- Live-Scrape mit agent-browser liefert aktuell >25 Listings fuer Suchterm `nintendo`.
- Backend-Run verarbeitet Live-Payload erfolgreich (Items werden in DB angelegt).
- Teststatus: `test_sourcing_flows.py` gruen, `test_sourcing_live_ingestion.py` gruen (mit `RUN_LIVE_KLEINANZEIGEN_TEST=1`).

### Offene Betriebsbeobachtung
- Compose-Image `ghcr.io/zackiles/agent-browser:latest` ist aktuell per Registry denied. Runtime bleibt deshalb robust durch CLI/Fallback-Pfad, bis Sidecar-Image verifizierbar verfuegbar ist.
- Compose-Hardening: `agent-browser` als optionales Profil markiert, damit `docker compose up -d --build` trotz zeitweiser GHCR-Denials lauffaehig bleibt.
- Folgeentscheidung (Live-Audit): Default-Pagination wird erhoeht und Listing-Metadaten (Posted-Time, Versand/Direktkauf, VB/Altpreis, Bildanzahl) werden bereits im Scrape normalisiert, da die bisherigen Snippet-Daten fuer belastbare Kaufentscheidungen zu duenn sind.
- Umsetzung (Live): Default `SOURCING_SCRAPER_MAX_PAGES_PER_TERM` auf 3 erhoeht; Listing-Rawdata erweitert um `posted_at_text`, `shipping_possible`, `direct_buy`, `price_negotiable`, `old_price_cents`, `image_count` fuer bessere Kaufentscheidung im Feed/Detail.

## 2026-02-17 - Sourcing Radar v1.1 Implementation Plan: Agent-first scheduler + eBay auction max-bid

### Business perspective
- We move from a global keyword scheduler to per-agent sourcing to support parallel buying strategies (different keywords, cadence, and platform mix).
- eBay.de auction handling needs a bounded buy decision (`max_purchase_price_cents`) before manual transfer to bidbag, so operators can execute snipes without ad-hoc spreadsheet math.
- Bidbag integration remains manual deep-link/payload in v1 to avoid external API coupling while still reducing operator friction.

### Technical decisions
- Scheduler executes due agents (`next_run_at <= now`) and runs enabled queries per agent; legacy global term interval remains fallback-compatible.
- `execute_sourcing_run` accepts provenance (`agent_id`, `agent_query_id`) and platform/options to unify manual and scheduled runs in one pipeline.
- eBay auction valuation computes max buy cap from both profit floor and ROI floor; the stricter constraint wins.
- Detail enrichment stays selective and candidate-based to keep run latency and scrape volume bounded.

### Risks / tradeoffs
- Agent-first scheduling increases run cardinality; we keep existing lock + backoff semantics to prevent overlapping loops.
- Manual bidbag handoff avoids integration risk but leaves won/lost feedback loop for a follow-up release.

## 2026-02-17 - Sourcing Radar v1.1 implemented (backend+scraper+frontend)

### Delivered
- Backend: agent CRUD/run APIs, due-agent scheduler path, multi-platform run provenance, eBay auction fields in item APIs, bidbag handoff endpoint.
- Valuation: eBay max purchase cap is persisted per item using profit+ROI constrained formula and used for READY decision on auction listings.
- Scraper contract: per-request `options.max_pages` now respected for Kleinanzeigen too (already used for eBay); platform selection remains agent-browser based.
- Frontend: new `/sourcing/agents` management page, eBay auction/headroom display in feed+detail, bidbag action in detail, settings extended with bidbag template and eBay bid buffer.

### Validation
- Backend tests: sourcing flows + new scheduler tests green.
- Frontend: typecheck/build green; targeted `SourcingAgents` test added and green.
- Existing broad frontend suite has unrelated pre-existing timeout failures in heavy pages and was not used as release gate for this feature branch.

## 2026-02-17 - Production migration hotfix: sourcing_platform enum autocommit

### Issue
- Production backend crash-looped on startup migration with PostgreSQL `UnsafeNewEnumValueUsageError` when migration `f1c6d8a9e112` added enum value `EBAY_DE` and referenced it later in the same migration transaction.

### Fix
- Migration updated to run `ALTER TYPE sourcing_platform ADD VALUE IF NOT EXISTS 'EBAY_DE'` inside `autocommit_block()` so the enum value is committed before subsequent DDL uses it.

### Operational impact
- Prevents startup migration crash-loop and allows safe rollout on existing production databases.

## 2026-02-17 - Production startup hotfix: sourcing agent delete endpoint status

### Issue
- Backend startup failed because FastAPI rejected `DELETE /sourcing/agents/{id}` configured with `status_code=204` under current route/body constraints.

### Fix
- Endpoint status changed to `200` (same pragmatic approach already used for sourcing discard route) to avoid startup assertion and keep behavior stable.

## 2026-02-17 - Transaction persistence fix for sourcing API nested writes

### Issue
- Manual agent run path showed run execution but did not persist `last_run_at/next_run_at` updates due nested transaction handling when a read had already auto-begun a transaction.

### Fix
- `_begin_tx()` now commits the outer transaction after nested block completion when session is already in transaction.
- This ensures write persistence for sourcing API flows that read then write in a single request.

## 2026-02-17 - Planned hardening: eBay empty-result degradation + conservative sourcing retention

### Objective
- Make repeated eBay zero-result runs operationally visible as degraded rather than silently completed.
- Add bounded retention to prevent long-term unbounded sourcing table growth without deleting high-value decision data.

### Implementation intent
- eBay degrade rule: mark run as degraded when zero listings repeat for a threshold streak on the same query context.
- Retention rule: prune only low-signal statuses (`LOW_VALUE`, `DISCARDED`, `ERROR`) older than configured days, with per-tick max delete cap.
- Keep defaults conservative and configurable via sourcing settings.

## 2026-02-17 - Implemented hardening: eBay degraded empty-runs + bounded retention

### Business perspective
- Repeated empty eBay runs are now operationally visible and no longer look like healthy completions.
- Sourcing table growth is now bounded by policy instead of unbounded accumulation of low-signal historical rows.

### Technical implementation
- Added sourcing settings (with migration defaults):
  - `ebay_empty_results_degraded_after_runs` (default `3`)
  - `sourcing_retention_days` (default `180`)
  - `sourcing_retention_max_delete_per_tick` (default `500`)
- `execute_sourcing_run` now marks eBay runs as `degraded` when zero listings repeat for the configured consecutive streak in the same query context.
- Once threshold is reached, subsequent zero-result eBay runs continue to be marked `degraded` until a non-empty run breaks the streak.
- Scheduler now treats `degraded` query runs as agent-level failures (`last_error_type/last_error_message`), making issues visible in agent monitoring.
- Added retention pruning in scheduler tick:
  - deletes only `LOW_VALUE`, `DISCARDED`, `ERROR`
  - only older than retention window
  - capped per tick to avoid DB load spikes.
- Frontend sourcing settings page extended with the three new controls.

### Verification
- Backend tests added for degraded streak behavior and retention pruning boundaries.
- Scheduler tests updated to assert degraded status escalation.
- Targeted backend tests green and frontend production build green.
- Production validation: pilot agent run shows `KLEINANZEIGEN=completed` and `EBAY_DE=degraded` when eBay keeps returning zero listings; scheduler now surfaces this as agent error (`RuntimeError`) for operational visibility.

## 2026-02-17 - Phase-2 Live E2E audit (Playwright) and reprioritization

### Business perspective
- Sourcing operator throughput is currently constrained less by backend scrape logic and more by review UX correctness.
- Two operator-facing risks are now priority-raising:
  - feed truncation (100 rendered vs larger totals) can hide opportunities.
  - invalid actions are offered in detail state, producing avoidable conflicts and user confusion.

### Technical findings snapshot
- Manual Playwright run validated sourcing scrape/convert/discard path in live stack.
- Feed page requests `limit=100&offset=0` only, while API returns `total`; UI does not expose pagination/load-more.
- Converted item still allows `Purchase erstellen` click; backend returns `409` (`Item already converted`) and UI does not surface a clear error.
- Image metadata exists in contracts (`primary_image_url`, `image_urls`) but is not rendered in list/detail.
- Automated E2E rerun with active local credentials passed 4/6; remaining failures are selector/timing fragility (`marketplace`, `sales`).

### Decision
- Move Phase-2 sourcing UX hardening tasks into immediate stabilization queue after current P1 blockers:
  1. pagination or infinite loading with loaded/total transparency,
  2. status-gated detail actions + explicit conflict messaging,
  3. listing image previews and no-image indicators,
  4. resilient and accessible action labels/selectors.
- Keep backend conversion/discard behavior unchanged for now; address user-facing contract in frontend first to reduce operational error rate quickly.

## 2026-02-17 - Planned implementation: sourcing UX hotfix + E2E stability fixes

### Business perspective
- Immediate goal is to reduce operator error and missed opportunities in sourcing review while restoring trust in critical E2E gates.

### Technical intent
- Sourcing UI: implement paging/loaded-total transparency, status-gated convert/discard actions with explicit error feedback, and listing image visibility.
- Accessibility/testability: add explicit labels for match decision actions.
- E2E: fix deterministic failures in marketplace (ambiguous READY locator) and sales (dialog timing/selector), then rerun suite.

### Tradeoff
- Changes prioritize low-risk frontend/test hardening without altering backend business rules for conversion/discard conflicts.

## 2026-02-17 - Implemented: sourcing UX hotfixes + marketplace apply persistence fix + E2E stabilization

### Business perspective
- Sourcing review now exposes missing listing media and full-feed progress, reducing missed-opportunity and misclassification risk.
- Marketplace apply flow had a hidden persistence defect (UI showed success but writes could be lost); fixing this restores trust in order application and E2E gates.

### Technical implementation
- Frontend sourcing list (`Sourcing.tsx`): switched to paged infinite query (`limit/offset`), added loaded-vs-total summary and explicit "Mehr laden" control, and rendered primary listing thumbnails/fallback.
- Frontend sourcing detail (`SourcingDetail.tsx`): added image gallery/fallback, status-gated convert/discard actions, explicit convert/discard error messages, and aria-labels for match confirm/reject icon buttons.
- Frontend sales dialog (`Sales.tsx`): added `htmlFor/id` bindings for buyer fields so label-based automation/accessibility works reliably.
- Backend marketplace endpoint (`marketplace.py`): `_begin_tx` now commits outer transaction after nested writes when session is already in transaction (same pattern as sourcing endpoint).
- E2E (`marketplace.spec.ts`, `helpers.ts`): removed ambiguous READY text assertion, assert apply result payload contract, and verify finalized sales order via API helper.

### Validation
- `frontend`: `npm run typecheck` and `npm run build` green.
- `backend`: `pytest -q tests/test_marketplace_order_import_apply.py` green.
- `e2e`: `npx playwright test tests/marketplace.spec.ts tests/sales.spec.ts --workers=1` green with local credentials.

## 2026-02-17 - Follow-up: E2E concurrency hardening completed

### Observation
- The two initially targeted specs (`marketplace`, `sales`) were green in isolation but still timed out under full parallel suite load due strict 60s ceiling and brittle response waits.

### Actions
- Added timeout headroom (`120s`) for heavy flow specs.
- Reworked critical waits in `marketplace`, `sales`, and `purchases` specs to use button-enabled guards, broader request capture, and poll-based UI readiness where appropriate.

### Result
- Full E2E suite (`6` specs) now passes in parallel on current local compose runtime with explicit credentials.

## 2026-02-17 - Planned UI refactor: sourcing table view + inline uninteresting action

### Business perspective
- Current sourcing card feed is hard to scan at higher volume; operators need faster compare/sort behavior and lower click-cost for dismissing low-signal items.

### Technical intent
- Replace card grid with table-first list for denser readability.
- Introduce explicit pagination with 40 items per page for predictable loading and review cadence.
- Add inline "Uninteressant" action in list rows (status-gated) so discard does not require detail navigation.

### Risk handling
- Keep existing details page and API contracts unchanged; this is a presentation/interaction-layer change with focused mutation behavior.

## 2026-02-17 - Sourcing defaults switched from Nintendo to Gamecube

### Business perspective
- Broad `nintendo` sourcing generated too much low-signal inventory and review noise.
- Narrowing to `gamecube` improves relevance and speeds operator decision cycles.

### Technical intent
- Switch application scraping defaults and UI entry defaults from `nintendo` to `gamecube`.
- Add a forward data migration to update legacy `search_terms` and agent query keywords that still contain `nintendo`.
- Keep migration idempotent for existing environments and deterministic for fresh environments.

### Risk handling
- Data migration only touches keyword fields related to sourcing filters; no destructive schema changes.
- Historical listing cleanup remains an explicit operational DB action (already executed on production) to avoid accidental data loss in non-production environments.

## 2026-02-17 - Hotfix: Sourcing pagination page-reset race

### Business perspective
- Operators could not reliably move beyond page 1 in `/sourcing`, undermining the new high-volume triage workflow.

### Technical intent
- Preserve previous page payload during page transitions and only clamp page index when concrete data exists.
- This prevents temporary `total=0` loading states from force-resetting `currentPage` back to 0.

### Risk handling
- Added/updated UI regression test to exercise pagination with async delay and assert `Seite 2 von 2` rendering.

## 2026-02-17 - Incident analysis: eBay.DE scraper returning zero listings

### Business perspective
- eBay sourcing signal collapsed to zero (`items_scraped=0`), reducing acquisition throughput and hiding auction opportunities.

### Technical diagnosis intent
- Validate whether failure is transport/captcha vs extraction/parser drift.
- Fix extraction against current eBay DE result-card markup while preserving fallback behavior.

### Risk handling
- Prioritize parser compatibility hotfix first; keep scope narrow to eBay extraction paths.
- Verify against live scrape endpoint and production run metrics before closing incident.

## 2026-02-17 - Planned manual sourcing match enablement + nav prioritization

### Business perspective
- Operators are blocked when automatic sourcing matches are empty or sparse; business still needs a manual path to convert viable listings.
- Sourcing is now core daily workflow and should be first-class in navigation, not hidden in a subsection.

### Technical intent
- Add API + UI flow to search master products and attach manual matches to a sourcing item.
- Reuse existing recalculation/conversion logic so manual matches immediately affect status/profit and purchase creation readiness.
- Move `Sourcing` to a dedicated top-level nav entry in first position and remove sourcing links from `Belege` dropdown.

### Risk handling
- Keep manual matching additive; no destructive data migrations.
- Preserve existing auto-match behavior and compatibility paths while introducing a new explicit user action.

## 2026-02-17 - Implementation kickoff: manual matching API/UI and top-level nav

### Business perspective
- Ohne automatische Treffer entsteht operativer Stillstand im Sourcing-Review; ein manueller Fallback ist unmittelbar notwendig.

### Technical plan
- Backend: Kandidaten-Suche und manuelles Match-Create als dedizierte Endpoints, inklusive sofortiger Re-Kalkulation des Items.
- Frontend: Manuelles Matching in der Detailansicht mit direkter "Als Match hinzufügen"-Aktion.
- Navigation: `Sourcing` als erstes Top-Level-Element; Einträge aus `Belege` entfernen, um die Informationsarchitektur zu vereinfachen.

### Tradeoff
- Fokus auf schnelle Wiederherstellung des Kern-Workflows mit minimal-invasiven Änderungen an bestehenden Auto-Match- und Conversion-Flows.

## 2026-02-17 - Implemented: manual sourcing matching + sourcing-first navigation

### Business perspective
- Der Sourcing-Prozess ist trotz leerer Auto-Matches wieder handlungsfähig: Operator können manuell passende Produkte anhängen und sofort weiterrechnen.
- Sourcing ist als primärer Workflow in der Navigation sichtbar und nicht mehr im Belege-Dropdown versteckt.

### Technical implementation
- Backend `sourcing` endpoints:
  - `GET /sourcing/items/{item_id}/manual-candidates` (Titel/Plattform/SKU/ASIN/EAN Suche, bestehende Matches ausgeschlossen, Amazon-Metriken beigefügt).
  - `POST /sourcing/items/{item_id}/matches/manual` (upsert auf `(item, master_product)`, Snapshot/Payout übernehmen, Recalc direkt auslösen).
- Frontend `SourcingDetail`:
  - neue Sektion "Manuelles Matching" mit Suche, Kandidatentabelle und direkter Aktion "Als Match hinzufügen".
  - Query-Invalidierung auf Detail-/Listenebene nach erfolgreichem manuellem Match.
- Frontend Topbar:
  - `Sourcing` als erstes Top-Level-Item (Desktop + Mobile).
  - Sourcing-Links aus `Belege` entfernt.

### Validation
- `pytest -q backend/tests/test_sourcing_flows.py` -> 12 passed.
- `pytest -q backend/tests/test_sourcing_flows.py -k "manual_match_candidates or create_manual_sourcing_match_upserts"` -> 2 passed.
- `frontend`: `npm run typecheck` + `npm run build` erfolgreich.

### Tradeoff
- Fokus auf schnelles Enablen des manuellen Kernpfads ohne invasive Änderungen an Auto-Matching, Conversion- oder Datenmodell-Strukturen.

## 2026-02-17 - Planned UX hardening for manual sourcing matching

### Business perspective
- Nach dem Enablement des manuellen Matchings fehlt noch direkte Nutzerführung für den nächsten Schritt (Conversion) und eindeutige Candidate-Identifikation.

### Technical intent
- Kandidatenliste um SKU erweitern, um gleichnamige Produkte besser zu unterscheiden.
- Direktes Success-Feedback nach "Als Match hinzufügen" einblenden.
- Für deaktivierte Conversion eine klare Begründung im Detail anzeigen (statt still disabled).

### Risk handling
- Nur additive API/UI-Anpassungen; keine Änderungen am Recalc-/Conversion-Domainverhalten.

## 2026-02-17 - Implemented UX hardening for manual matching

### Business outcome
- Manuelles Matching ist jetzt für Operator besser steuerbar: Kandidaten sind eindeutig identifizierbar und der Conversion-Status ist selbsterklärend.

### Technical changes
- Backend/API:
  - Manual-Candidates enthalten jetzt `sku` für eindeutige Identifikation.
- Frontend/Sourcing Detail:
  - Success-Feedback nach `Als Match hinzufügen`.
  - Kandidatentabelle zeigt `SKU` als eigene Spalte.
  - Deaktivierte Conversion erklärt den Grund explizit (fehlender bestätigter Match oder Status != READY).

### Validation
- `pytest -q backend/tests/test_sourcing_flows.py` -> 12 passed.
- `npm run typecheck` -> erfolgreich.
- `npm run build` -> erfolgreich.

## 2026-02-17 - Playwright production UX/bug audit (non-mutating)

### Business perspective
- Ziel war eine echte End-to-End-Bewertung der produktiven GUI auf Inkonsistenzen, UX-Reibung und funktionale Risiken, ohne Produktivdaten zu verfälschen.

### Technical scope and constraints
- Audit wurde über `http://192.168.178.72:15173` mit Playwright durchgeführt, inkl. kompletter Navigation über Kernmodule und kritische Operator-Flows.
- Sicherheits-/Datenintegritätsvorgabe: keine persistierenden Create/Update/Delete-Aktionen in Prod; Dialoge nur geöffnet und verworfen.

### Key decision and rationale
- Findings wurden als eigenes Artefakt unter `docs/playwright-e2e-ux-bug-audit-2026-02-17.md` dokumentiert, priorisiert nach P0-P2 und mit Datei-/Log-Evidenz hinterlegt.
- Fokus der Priorisierung: zuerst Kontinuitäts- und Sicherheitsrisiken (Prod-Serve-Modus, Transport-Sicherheit, Auth-Verhalten), danach UX-/Datenqualitätsdefizite.

## 2026-02-18 - Planned hardening batch after production Playwright audit

### Business perspective
- HTTP im internen Netz bleibt bewusst unverändert; Priorität liegt auf Auth-Zuverlässigkeit, produktionsfähigem Frontend-Serving, und operativer UX-Reduktion von Fehlbedienungsrisiken.

### Technical intent
- Auth-Gate auf echte Backend-Validierung umstellen (kein App-Shell-Eintritt mit invaliden Credentials).
- Compose-Frontend standardmäßig ohne Vite-Dev-Server betreiben (Build + Preview) und Dev-Mode explizit opt-in machen.
- Marketplace/Sales/Sourcing UI sprachlich konsolidieren und Picker-Tabellen auf operator-taugliche Primärinformationen umstellen.
- eBay.de-Extraktion bei Bildern und generischen Titeln robuster machen, um `Kein Bild`/`Neues Angebot`-Noise zu reduzieren.

### Risk handling
- Änderungen bewusst inkrementell in Frontend/Compose/Scraper; keine destruktiven Datenmigrationen.
- Verifikation über Typecheck/Build/Tests plus gezielte Scraper-Unit-Tests.

## 2026-02-18 - Implemented hardening batch (excluding HTTP-only login transport)

### Business outcome
- Kritische UX-/Zuverlässigkeitsprobleme aus dem Playwright-Audit wurden behoben, ohne den bewusst akzeptierten HTTP-internen Betriebsmodus zu ändern.
- Operator-Flows für Matching/Sourcing/Marketplace sind konsistenter und weniger fehleranfällig.

### Technical implementation
- Auth-Hardening:
  - Login akzeptiert Credentials erst nach Backend-Validierung.
  - Persistierte invalide Credentials werden beim App-Start erkannt und bereinigt.
  - Globale 401-Responses räumen Credentials auf, um inkonsistente Session-Zustände zu vermeiden.
- Frontend serving:
  - Compose-Default für `frontend` auf `build + preview` umgestellt; Vite-Dev-Server ist nur noch explizit opt-in.
- UI/UX consistency:
  - Sprachkonsolidierung (deutsche Labels/Begriffe) in zentralen Views.
  - Marketplace-/Sales-Picker auf operator-relevante Felder (Artikelcode/EK/Status), reduzierte UUID-Lastigkeit, suchgetriebene Kandidatenabfrage.
  - Sourcing-Detail und Sourcing-Settings lokalisiert/vereinheitlicht.
- Scraper robustness (eBay.de):
  - Bild-Extraktion erweitert (inkl. lazy/srcset-Quellen) und URL-Normalisierung ergänzt.
  - Generische Titel wie `Neues Angebot` werden bereinigt bzw. als unbrauchbare Listing-Titel verworfen.

### Validation
- `frontend`: `npm test`, `npm run typecheck`, `npm run build` erfolgreich.
- `sourcing-scraper`: `python3 -m py_compile sourcing-scraper/app/platforms/ebay_de.py` erfolgreich.

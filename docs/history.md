# History

## 2026-02-08 - Privatankauf: Versand + Käuferschutz/PayLivery als Anschaffungsnebenkosten

### Ausgangslage
- Beim Sourcing über Plattformen wie Kleinanzeigen/Willhaben entstehen zusätzlich zum Warenbetrag auch Versand- und Käuferschutz-/PayLivery-Gebühren.
- Bisher konnte der Privatankauf nur den Warenbetrag sauber erfassen; zusätzliche Gebühren mussten indirekt über separate Workflows nachgezogen werden.

### Business-Entscheidungen
- Versand- und Käuferschutz-/PayLivery-Kosten werden bei `PRIVATE_DIFF` als **Anschaffungsnebenkosten** behandelt, damit die Stückkostenbasis und Margenrechnung pro Artikel korrekt bleiben.
- Der Eigenbeleg bleibt auf den **Warenbetrag an den Verkäufer** fokussiert (`Purchase.total_amount_cents`), damit die Dokumentation gegenüber der Gegenpartei nicht verfälscht wird.
- Für Bank-Abgleich und Liquidität wird im Ledger der **tatsächlich bezahlte Gesamtbetrag** (Warenbetrag + Versand + Gebühr) verwendet.

### Technische Entscheidungen
- Neue additive Felder auf Einkaufsebene:
  - `Purchase.shipping_cost_cents`
  - `Purchase.buyer_protection_fee_cents`
- Neue persistierte Verteilfelder je Einkaufsposition:
  - `PurchaseLine.shipping_allocated_cents`
  - `PurchaseLine.buyer_protection_fee_allocated_cents`
- Verteilung der Nebenkosten erfolgt proportional anhand der Positionspreise mit deterministischer Rundung; die Summe der Positionen entspricht immer exakt den Gesamtkosten.
- Bei Änderungen eines Einkaufs werden Kosten per Delta neu auf Lagerartikel (`allocated_costs_cents`) angewendet, damit bestehende andere Kostenquellen (z. B. Cost Allocation/FBA) nicht überschrieben werden.
- `COMMERCIAL_REGULAR` bleibt bewusst ausgeschlossen (Nebenkostenfelder müssen dort `0` sein), um steuerliche Mischlogik im MVP zu vermeiden.

### Risiken / Trade-offs
- Proportionale Verteilung kann bei kleinen Beträgen Rundungsreste erzeugen; deterministische Resteverteilung reduziert, aber eliminiert nicht die subjektive Wahrnehmung von „unfairen“ Cent-Verteilungen.
- Die Aggregation im Ledger weicht absichtlich vom Eigenbeleg-Betrag ab (betriebswirtschaftlich korrekt, aber erklärungsbedürftig für Nutzer).

## 2026-02-08 - Branding-Umstellung auf Kater-Wegscheider Company

### Ausgangslage
- Die Anwendung war in mehreren Stellen mit einem generischen Produktbranding benannt (UI, API-Bezeichner, Paketname, Dokumentation).
- Das passt nicht zur tatsächlichen Positionierung als proprietäre Unternehmenssoftware.

### Business-Entscheidungen
- Einheitliche Produktbezeichnung in sichtbaren Oberflächen und Doku: `Kater-Wegscheider Company`.
- Klare Abgrenzung von einem vermarkteten SaaS-Template hin zu interner Unternehmenssoftware.

### Technische Entscheidungen
- Technische Bezeichner mit dem alten Präfix wurden auf neutrale `company`-Namen umgestellt (Schemas, Service-Funktion, Reports-Endpoint).
- Der Reports-Endpunkt wurde konsistent auf `/reports/company-dashboard` umbenannt und im Frontend angepasst.
- Theme-Storage-Key und Frontend-Paketname wurden zur neuen Brand konsistent aktualisiert.

### Risiken / Trade-offs
- API-Pfad-Änderung ist ein Breaking Change für externe Consumer; im aktuellen Setup ist das vertretbar, da Frontend und Backend gemeinsam betrieben werden.

## 2026-02-08 - Diagnose: Frontend `NetworkError` bei API-Calls

### Ausgangslage
- Frontend lief als Docker-Service auf Port `15173`, Browser-Requests an die API schlugen aber mit `NetworkError` fehl.
- Der Verdacht war ein Kommunikationsproblem zwischen Frontend und Backend (Port/Origin).

### Erkenntnisse
- Der laufende Frontend-Container hatte `VITE_API_BASE_URL=http://localhost:8000/api/v1`.
- Der laufende Backend-Container war auf Host-Port `18000` veröffentlicht (`18000 -> 8000`).
- Damit zeigten Frontend-Requests auf den falschen Port; zusätzlich war die Konfiguration nicht zentralisiert, wodurch Port-Drift leicht entsteht.

### Entscheidung
- Docker-Compose soll `VITE_API_BASE_URL` aus der Root-`.env` übernehmen (mit sinnvollem Fallback auf den veröffentlichten Backend-Port), statt auf einen harten Wert zu zeigen.
- Backend-Port wird über eine gemeinsame Variable (`BACKEND_PORT`) konfigurierbar gemacht, damit API-URL und Port-Mapping konsistent bleiben.
- CORS bekommt einen defensiven Fallback für lokale Frontend-Origins.

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

## 2026-02-08 - Qualitätsdurchlauf: Teststrategie und Stabilität

### Ausgangslage
- Die bestehende Test-Suite deckt v. a. Utility-/Teil-Logik ab, aber nur begrenzt End-to-End-Verhalten über Services und API-ähnliche Flows.
- Frontend hat bisher keine automatisierten Tests.

### Business-Entscheidungen
- Fokus auf regressionskritische Geschäftsprozesse statt künstlich hoher Coverage:
  - Einkauf -> Lagerzugang
  - Verkauf -> Finalisierung -> Rückabwicklung
  - FBA-Shipping inkl. Kostenumlage
  - Kostenumlagen/OpEx/Mileage
  - Reporting-/Steuerlogik und sicherheitsrelevante File-Zugriffe
- Ziel ist vor allem betriebliche Verlässlichkeit (keine stillen Status-/Betragsfehler), nicht nur formale Testmetriken.

### Technische Entscheidungen
- Einführung einer robusten Backend-Testbasis mit echter DB-Interaktion (SQLAlchemy async), inkl. Fixture-Strategie für deterministische Testdaten.
- Ergänzung gezielter Negativtests (Fehlerpfade, Invalid States, Schutzmechanismen), um reale Betriebsfehler früh zu erkennen.
- Einführung einer schlanken Frontend-Testschicht (Utility-/Auth/API-nahe Logik), damit Kernverhalten im Browsercode abgesichert ist.
- Bei identifizierten Inkonsistenzen erfolgt direktes Refactoring/Fix, anschließend Absicherung durch Tests.

### Risiken / Trade-offs
- Mehr Integrationsnahe Tests erhöhen Laufzeit, senken dafür das Risiko von Business-kritischen Regressionen.
- Test-Fixtures müssen sauber gekapselt bleiben, damit keine Seiteneffekte zwischen Modulen entstehen.

### Umsetzung
- Backend-Testbasis auf asynchrone, isolierte DB-Integration erweitert (inkl. Typ-Mapping für JSONB im SQLite-Testkontext).
- Neue Integrations-/Flow-Tests für:
  - Einkauf/Update/Inventar-Referenzen
  - Sales-Finalisierung/Storno/Returns
  - FBA Shipping + Empfang + Kostenumlage
  - Cost Allocation, OpEx, Mileage
  - Reporting (Dashboard, VAT, Month-Close ZIP)
  - Dokumentnummern, Bank-Transaktions-Utilities, File-Download-Sicherheit
- Frontend-Testinfrastruktur ergänzt (Vitest + Testing Library) mit Tests für:
  - Money-/Date-Utilities
  - Auth-Persistenz (LocalStorage)
  - API-Hook (Headers, Fehlerbehandlung, Blob-Download)
- Konkreter Bugfix aus Testlauf:
  - `_parse_iso_date()` normalisiert `datetime` jetzt korrekt auf `date`, um Typinkonsistenzen im Bank-Sync zu vermeiden.

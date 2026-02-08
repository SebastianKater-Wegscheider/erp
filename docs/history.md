# History

## 2026-02-08 - Eigenbeleg ohne Unterschriftsblock, mit Nachweisdaten

### Ausgangslage
- Der bisherige Eigenbeleg enthält einen klassischen Unterschriftsblock, während die tatsächlichen Nachweise inzwischen digital vorliegen (Plattformquelle, Anzeige-URL, Chat-/Anzeige-Screenshots als Uploads).

### Business-Entscheidung
- Der Unterschriftsbereich wird aus dem Eigenbeleg entfernt.
- Stattdessen zeigt der Eigenbeleg die hinterlegten Nachweisdaten strukturiert an, damit der Beleg den realen Beschaffungsprozess besser dokumentiert.

### Technische Entscheidung
- Der PDF-Context für `purchase_credit_note.html` wird um `source_platform`, `listing_url`, `notes` und `purchase_attachments` erweitert.
- Das Template rendert diese Felder im Bereich „Belege / Nachweise“ inkl. Dateinamen, Typ und optionaler Notiz.

### Risiken / Trade-offs
- Upload-Pfade und Dateinamen sind reine Referenzen; der Eigenbeleg enthält keine eingebetteten Originaldateien.
- Bei sehr vielen Anhängen wächst der Beleg textuell, bleibt aber nachvollziehbar und auditierbar.

## 2026-02-08 - Privatankauf: Plattformquelle + Evidenzanhänge

### Ausgangslage
- Beim Erfassen von Privatankäufen fehlt aktuell die strukturierte Quelle (z. B. Kleinanzeigen, ebay, willhaben.at).
- Relevante Nachweise (Anzeige, Chatverlauf, Screenshots) können nicht am Einkauf hinterlegt werden und gehen damit für Nachvollziehbarkeit/Prüfung verloren.

### Business-Entscheidungen
- Die Einkaufsquelle wird als optionales Feld direkt am Einkauf geführt, mit Vorschlagsliste plus frei ergänzbaren Werten.
- Zusätzlich werden je Einkauf mehrere Evidenzdateien unterstützt (z. B. Anzeige-Screenshot, Konversation, Rechnung/Beleg-Upload).
- Monatsabschluss-Export soll diese Nachweise mit ausgeben, damit die Prüfkette im Archiv vollständig bleibt.

### Technische Entscheidungen
- Additive Felder auf `purchases`: `source_platform`, `listing_url`, `notes` (abwärtskompatibel, optional).
- Neue Tabelle `purchase_attachments` für beliebig viele Dateien pro Einkauf, inkl. Metadaten (`kind`, `original_filename`, optionale Notiz).
- Neue API-Flows:
  - Plattformvorschläge (`GET /purchases/source-platforms`)
  - Attachments je Einkauf listen/anlegen/löschen (`GET/POST/DELETE /purchases/{id}/attachments...`)
- Frontend nutzt ein Combobox-/Datalist-Muster mit fixen Defaults plus DB-gestützten Vorschlägen und erlaubt freie Eingaben.
- Upload läuft weiterhin über den bestehenden Upload-Endpunkt; die Einkauf-Referenz wird danach separat persistiert.
- Month-Close ZIP wird um `csv/purchase_attachments.csv` und die referenzierten Dateien ergänzt.

### Risiken / Trade-offs
- Freitext-Plattformen können Dubletten erzeugen (z. B. `Ebay`, `eBay`); wird im MVP bewusst toleriert und per Normalisierung in Suggestions entschärft.
- Datei-Uploads erhöhen Speicherbedarf; es gibt im MVP noch keine Deduplizierung und keine Größenquoten pro Einkauf.
- Gelöschte Attachments entfernen die Referenz, nicht zwingend die Datei im Upload-Ordner (bewusste Safety-Entscheidung gegen versehentlichen Datenverlust).

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

## 2026-02-08 - Reopen von finalisierten Einkäufen/Verkäufen für Korrekturen

### Ausgangslage
- Nach Generierung von Einkaufs-PDFs (`pdf_path`) und Verkaufs-Rechnungen (`invoice_pdf_path`) waren Datensätze gesperrt.
- In der Praxis treten nachträgliche Korrekturen auf (falscher Name, falsche Position, ergänzte Nachweise), die ohne Neu-Erfassung möglich sein müssen.

### Business-Entscheidungen
- Es wird eine explizite "Zur Bearbeitung öffnen"-Funktion eingeführt:
  - Einkauf: PDF-Lock entfernen, damit der Einkauf bearbeitet und danach erneut als Eigenbeleg erzeugt werden kann.
  - Verkauf: Status von `FINALIZED` zurück auf `DRAFT`, damit wieder voll editierbar.
- Beim Reopen bleibt die Dokumentnummer erhalten; bei erneuter PDF-Erzeugung wird das Dokument damit konsistent überschrieben statt neu nummeriert.
- Für Verkäufe mit bestehenden Korrekturen (Returns) ist Reopen gesperrt, um keine widersprüchlichen Buchungen/Status zu erzeugen.

### Technische Entscheidungen
- Neue dedizierte Backend-Endpunkte für Reopen (Purchase + Sales), statt impliziter Freischaltung über `PUT`.
- Reopen Sales führt technische Rückabwicklung durch:
  - `SalesOrder.status -> DRAFT`
  - `invoice_pdf_path -> NULL`
  - Reservierungszustand der enthaltenen Inventory-Items wiederherstellen (`SOLD -> RESERVED`)
  - zugehörigen Ledger-Eintrag der finalisierten Zahlung löschen
  - shipping/margin-Snapshots auf 0 zurücksetzen
- Frontend erhält in Historienlisten klare Aktionen zum Reopen direkt neben PDF/Invoice-Buttons.

### Risiken / Trade-offs
- Reopen überschreibt den bisherigen finalen Dokumentzustand bewusst; Audit-Log dient als Nachvollziehbarkeit.
- Dokumentnummern-Lücken werden reduziert, aber eine bereits extern versendete Rechnung kann durch Reopen intern geändert werden; disziplinierte Nutzung bleibt erforderlich.

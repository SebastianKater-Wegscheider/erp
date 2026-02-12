# History

## 2026-02-11 - Incident-Hardening: Scraper-Limits + Slow-Mode + Health-Monitoring

### Ausgangslage
- Die Produktionsinstanz war zeitweise per TCP erreichbar, hat aber auf HTTP-Anfragen nicht mehr geantwortet.
- Im gleichen Zeitfenster gab es Hinweise auf Datenbank-Stress (lange Checkpoints, Autovacuum-Startwarnungen) und DNS-Timeouts im Docker-Resolver.
- Der externe `amazon-scraper` lief ohne harte CPU/RAM/PID-Limits und mit vergleichsweise aggressiven Navigations-Delays/Page-Tiefe.

### Business-Entscheidungen
- Prioritaet ist Stabilitaet vor Scrape-Durchsatz: Amazon-Abfragen duerfen bewusst langsamer laufen.
- Bei Lastspitzen soll der Scraper zuerst gedrosselt werden, damit Kernfunktionen (ERP-API/UI) responsiv bleiben.
- Ein schlanker CLI-Runbook-/Monitoring-Weg wird im Hauptrepo verankert, damit Diagnose und Recovery reproduzierbar bleiben.

### Technische Entscheidungen
- Neues Ops-Runbook dokumentiert Incident-Diagnose, typische Ursachenbilder und Sofortmassnahmen.
- Neues Monitoring-Skript liefert kompakte Health-/Compose-/Load-Sicht fuer `erp` und `amazon-scraper`.
- Neues Hardening-Skript setzt fuer `amazon-scraper`:
  - Ressourcenlimits (`cpus`, `mem_limit`, `mem_reservation`, `pids_limit`)
  - Slow-Mode (`SCRAPER_MIN_DELAY_NAV`, `SCRAPER_MAX_DELAY_NAV`, `SCRAPER_MAX_OFFER_PAGES`)
  - anschliessenden kontrollierten Restart + Health-Check.
- ERP-Scheduler-Defaults werden konservativer gesetzt (`AMAZON_SCRAPER_LOOP_TICK_SECONDS`, `AMAZON_SCRAPER_MIN_SUCCESS_INTERVAL_SECONDS`, `AMAZON_SCRAPER_MAX_BACKOFF_SECONDS`).

## 2026-02-11 - Produktstamm: BSR-First Sortierung + Schnellfilter Auf Lager + kompaktere Amazon-Zeile

### Ausgangslage
- In `Produktstamm > Amazon Status` war die Standardreihenfolge nicht auf operative Prioritaet optimiert (Bestseller nicht automatisch oben).
- Ein schneller Fokus auf aktuell verkaufbare Produkte (in stock) fehlte.
- In der Tabellenzeile war `ASIN` sichtbar, waehrend fuer Repricing/Ankaufsentscheidungen `BSR` und `Used best` relevanter sind.

### Business-Entscheidungen
- Standard-Sortierung im Produktstamm wird auf BSR im uebergeordneten Ranking (`amazon_rank_overall`, aufsteigend) gesetzt.
- Ein schneller "Auf Lager"-Filter wird direkt im Produktstamm-Filterbereich angeboten (ohne extra Navigation).
- In Amazon-Row-Scanline werden `BSR` und `Used best` sichtbar gemacht; `ASIN` bleibt nur als sekundäre Aktion (Copy/Details), nicht als prominenter Row-Inhalt.

### Technische Entscheidungen
- Backend-Listendpoint `/master-products` akzeptiert `in_stock_only` und filtert per `EXISTS` auf Inventory-Status (`DRAFT`, `AVAILABLE`, `FBA_INBOUND`, `FBA_WAREHOUSE`, `RESERVED`).
- Frontend fuehrt explizite Sortieroptionen ein, default ist `BSR (Overall)`.
- Amazon-Row wird in Mobile/Desktop auf kompakte 1-2 Zeilen reduziert, mit inline KPI (`BSR`, `Used best`) und unveraendertem Details-Accordion.

## 2026-02-11 - UX Harmonisierung + Bank-Sync Entfernung + Einkauf/Fahrt Integration

### Ausgangslage
- Die Tabellenansichten sind ueber Seiten hinweg uneinheitlich (unterschiedliche Zeilenhoehen, inkonsistente Ausrichtung, zu viele gleichgewichtete Informationen).
- Das Bank-Modul (GoCardless Sync + manuelle Zuordnung von Transaktionen) erzeugt hohe Komplexitaet, liefert aber im aktuellen Betrieb keinen verlaesslichen Mehrwert.
- Fahrtenbuch und Einkaufsworkflow sind funktional getrennt; der bestehende Link ist aus UX-Sicht zu schwach, wodurch der Prozessbruch im Alltag sichtbar bleibt.

### Business-Entscheidungen
- Die App priorisiert einen kompakten, ruhigen Arbeitsfluss fuer Reselling-Operations: Primary-Infos zuerst, sekundare Details nur auf Nachfrage.
- Bank-Sync und Bank-Linking werden komplett entfernt; die Zahlungsquelle `BANK` bleibt als manuelle Buchungsoption fuer Einkaufs-/Verkaufs-/Kostenprozesse erhalten.
- Fahrten werden direkt im Einkaufsdialog als optionaler Inline-Baustein gepflegt, statt als separater Nachgangsschritt.
- Das Dashboard verzichtet bewusst auf die bisherige "Heute/Inbox"-Karte; offene Punkte bleiben ueber zielgerichtete Views/Filter erreichbar statt als zweite Arbeitsliste im Startscreen.

### Technische Entscheidungen
- Gemeinsame Frontend-Primitives fuer Tabellenzeilen und Aktionsspalten werden eingefuehrt, um Layout/Spacing/Alignment zentral zu steuern.
- Routing und Navigation werden um das Bank-Modul bereinigt; Backend-Bankrouter, Sync-Service und Startup-Task entfallen.
- Datenmodell wird um einen klaren Primärlink Einkauf -> Fahrteneintrag erweitert (`purchases.primary_mileage_log_id`), inklusive API fuer get/upsert/delete.
- Migrationen droppen die Bank-spezifischen Tabellen (`bank_accounts`, `bank_transactions`, `bank_transaction_purchases`) und fuegen den Purchase-Mileage-Link hinzu.
- KPI-Zellen in `inventory?view=overview` werden auf feste Kartenhoehe + konsistente Rechtsausrichtung vereinheitlicht; `master-products` blendet Low-Priority Amazon-Retry-Details aus der Scanline aus und verschiebt sie in den Expand-Block.

### Risiken / Trade-offs
- Entfernen des Bank-Moduls ist bewusst irreversibel auf App-Ebene; historische Bank-Sync-Daten gehen mit der Schema-Bereinigung verloren.
- Zusätzliche Inline-Felder im Einkaufsdialog erhoehen den Formumfang leicht, reduzieren aber den Prozessbruch und Nachbearbeitungsaufwand.
- Row-Harmonisierung erfordert groesseren Frontend-Refactor; Risiko wird durch zentrale Primitives und Regression-Tests abgefedert.

## 2026-02-11 - Einkaeufe Modal: stabile Hoehe, interner Scroll, klarere Hierarchie

### Ausgangslage
- Das neue Einkaufs-Modal hatte bei langen Formularen keinen stabilen vertikalen Scroll im Inhaltsbereich.
- Beim Tab-Wechsel aenderte sich die Gesamtgroesse des Modals sichtbar, was unruhig wirkt.
- Header, Tabs und Forminhalt lagen visuell zu nah beieinander und wirkten zu wenig strukturiert.

### Technische Entscheidungen
- Das Einkaufs-Modal bekommt eine feste Dialog-Hoehe (viewport-begrenzt) mit `flex`-Shell und getrenntem internem Scroll-Container.
- Der Scroll liegt ausschliesslich im Tab-Content-Bereich; Header, Tabs und Footer bleiben stabil.
- Die Tab-Inhalte werden in klare Content-Panels mit Border/Background gegliedert; Tabs erhalten eine deutlichere aktive/inaktive Hierarchie.

### Risiken / Trade-offs
- Fixere Dialog-Hoehe bedeutet, dass sehr kurze Inhalte mehr "Luft" zeigen; wird bewusst fuer ruhiges Layout akzeptiert.
- Zusaeztliche visuelle Struktur erhoeht den UI-Frame leicht, verbessert aber Orientierung und Scanbarkeit.

## 2026-02-11 - Einkaeufe UX Redesign: Dialog-Flow, progressive Felder, staged Evidenz-Uploads

### Ausgangslage
- Der Inline-Create/Edit-Flow in `Belege > Einkaeufe` ist bei langen Formularen langsam und fehleranfaellig.
- Beim Oeffnen/Schliessen von Dropdowns springt der Viewport teilweise nach oben und unterbricht die Datenerfassung.
- Evidenzanhaenge sind aktuell nur als "ein Typ + mehrere Dateien" nutzbar und erst nach dem ersten Save moeglich.
- Felder wie Geburtsdatum/Ausweisnummer sind im Tagesgeschaeft selten relevant, stehen aber sehr prominent.

### Business-Entscheidungen
- Einkaufs-Erfassung und Bearbeitung laufen in einem Modal-Dialog mit klaren Teilbereichen statt als lange Inline-Form.
- Primare Eingaben (Datum, Gegenpartei, Zahlungsquelle, Plattform, Betraege, Positionen) werden priorisiert; seltene Identitaetsfelder werden als "Erweitert" nach hinten verlagert.
- Plattformwahl wird gefuehrt ueber Dropdown (inkl. "Andere..." fuer Freitext), damit Eingaben schneller und konsistenter sind.
- Evidenzanhaenge folgen einem 2-Stufen-Flow: Dateien sofort hochladen, danach Typ/Notiz je Datei mappen und dann gesammelt am Einkauf verknuepfen.

### Technische Entscheidungen
- Purchases-Form wird analog zu Sales in einen Dialog mit Tabs ueberfuehrt (Eckdaten, Positionen, Nachweise).
- Select-Scroll-Restore wird gehaertet: neben `window`-Scroll wird auch der naechste scrollbare Container des Triggers beim Close wiederhergestellt.
- Neue Frontend-Stage fuer Uploads (`queued/uploading/uploaded/error`) inkl. Retry, Remove, Bulk-Kind-Set und Chunking beim Attach-POST (max 30 pro Request).
- Bei Create werden bereits hochgeladene/mappte Dateien nach erfolgreichem Einkauf automatisch verknuepft.

### Risiken / Trade-offs
- Im MVP werden unreferenzierte Uploads bei Dialog-Abbruch toleriert; die UI warnt vor nicht verknuepften Dateien.
- Der Dialog erhoeht UI-Weight, reduziert dafuer Scroll-/Focus-Reibung signifikant und stabilisiert den Erfassungsprozess.

## 2026-02-09 - DB-Migrationen: Alembic Baseline + Compose-Integration

### Ausgangslage
- Schema-Upgrades liefen bisher ueber `create_all()` + `ensure_schema()` beim App-Startup (MVP-Stopgap).
- Das ist schwer nachvollziehbar (kein Migrations-Log), und riskant bei Schema-Drift.

### Technische Entscheidungen
- Alembic eingefuehrt inkl. Baseline-Migration (`e61db2bd6234`) als Ausgangspunkt fuer kuenftige Schema-Aenderungen.
- Backend macht keine DDL-Operationen mehr beim Startup; das Schema wird ueber Alembic verwaltet.
- Docker Compose startet den Backend-Service mit `alembic upgrade head` vor Uvicorn.
- Fehlende Indizes wurden in den Modellen explizit definiert, damit sie in Migrationen/Schema-Abgleich enthalten sind.

### Ops / Migrationspfad
- Bestehende Datenbanken (vor Alembic) muessen einmalig gestampt werden:
  - `alembic stamp e61db2bd6234` (siehe README).

### Risiken / Trade-offs
- Einmaliger manueller Schritt fuer bestehende Deployments (Stamping).
- Migrationslauf beim Container-Start kostet minimal Zeit, ist aber bei aktuellem Schema ein No-op.

## 2026-02-09 - CI + Minimaler E2E Smoke Test

### Ausgangslage
- Backend-/Frontend-Aenderungen konnten ohne durchgehenden Automatismus unbemerkt regressieren.
- Es gab keinen Smoke-Test, der UI + Backend zusammen prueft (z. B. Login + Dashboard).

### Technische Entscheidungen
- GitHub Actions CI eingefuehrt:
  - Backend: Ruff + Pytest
  - Migrations: `alembic upgrade head` + Schema-Drift-Check (Models vs. DB)
  - Frontend: Typecheck + Tests + Build
- Playwright E2E als minimaler Smoke-Test: Login + Dashboard laden.

### Risiken / Trade-offs
- E2E ist bewusst klein gehalten (Smoke), nicht als vollumfaengliche UI-Test-Suite.
- Playwright Install/Browser-Download in CI erhoeht Laufzeit.

## 2026-02-10 - Amazon ASIN Scrape: Used-Competition, Offer-Counts, Verlauf + FBA Margin Schaetzung

### Ausgangslage
- Amazon-Preisdaten sind fuer Reselling vor allem als Vergleich gegen Used-Listings relevant (nicht nur Neu/Buybox).
- Im Produktstamm waren zwar bereits einzelne Condition-Buckets gespeichert, die UI-Zusammenfassung zeigte aber primaer `Neu`/`Wie neu` und wirkte dadurch oft "leer", obwohl Used-Angebote existierten.
- Fuer operative Entscheidungen (Beschaffung/Preisfindung/Bestandsbewertung) fehlte eine einheitliche, schnelle Sicht: Marktpreis, Angebotstiefe (Offers) und Entwicklung ueber Zeit.

### Business-Entscheidungen
- In der MasterProducts-Liste steht im Vordergrund: `Used best` (Minimum ueber Used-Grades) + Buybox + Offer-Counts.
- Details werden bewusst "on demand" per Row-Expand (Accordion) gezeigt, damit die Liste scannable bleibt, aber Tiefeninfo und Verlauf verfuegbar sind.
- Inventory und Purchases bekommen eine einfache, konsistente Marktwert-/Marge-Schaetzung auf Basis der Amazon-Daten, um Opportunitaeten (Arbitrage) schneller zu sehen.

### Technische Entscheidungen
- `amazon_product_metrics_latest` wird um Buybox-Total und Offer-Counts erweitert (Snapshot-Usecase); Fehler/Blocks ueberschreiben die letzten gueltigen Werte nicht.
- Historie fuer Charts wird nicht als weitere Tabelle modelliert, sondern aus `amazon_scrape_runs` + `amazon_scrape_best_prices` aggregiert (min Used-Total pro Run).
- FBA-Fee/Shipping wird als globales, ENV-override-faehiges Profil im Backend bereitgestellt (API-Endpoint), damit die Frontend-Berechnungen ohne Rebuild bei Bedarf angepasst werden koennen.

### Risiken / Trade-offs
- Scraping ist volatil und kann blocken; UI und Scheduler muessen mit teilweisen/fehlenden Daten umgehen.
- Fee-Schaetzung ist bewusst ein heuristisches Modell (globales Default-Profil), nicht ein produkt-/kategorie-spezifisches Fee-Calc.
- Offer-Counts sind vom Liefer-ZIP und Amazon-Experiments abhaengig; werden als "Signal" genutzt, nicht als auditierbare Kennzahl.

## 2026-02-10 - Verkaeufe: Edit-Form in Modal statt Inline (Scroll-Jump Fix)

### Ausgangslage
- Beim Bearbeiten eines Verkaufs sprang der Viewport beim Auswaehlen in Dropdowns (Radix Select/Combobox) wiederholt nach oben.
- Das hat das Editieren praktisch unbenutzbar gemacht, weil Eingaben nicht stabil im Sichtbereich blieben.

### Technische Entscheidung
- Die Sales-Create/Edit-Form wird in einen Dialog (Modal) verschoben, statt inline im Page-Flow zu stehen.
- Damit ist die Interaktion vom Page-Scroll entkoppelt; Dropdown-Focus/Portal-Behavior kann den Viewport nicht mehr "wegziehen".

### Risiken / Trade-offs
- Modal hat mehr "UI Weight" und braucht gute `max-height`/Scroll-Handling im Dialog-Body.
- Schliessen des Modals verwirft ungespeicherte Eingaben (wie zuvor beim Schliessen der Inline-Form).

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
- Zu diesem Zeitpunkt gab es keine vollwertige Migrationstoolchain (damals `ensure_schema`); seit 2026-02-09 werden Schema-Aenderungen ueber Alembic verwaltet.
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

## 2026-02-10 - Amazon (ASIN) Daily Scrape: BSR + Bestpreise je Zustand

### Ausgangslage
- Im Produktstamm existieren ASINs, aber aktuelle Marktsignale fehlen (Bestseller-Rank, Angebotspreise nach Zustand).
- Ein separater interner Scraper-Service liefert pro ASIN Buybox, Offers und Sales Ranks (best-effort; gelegentlich `blocked=true`).

### Business-Entscheidungen
- Jedes Master-Produkt mit ASIN soll mindestens einmal pro 24 Stunden erfolgreich gescraped werden.
- Gespeichert werden:
  - Bestseller-Rank (overall und kategoriespezifisch) inkl. vollständiger Rank-Liste zur Nachvollziehbarkeit.
  - Günstigste Preise pro Zustand (neu, gebraucht: wie neu/sehr gut/gut/akzeptabel, sammlerstueck).
- Die Daten sollen im Produktstamm sichtbar und filterbar sein, damit Sourcing/Preisentscheidungen schneller werden.

### Technische Entscheidungen
- Persistenz als Kombination aus:
  - Historie: jeder Scrape-Lauf als eigener Datensatz (Debuggability, Trend-Analysen).
  - Snapshot: eine "latest" Tabelle pro Master-Produkt für schnelle UI/Filter.
- Preislogik: "günstigster Preis" basiert auf Total inkl. Versand (primär `price_total`, sonst `price_item + price_shipping` wenn beides vorhanden).
- Robustheit:
  - `blocked=true` zaehlt nicht als "fresh"; Scheduler nutzt Retry mit exponentiellem Backoff + Jitter.
  - Scheduler arbeitet sequentiell (Scraper ist single-flight und 429-busy möglich).
  - Multi-Instance-Schutz ueber DB-basierten Lock (portabel, keine Postgres-only Advisory Locks).

### Risiken / Trade-offs
- Scraping ist volatil (A/B Tests, DOM-Aenderungen, Blocking). Historie und Block-Status helfen beim Debugging.
- Snapshot-Optimierung (UI) ist zusaetzliche Redundanz, reduziert aber Join-Komplexitaet und Last.
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

## 2026-02-08 - Eigenbeleg PDF: Identifikation nur wenn vorhanden + Uploads als Bilder einbetten

### Ausgangslage
- Im Eigenbeleg (Gutschrift) wurde der Block "Identifikation" immer gedruckt, auch wenn keine Daten erfasst wurden (wirkt willkuerlich/unvollstaendig).
- Hochgeladene Nachweise (z. B. Kleinanzeigen-Chat/Anzeige/Payment-Screenshots) wurden im PDF nur als Pfad referenziert; fuer eine Pruefung ist das unpraktisch.

### Business-Entscheidungen
- Wenn keine Identifikationsdaten erfasst sind, wird der Identifikationsblock gar nicht angezeigt (keine leeren Labels).
- Bild-Nachweise werden direkt im PDF dargestellt (mehrseitig), damit der Eigenbeleg zusammen mit den Nachweisen als ein Dokument abgelegt werden kann.

### Technische Entscheidungen
- WeasyPrint nutzt lokale `file://` URIs fuer Uploads; nur `uploads/` Pfade werden akzeptiert (wie bisher in API-Validierung).
- Layout/CSS wird so angepasst, dass der Footer die Inhalte nicht ueberlappt (groessere Bottom-Margin) und Bilder skaliert/umgebrochen werden.
- Sehr hohe/vertikale Screenshots werden beim PDF-Render in mehrere Seitensegmente geschnitten, damit sie bei voller Breite lesbar bleiben.

## 2026-02-08 - Frontend Mobile-Optimierung (Desktop unveraendert)

### Ausgangslage
- Desktop-Ansicht ist stimmig; auf Mobile wirkt die UI zu dicht/klein (Tap-Targets, Form-Controls) und Dialoge/Tables sind nicht angenehm zu bedienen.

### Business-Entscheidungen
- Desktop-Layout bleibt unveraendert; Anpassungen werden ausschliesslich fuer kleine Viewports umgesetzt.
- Fokus auf "nutzbar auf dem Handy" statt pixel-perfekte Redesigns: groessere Interaktionsflaechen, weniger Padding, bessere Scrollbarkeit.

### Technische Entscheidungen
- UI-Primitives bekommen mobile-spezifische Tailwind-Klassen (Basis) mit `sm:` Overrides fuer identisches Desktop-Verhalten.
- Inputs/Selects auf >=16px Font gesetzt, um iOS Safari Auto-Zoom zu vermeiden.
- Cards: geringere Padding/Title-Groesse auf Mobile, um mehr Inhalt sichtbar zu machen.
- Dialoge: mobile Seitenrands + max-height/overflow fuer lange Inhalte; Close-Button mit groesserer Hit-Area.
- Tables: horizontaler Scroll als Default (`overflow-x-auto`); `min-w-max` kurz getestet, spaeter wieder entfernt, damit nicht jede Table auf Mobile horizontal scrollt.
- Topbar: kurzer Titel auf Mobile (Abkuerzung), damit Header nicht ueberlaeuft.
- Zusaetzlicher Guard gegen horizontales "Seitwaerts-Panning" auf iOS: `overflow-x` fuer `html/body` auf `clip` (Fallback `hidden`).
- Falls Overflow aus Portals/absolut positionierten Elementen kommt: gleicher Guard auf `#root` (clip/hidden), damit Safari die Scroll-Width nicht vergroessert.
- Tables: `min-w-max` wieder entfernt; einige Views (Dashboard) sollen auf Mobile nicht horizontal scrollen, wenn die Inhalte eigentlich per Truncate passen.
- Dashboard/Performance: Chart-Wrapper auf `overflow-hidden` + Tooltip max-width/break-words, weil iOS Safari sonst durch absolut positionierte Tooltip-Elemente horizontales Panning zulassen kann.
- Mobile Nav: Drawer breiter (viewport-basiert) + Safe-Area Insets; Search-Input fuer schnelle Navigation; Sections als Accordion (auto-open bei Suche); groessere Tap-Targets fuer Links.
- Mobile Nav: `onOpenAutoFocus` deaktiviert, damit iOS beim Oeffnen nicht sofort die Tastatur aufklappt; Dialog-Close-Button nutzt Safe-Area Insets (Right/Top), damit nichts im Notch-Bereich "clipped".
- Mobile Nav: Search + "Uebersicht" sticky im Drawer (schneller Wechsel beim Scrollen) und Theme-Toggle in den Drawer-Footer (one-handed).
- Mobile Nav: Sections standardmaessig offen (weniger Taps) + Active-Link wird beim Oeffnen in View gescrollt (inkl. Scroll-Margin fuer Sticky-Header); Scroll-Container mit `overscroll-contain`.
- Mobile Nav: Drawer ist jetzt wirklich full-height (override `max-h` vom Dialog) und Scroll-Fix via `min-h-0` in Flex-Layouts, damit iOS/Chrome den inneren Scroller nicht "abschneidet".
- Produktstamm + Lagerbestand: Mobile Views auf Card-Listen umgestellt (`md:hidden`), Desktop-Tabellen bleiben unveraendert (`hidden md:block`).
- Produktstamm: Actions/Filter auf Mobile besser stapelbar (Buttons full-width, Typ-Select full-width), Referenzbild-Klick stoppt Propagation damit Card-Tap nicht ungewollt editiert.
- Lagerbestand: Cards mit Status/Age/Condition/Cost + Fotos-Strip (horizontal scroll) und Buttons fuer Bearbeiten/Fotos; Status-Select full-width auf Mobile.
- iOS Zoom-Bug: Purchases "Notizen" war ein raw `<textarea>` mit `text-sm` und hat Safari Auto-Zoom getriggert; auf Mobile jetzt >=16px + gleiche Styles wie `Input`.
- Einkaeufe: Historie auf Mobile als Card-List (statt Table) mit klaren KPIs + Full-Width Actions; Desktop-Table bleibt unveraendert.
- Bank: Transaktionen auf Mobile als Card-List (Status/Zuordnung/Amount prominent) + Actions full-width; Desktop-Table bleibt unveraendert.
- Verkaeufe: Orders-Liste auf Mobile als Card-List mit actions (Bearbeiten/Abschliessen/Rechnung/Reopen/Returns) in handlichem Grid; Desktop-Table bleibt unveraendert.
- Naechster Schritt: Restliche Views (Dashboard Top/Flops, FBA Sendungen, Kostenverteilung, Betriebsausgaben, Fahrtenbuch) auf Mobile ebenfalls als Card-Listen/Stacked-Layouts rendern; Desktop-Tables bleiben unveraendert.
- Kostenverteilung: Historie auf Mobile als Card-List; Positionen im Formular als gestapelte Cards (UUID/Betrag) + full-width Actions.
- Betriebsausgaben: Historie auf Mobile als Card-List inkl. prominentem Betrag + "Beleg oeffnen"; Upload-/Submit-Bereich auf Mobile ohne Overflow (gestapelt/full-width).
- Fahrtenbuch: Historie auf Mobile als Card-List; Einkauf-Picker-Dialog rendert auf Mobile Cards statt 5-Spalten-Table (Add/Remove full-width), Desktop bleibt Table.
- FBA Sendungen: Sendungs-Liste auf Mobile als Cards inkl. Actions; Artikel-Auswahl/Selected-Liste sowie Empfangsdialog auf Mobile als stacked Layouts statt Tabellen, Desktop bleibt unveraendert.
- Dashboard: Top/Flops (30T) auf Mobile als Cards (Gewinn prominent, KPIs als Badges), Desktop-Table bleibt unveraendert.

## 2026-02-09 - Test-Suite Stabilisierung + zusaetzliche Abdeckung

### Ausgangslage
- Backend-Tests liefen, aber einzelne Flow-Tests waren instabil/rot durch Session-Rollbacks (SQLAlchemy expiriert ORM-Objekte bei `rollback()`), was in Async-Kontexten zu `MissingGreenlet` fuehren kann, wenn man danach Attribute aus ORM-Instanzen liest.
- PDF-Evidence-Test schrieb ein "PNG" als Platzhalterbytes; seit Evidence-Images wirklich mit Pillow verarbeitet werden, muss das Test-Image valide sein.

### Technische Entscheidungen
- Tests lesen nach `rollback()` keine ORM-Attribute mehr, sondern arbeiten mit zwischengespeicherten IDs/Scalar-Feldern.
- Evidence-Image im Test wird als echtes 1x1 PNG erzeugt (Pillow), damit der PDF-Flow realistisch bleibt.
- Zusaetzlicher Unit-Test fuer `_slice_image_for_pdf`: stellt sicher, dass kurze Bilder nicht gesliced werden und hohe Screenshots in mehrere PNG-Teile zerlegt werden.
- Frontend: kleine Component-Tests fuer `Input`/`Select`/`Dialog` (>=16px auf Mobile, Dialog max-height/scroll + Safe-Area Close) sowie `Topbar` (Drawer oeffnet ohne Auto-Focus auf Search Input).
- Refactor: `_slice_image_for_pdf` schliesst jetzt garantiert das originale `Image.open()` Handle (verhindert FD-Leaks bei vielen Evidence-Dateien).

## 2026-02-11 - Produktstamm List View: Fokus-Modi + weniger Clutter

### Ausgangslage
- Die Produktstamm-Liste zeigte Katalog- und Amazon-Signale gleichzeitig. Das erzeugte visuelle Dichte und erschwerte fokussiertes Arbeiten je nach Aufgabe.
- Filter waren dauerhaft sichtbar und mischten Basis-Filter (Suche/Typ) mit selteneren Amazon-Filtern.
- Die UUID war immer inline sichtbar, obwohl sie nur situativ gebraucht wird.

### Business-Entscheidungen
- Zwei explizite Arbeitsmodi in der Liste: `Katalog` (Stammdatenpflege) und `Amazon` (Marktsignale/Monitoring).
- Progressive Disclosure fuer Filter: oben nur Basissteuerung, erweiterte Filter in einem einklappbaren Bereich.
- "Produkte ohne ASIN" wird als direkter Fokus-Entry unterstuetzt, inklusive Deep-Link vom Dashboard.
- UUID wird nicht mehr als Dauerrauschen angezeigt, aber bleibt per "UUID kopieren" in Aktionen sofort verfuegbar.

### Technische Entscheidungen
- Neue URL-Parameter auf `/master-products`: `view=catalog|amazon` und `missing=asin`.
- Modus-Persistenz via `localStorage` (`master-products:view`); URL hat Vorrang, Benutzerwechsel schreibt den Parameter aktiv zurueck in die URL.
- Filter-Panel implementiert als collapsible Bereich mit aktivem Filter-Counter und globalem Reset.
- Listen-Rendering trennt Desktop/Mobile je nach Modus:
  - `Katalog`: Produkt + IDs, ohne Amazon-Block.
  - `Amazon`: Amazon-Summary als Hauptspalte inkl. Expand-Details.
- Dashboard-Inbox-Link "Produkte ohne ASIN" verweist auf `/master-products?missing=asin&view=catalog`.
- Frontend-Test-Setup haertet `localStorage`/`sessionStorage` explizit auf Storage-kompatible Methoden, damit Tests robust gegen fehlerhafte Runtime-Shims laufen.
- Neue Component-Tests fuer `MasterProducts` decken Modus-Sichtbarkeit (`Katalog` vs `Amazon`), URL-Filter `missing=asin` und die UUID-Copy-Aktion ab.

## 2026-02-11 - Produktstamm + Lagerbestand: KPI-Fokus (Marktpreis, Abverkauf, Marge)

### Ausgangslage
- Produktstamm (Amazon-Modus) zeigt relevante Signale (BSR/Used best), aber die Zeile ist textlastig; der Nutzer muss Werte "zusammenlesen".
- Lagerbestand mischt operative Pflege (SN/Lagerplatz/Fotos/IDs) mit Entscheidungs-KPIs (Marktpreis/Marge) in einer Ansicht; dadurch entsteht visuelle Dichte und wenig Scanbarkeit.
- Technische IDs (UUIDs) sind teilweise inline sichtbar, obwohl sie fuer den Daily Flow selten gebraucht werden.

### Business-Entscheidungen
- Ziel: Ein Master-Reseller soll pro Zeile in <5 Sekunden entscheiden koennen:
  - Marktpreis (Used / zustandsgemappt)
  - Sales Velocity (aus BSR, optional Offer-Konkurrenz)
  - (im Lagerbestand) Profit/Marge aus Kostenbasis vs. FBA-Payout
- Progressive Disclosure:
  - UUIDs nie inline, sondern ueber Copy-Aktionen erreichbar.
  - EAN/ASIN in Listen nur, wenn vorhanden (keine "—" Platzhalter); in Amazon-Fokus nur ASIN.
- Lagerbestand bekommt zwei Arbeitsmodi:
  - `Uebersicht` (Default): KPI-getrieben fuer Priorisierung/Preisentscheidungen.
  - `Ops`: Pflegefokus (SN/Lagerplatz/Fotos), ohne KPI-Rauschen.

### Technische Entscheidungen
- Neue, einfache Sell-Through-Heuristik:
  - Piecewise Mapping von BSR auf Tages-Range.
  - Konkurrenzanpassung ueber `sqrt(offers)` (gekappt), um "viele Angebote" als langsameren Abverkauf zu modellieren.
  - Confidence-Flag (HIGH/MEDIUM/LOW) abhaengig von Freshness/Blocked.
  - Disclaimer: Schätzung; echte Verkäufe variieren (BSR ist zeit-/kategorieabhaengig).
- UI: KPI-Strips mit `tabular-nums` und klarer Typo-Hierarchie (Zahlen gross, Labels klein).

## 2026-02-11 - Abverkauf: BSR-Velocity-Rekalibrierung (realistischere Werte)

### Problem / Beobachtung
- Die Abverkauf-Schaetzung war in der Praxis zu oft "1–2 Tage" und damit als Priorisierungs-KPI wenig brauchbar.
- Ursache: Wir haben haeufig den *specific/sub-category* Rank verwendet (typisch sehr klein, auch bei Nischen-Kategorien) und haben Sub-Tagesschaetzungen <1 Tag in der Anzeige auf mindestens 1 Tag gerundet.

### Business-Entscheidung
- Abverkauf soll eine "quick sanity check" Velocity liefern (schnell vs. langsam), ohne so aggressiv zu sein, dass fast alles als 1–2 Tage erscheint.
- Velocity-Grundlage wird an eine grobe, besser kommunizierbare BSR->Sales Heuristik angelehnt (Units/day Buckets), statt frei gewaehlter Day-Ranges.

### Technische Entscheidung
- Rank-Prioritaet in der Schaetzung: `overall` zuerst, `specific` nur als Fallback.
- Basis-Model: BSR -> geschaetzte Units/day Range (Buckets: #1-10, 11-100, 101-500, 501-2k, 2k-10k, 10k+), daraus `days = 1 / units_per_day`.
- Anzeige: < 1 Tag wird als Stunden (`h`) formatiert, damit schnelle Artikel nicht pauschal als "1 Tag" erscheinen.

## 2026-02-11 - Produktstamm/Lagerbestand: Journey-first Entzerrung (Queues + klare Rollen)

### Ausgangslage
- `Produktstamm` und `Lagerbestand` enthalten beide operatives und analytisches Material; dadurch entsteht Doppelung und visuelle Last.
- Die aktuelle Navigation gibt zwar Modi vor, aber priorisierte Tagesarbeit ("Was jetzt zuerst?") ist nicht klar genug gefuehrt.

### Business-Entscheidungen
- Primarer Daily-Driver fuer Repricing/Priorisierung ist `Lagerbestand`.
- `Produktstamm` wird auf Identitaet + Amazon-Datenqualitaet/Health ausgerichtet (nicht als Haupt-Entscheidungsoberflaeche fuer Tages-Priorisierung).
- Arbeitsfuehrung erfolgt ueber konkrete Work-Queues (MVP): fehlende Fotos, fehlender Lagerplatz, Amazon stale/blocked, Altbestand >90 Tage.
- Dashboard bleibt Inbox-Einstieg mit Count + Deep-Link; Abarbeitung findet in `Lagerbestand` statt.

### Technische Entscheidungen
- `Inventory` bekommt URL-faehige Queue-Filter (`queue=...`) zusaetzlich zu `q`, `status`, `view`.
- Queue-Definitionen werden backend-seitig serverbasiert gefiltert (kein clientseitiges Schätzen), damit Deep-Links, Counts und Liste identisch bleiben.
- `Produktstamm` behaelt zwei Modi, aber der Amazon-Modus wird auf Health-Status fokussiert; schwere Markt-Signal-Bloecke bleiben nur als progressive Details sichtbar.

## 2026-02-11 - Inventory Priorisieren: staerkere Zeilen-Hierarchie im Desktop-Table

### Ausgangslage
- Trotz Queue-Fokus ist die Desktop-Zeile in `Priorisieren` noch visuell dicht: viele Badges mit gleicher Gewichtung, mehrere schmale Spalten und wenig Trennung zwischen Kernsignal und Kontext.
- Nutzer koennen Werte sehen, muessen aber noch zu stark "horizontal lesen", um pro Zeile schnell zu priorisieren.

### Business-Entscheidung
- Ziel bleibt eine belastbare 5-Sekunden-Entscheidung pro Zeile.
- Primarsignale in der Zeile: `Marge`, `Abverkauf`, `Marktpreis`.
- Sekundaersignale (`BSR`, Confidence, Kosten-Details, SKU/Fotos) bleiben sichtbar, werden aber klar nachrangig dargestellt.

### Technische Entscheidung
- Desktop-`overview` reduziert Spaltenkomplexitaet, indem `Status + Alter + Zustand` zu einer strukturierten Status-Zelle gebuendelt werden.
- KPI-Zellen erhalten einen klaren Block-Aufbau (primaerer Zahlenwert, darunter Kontextzeile), um Scannbarkeit und Vergleichbarkeit zwischen Zeilen zu verbessern.
- Produkt-Zelle wird in Titel (primaer), Produkt-Meta (sekundaer) und technische Hinweise/Fotos (tertiaer) getrennt.

## 2026-02-11 - Inventory Priorisieren: visuelle Beruhigung (einheitliche KPI-Kartenhoehe + rundere Forms)

### Ausgangslage
- Nach dem ersten Hierarchie-Refactor blieb die Zeile subjektiv noch "unruhig", vor allem wegen unterschiedlich hoher KPI-Karten und vieler eckiger Mikroelemente.

### Business-Entscheidung
- In der Priorisieren-Ansicht soll jede KPI-Spalte pro Zeile als gleichwertiger Vergleichsblock wirken.
- Forms werden insgesamt runder, damit die Zeile weniger hart segmentiert und schneller erfassbar ist.

### Technische Entscheidung
- KPI-Karten (`Marktpreis`, `Abverkauf`, `Marge`) bekommen identische Mindesthoehe und `justify-between`, damit alle Karten ueber Zeilen konsistent gleich hoch rendern.
- Karten und Mikro-Tags wechseln auf rundere Shapes (`rounded-xl`/`rounded-full`) und etwas weichere Hintergruende fuer ruhigeren Gesamteindruck.

## 2026-02-11 - Inventory Priorisieren: striktes KPI-Grid (Alignment + Spacing)

### Ausgangslage
- Trotz runderer Cards wirkte die Zeile noch inkonsistent, weil `Abverkauf` linksbuendig aufgebaut war, waehrend `Marktpreis/Marge` rechtsbuendig waren.
- Uneinheitliche Breiten und teils umbrechende Meta-Zeilen erzeugten unruhige Abstaende zwischen den KPI-Spalten.

### Business-Entscheidung
- KPI-Spalten sollen wie ein einheitliches Grid wirken: gleiche Breite, gleiche Hoehe, gleiches Text-Alignment.
- Meta-Information bleibt vorhanden, aber in einer ruhigen, einzeiligen Form ohne zusätzliche visuelle Chips in der Desktop-Zeile.

### Technische Entscheidung
- `Marktpreis`, `Abverkauf`, `Marge` erhalten identische Header-/Cell-Breiten und verwenden dieselbe rechtsbuendige Card-Klasse.
- Abverkauf-Meta wird als kompakte Textzeile (`Speed · BSR · Sicherheit`) dargestellt; Badge-Elemente werden aus der Desktop-Karte entfernt.
- Card-Meta-Zeilen werden auf eine Zeile begrenzt (`truncate`), damit Kartenhoehen zwischen Datensaetzen konsistent bleiben.

## 2026-02-11 - Frontend Harmonisierung: gemeinsame Header/Message/Search-Primitives

### Ausgangslage
- Die Seiten nutzten ähnliche UI-Bloecke mit leicht unterschiedlichen Abstaenden/Typografie (Seitentitel + Aktionen, Suchleisten, Fehlermeldungen).
- Das fuehrte zu visueller Inkonsistenz und wiederholtem JSX-Code in nahezu allen Modulen.

### Business-Entscheidung
- Einheitlicher Look & Feel ueber alle Kernseiten mit Fokus auf schnelle Orientierung.
- Low-prio Layout-Varianten werden entfernt; stattdessen einheitliche Primitiv-Bausteine fuer wiederkehrende UI-Muster.

### Technische Entscheidung
- Neue wiederverwendbare UI-Primitives:
  - `PageHeader` fuer Titel/Beschreibung/Aktionen.
  - `InlineMessage` fuer neutrale/info/error Hinweise.
  - `SearchField` fuer standardisierte Suche mit integrierter Clear-Interaktion.
- Anwendung auf alle zentralen Seiten (`Dashboard`, `MasterProducts`, `Inventory`, `FBAShipments`, `Purchases`, `Sales`, `CostAllocations`, `Opex`, `Mileage`, `Vat`, `Bank`) in den jeweils passenden Bereichen.
- Dichte Stellen in den Listenoberflaechen werden durch konsistente Filter-/Headerstruktur entschlackt, ohne Kernfunktionen zu aendern.
- `App` nutzt Route-Level Code Splitting (`React.lazy` + `Suspense`), damit grosse Seiten erst bei Navigation geladen werden und Initial-Load leichter bleibt.

## 2026-02-11 - Produktstamm: CSV-Bulk-Import (Paste + Datei)

### Ausgangslage
- Produktstamm-Eintraege mussten einzeln angelegt werden; bei grossen Anlieferungen war das zu langsam und fehleranfaellig.
- Quellen liegen oft bereits als CSV vor oder werden ad-hoc aus Tabellen als CSV-Text kopiert.

### Business-Entscheidung
- Bulk-Import direkt in der Produktstamm-Seite, damit neue Katalogbloecke ohne Umweg in kurzer Zeit angelegt werden koennen.
- Fehlende oder invalide Zeilen duerfen den Gesamtimport nicht blockieren; der Nutzer braucht eine klare Zeilenfehler-Liste.

### Technische Entscheidung
- Neuer Backend-Endpoint `/master-products/bulk-import` mit robuster Header-Normalisierung (DE/EN Aliasnamen), Delimiter-Erkennung und Zeilenvalidierung auf Basis von `MasterProductCreate`.
- Frontend-Dialog in `MasterProducts` mit zwei Eingabepfaden:
  - CSV-Datei laden (liest Dateiinhalt in Textfeld),
  - CSV-Text direkt einfuegen.
- Import-Resultat wird als strukturierte Zusammenfassung angezeigt (`importiert/fehlgeschlagen/leer`) plus aufklappbare Fehlerliste mit Zeilennummern.

## 2026-02-11 - Einkaeufe: Modal-Rework fuer stabile Hoehe/Scroll

### Ausgangslage
- Der Bearbeitungsdialog fuer Einkaeufe wirkte visuell unruhig und produzierte in einzelnen Viewports Overflow/Clipping-Effekte.
- Ursache war eine Mischung aus fixierter Dialoghoehe, mehreren Scroll-Layern und einem Fehlerblock ausserhalb der Footer-Struktur.

### Business-Entscheidung
- Der Bearbeitungsflow muss auf allen typischen Arbeitsflaechen stabil bleiben: klare Kopf-/Inhalts-/Footer-Hierarchie, kein abgeschnittener Content.
- Fokus bleibt auf schnellen Eingaben; Low-prio Kontext bleibt sichtbar, aber ohne Layout-Spruenge.

### Technische Entscheidung
- Dialoglayout auf eine robuste Struktur umgestellt: `Header (fixed) + Content (single scroll region) + Footer (fixed)`.
- Tab-Navigation in einen eigenen Header-Bereich verschoben; Tab-Content nutzt `mt-0`/`min-h-0`, um unnötige Hoeheninflation zu vermeiden.
- Fehleranzeige in den Footer integriert (nicht mehr ausserhalb), damit bei validierungsfehlern kein Overflow mehr entsteht.

## 2026-02-11 - Tabellen-Harmonisierung: Ops-Dichte als Referenz

### Ausgangslage
- Die kompakte `inventory?view=ops`-Tabelle wirkt klarer als andere Zeilenlayouts (`inventory?view=overview`, `master-products`).
- Die anderen Ansichten nutzen mehr uneinheitliche Pills/Meta-Bloecke, was die Scanbarkeit reduziert.

### Business-Entscheidung
- Das kompakte Ops-Muster wird als Standard fuer Zeilenhierarchie genutzt: klarer Primärtext, eine kompakte Meta-Zeile, reduzierte visuelle Nebeninfos.
- Low-prio Infos bleiben erreichbar, aber treten visuell hinter Kerninfos zurueck.

### Technische Entscheidung
- Zeilen in `inventory overview` und `master-products` werden auf konsistente Spacing-/Badge-/Meta-Patterns umgestellt.
- Custom-Pill-Mischformen werden reduziert zugunsten einheitlicher Badge/Text-Muster (gleichere Hoehen, weniger visuelles Rauschen).
- Row-Action-Zellen (`Bearbeiten`/`Aktionen`/`PDF`) erhalten feste Slot-Breiten und einheitliche Button-Hoehen, damit die rechte Tabellenspalte ueber alle Seiten visuell sauber ausgerichtet bleibt.

## 2026-02-11 - Amazon Bild-URL-Fallback fuer stabile Produktbilder

### Ausgangslage
- Amazon-Scrapes liefen wieder an, aber viele frisch gescrapte ASINs hatten weiterhin keine `reference_image_url`.
- Analyse: Der externe Scraper liefert bei erfolgreichen Runs nicht konsistent ein Bildfeld zurueck.

### Business-Entscheidung
- Produktbilder sollen auch dann aktualisiert werden, wenn der Scraper keine explizite Bild-URL liefert.
- Prioritaet ist robuste Datenauffuellung fuer die UI statt perfekter Bildquelle pro Marketplace-Edgecase.

### Technische Entscheidung
- In `persist_scrape_result` wird nach dem normalen Bildfeld-Parsing ein ASIN-basierter Fallback verwendet:
  `https://images-eu.ssl-images-amazon.com/images/P/{ASIN}.01.LZZZZZZZ.jpg`.
- Der Fallback greift nur, wenn keine Bild-URL im Payload gefunden wurde.
- Testabdeckung ergaenzt: neuer Test stellt sicher, dass bei fehlendem Bildfeld der ASIN-Fallback in `MasterProduct.reference_image_url` geschrieben wird.

## 2026-02-11 - Master-Products Amazon-Tabelle entruempelt

### Ausgangslage
- In `/master-products?view=amazon` war die Zeilenhierarchie zu hoch und unruhig: Amazon-Status enthielt zu viele gestapelte Infos, Aktionen lagen im Overflow-Menue (3 Punkte), wichtige KPIs waren nicht direkt als eigene Spalten scanbar.

### Business-Entscheidung
- Primärer Scanflow fuer Reselling: Status, BSR und Used-Best muessen in einer Zeile sofort erfassbar sein.
- Sekundaere/Low-Priority-Infos bleiben vorhanden, aber Details werden klar nach rechts ausgelagert.
- Aktionen sollen ohne Overflow erreichbar sein; Copy-Aktionen fuer ASIN/UUID entfallen in dieser Ansicht.

### Technische Entscheidung
- Desktop-Amazon-Tabelle auf 5 Spalten umgebaut: `Produkt | Amazon Status | BSR | Used best | Details`.
- Amazon-Status-Spalte verschlankt (Badges + letzter Erfolg), BSR und Used-best als getrennte rechtsbuendige Spalten mit `tabular-nums`.
- 3-Punkte-Menu im Amazon-View entfernt; Quick-Links (`Scrape`, `Bearbeiten`, `Löschen`) in die linke Produktspalte verlegt.
- Detail-Toggle in die rechte Spalte verschoben; Expanded-Row `colSpan` entsprechend angepasst.

## 2026-02-11 - Einkaeufe Modal: Combobox-Layering + ruhigere Identitaetssektion

### Ausgangslage
- In der Einkaufsbearbeitung war der Produkt-Combobox-Dropdown in Positionszeilen visuell ausserhalb des Modals und teils nicht klickbar.
- Gleichzeitig wirkte der Block fuer Identitaetsdaten zwischen den Zahlungsfeldern zu dominant/unruhig.

### Business-Entscheidung
- Interaktionen im Modal muessen innerhalb des Modals bleiben und verlässlich klickbar sein.
- Low-prio Felder (Identitaetsdaten) sollen klar de-emphasized sein und nur bei Bedarf erscheinen.

### Technische Entscheidung
- `MasterProductCombobox` portalt sein Dropdown jetzt bevorzugt in den Dialog-Container statt blind in `document.body`; Z-Layer wurde auf `z-[70]` angehoben.
- Ergebnis: Dropdown bleibt im Modal-Interaktionskontext und ist nicht mehr vom Modal-Overlay blockiert.
- Identitaetsdaten-Block in `Purchases` visuell entschlackt: kompakter Header + kleine Toggle-Aktion (`ghost`, `sm`), Felder nur bei Expand sichtbar.

## 2026-02-11 - Master-Produktbilder lokal persistieren statt Remote-Link

### Ausgangslage
- Referenzbilder aus Amazon-Scrapes wurden bisher als externe URL in `reference_image_url` gespeichert.
- Folge: Abhaengigkeit von externen Hosts, instabile Darstellung und kein kontrollierter Datenbestand.

### Business-Entscheidung
- Referenzbilder sollen lokal im App-Storage liegen, damit die Produktansicht stabil und reproduzierbar bleibt.
- Das Overlay-"Oeffnen" auf dem Bild in der Tabelle soll zum Amazon-Listing fuehren (Arbeitsfluss), nicht zur Bilddatei.

### Technische Entscheidung
- Beim erfolgreichen Amazon-Scrape wird die ermittelte Bild-Quelle (Payload oder ASIN-Fallback) serverseitig heruntergeladen und unter `uploads/master-product-reference/` gespeichert.
- In `reference_image_url` wird der lokale relative Storage-Pfad (kein externer URL-Link) persistiert.
- Frontend-Rendering loest lokale Bildpfade ueber einen oeffentlichen Backend-Endpoint (`/public/master-product-images/...`) auf; fuer den Bild-Overlay-Link wird explizit die ASIN-Detailseite verwendet.

## 2026-02-12 - Amazon Scrape Robustheit: leere Success-Payloads duerfen BSR/Offers nicht loeschen

### Ausgangslage
- Produktionsdiagnose zeigte wiederkehrende `429`-Phasen im Scraper plus mehrere Scrape-Runs mit `ok=true`, aber ohne Sales-Ranks und ohne Best-Price-Eintraege.
- Diese Runs wurden als erfolgreicher Snapshot gewertet und konnten bestehende BSR-/Offer-Werte mit leeren Werten (insb. `rank_overall=NULL`, `offers_count_total=0`) ueberschreiben.

### Business-Entscheidung
- Bereits vorhandene Marktsignale (BSR/Offers) haben Vorrang gegenueber "leeren" Success-Payloads.
- Leere/teilweise Scrape-Antworten duerfen vorhandene operative Signale nicht degradieren.

### Technische Entscheidung
- Snapshot-Update fuer BSR erfolgt nur noch, wenn im neuen Payload tatsaechlich ein Rank-Wert vorhanden ist.
- Snapshot-Update fuer Offer-Counts erfolgt nur noch bei nicht-leerer Offer-Liste.
- Regressionstest deckt den Ablauf "gueltiger Scrape -> leerer Success-Scrape" ab und stellt sicher, dass BSR/Offer-Counts erhalten bleiben.

## 2026-02-12 - Amazon Referenzbilder: Retry + sichtbares Fehler-Logging

### Ausgangslage
- Bei instabiler Netzwerk-/DNS-Lage konnten Bilddownloads im Scrape-Persist silently fehlschlagen.
- Folge war fehlende `reference_image_url`, obwohl Scrapes erfolgreich liefen.

### Business-Entscheidung
- Bilddownload-Fehler muessen sichtbar werden (Logs) und bei transienten Fehlern automatisch erneut versucht werden.
- Bestehende Produktdaten sollen bei temporären Netzproblemen robust weiter aufgebaut werden, ohne manuelles Nacharbeiten pro ASIN.

### Technische Entscheidung
- Lokaler Referenzbild-Download nutzt nun bis zu 3 Versuche bei transienten HTTP/Netzwerkfehlern (u. a. Timeout/429/5xx).
- Bei nicht-retrybaren Fehlern, nicht-Bild-Responses oder leerem Body werden strukturierte Warnings mit Produkt-/URL-Kontext geloggt.
- Persist-Pfad loggt explizit, wenn Bildspeicherung final scheitert.

## 2026-02-12 - Produktstamm Amazon-View: Reseller-Targeting ueber BSR + 40-EUR-Preisniveau

### Ausgangslage
- Die Amazon-Tabelle zeigte BSR und Used-best getrennt, aber ohne klare Priorisierung fuer "welches Produkt zuerst sourcen?".
- Fuer Reselling war nicht sofort ersichtlich, welche Kandidaten gleichzeitig gute Nachfrage (niedriger BSR) und attraktives Preisniveau haben.

### Business-Entscheidung
- Die Tabelle wird auf einen klaren Scanflow fuer Sourcing ausgerichtet: zuerst Potenzial, dann Nachfrage (BSR), dann monetaeres Niveau.
- Ein sichtbares Preis-Signal fuer `>= 40 EUR` wird als positive Schwelle verankert, damit hochwertige Targets schneller erkannt werden.

### Technische Entscheidung
- Ein zentrales Potenzial-Scoring im Frontend kombiniert BSR-Klasse und Preis-Signal (inkl. 40-EUR-Schwelle) in eine kompakte Einstufung.
- Desktop-Tabellenspalten im Amazon-View werden auf "Potenzial + BSR + Verkaufspreis" umgebaut; Health-Infos (fresh/stale/blocked) bleiben sekundar.
- Mobile-Karten erhalten denselben Potenzial-Ausweis, damit die Priorisierung auf kleinen Displays ohne Detail-Expand funktioniert.

## 2026-02-12 - MasterProducts Tests: Freshness-Fixture zeitstabil

### Ausgangslage
- Der Test `shows Amazon health in Amazon Status mode...` nutzte einen statischen `amazon_last_success_at` Zeitstempel.
- Mit fortschreitendem Datum fiel die Erwartung `fresh` deterministisch auf `stale` um.

### Business-Entscheidung
- UI-Regressionstests sollen nur Layout-/Verhaltensänderungen spiegeln, nicht vom aktuellen Kalendertag abhängen.

### Technische Entscheidung
- Test-Fixture wurde auf dynamisches `new Date().toISOString()` umgestellt, damit Freshness-Assertion stabil bleibt.

## 2026-02-12 - Frontend Refresh: markantere UI + shadcn-first Konsistenz

### Ausgangslage
- Die App war funktional stabil, wirkte visuell aber sehr neutral/grau und in Teilen uneinheitlich zwischen Seiten.
- UX-Flow war solide, jedoch fehlte eine erkennbare visuelle Identität ueber Navigation, Header und Basiskomponenten hinweg.

### Business-Entscheidung
- Die gesamte Frontend-Oberflaeche soll professioneller und wiedererkennbarer wirken, ohne die bestehende Bedienlogik zu brechen.
- Prioritaet: konsistente Interaktionen (Buttons, Inputs, Tabellen, Dialoge) und klarere visuelle Hierarchie fuer operative Workflows.

### Technische Entscheidung
- Refresh primär ueber gemeinsame shadcn-Bausteine (`Button`, `Card`, `Input`, `Select`, `Table`, `Badge`, `Dialog`, `Dropdown`, `Tabs`) plus Shell (`Topbar`, `PageHeader`, `App`) statt seitenweiser Einzelumbauten.
- Globales Designsystem ueber `index.css`: typografische Identitaet, Farb-/Oberflaechentokens, atmosphaerischer Hintergrund und subtilere Motion.
- Bestehende Page-Implementierungen bleiben weitgehend intakt, profitieren aber sofort vom gemeinsamen Look-and-feel und besserer UX-Konsistenz.

## 2026-02-12 - Einkaufsplattformen kanonisch + Fahrtenbuch editierbar mit OSM-Routenhilfe

### Ausgangslage
- Quelle/Plattform in Einkaeufen erlaubt weiterhin Freitext und erzeugt in der Praxis Dubletten (`kleinanzeigen` vs `Kleinanzeigen`), was Reporting und Filterung verwassert.
- In der Historie ist Plattformtext visuell redundant; gewuenscht ist eine kompaktere, icon-zentrierte Darstellung.
- Fahrtenbuch-Eintraege sind nur neu anlegbar, nicht editierbar. Distanz wird manuell gepflegt statt aus Route berechnet.

### Business-Entscheidung
- Plattformauswahl im Einkauf wird auf feste, kanonische Optionen gefuehrt (kein Freitext-Flow mehr im UI), damit Datenqualitaet und Auswertbarkeit steigen.
- Plattformen sollen in der Historie primar ueber erkennbare Logos/Icons dargestellt werden.
- Fahrtenbuch bekommt einen vollwertigen Bearbeitungsflow und eine offene Karten-/Routing-Hilfe mit Distanzberechnung inkl. optionaler Rueckfahrt.

### Technische Entscheidung
- Bekannte Plattform-Aliase werden serverseitig auf kanonische Labels normalisiert; unbekannte Werte bleiben aus Kompatibilitaetsgruenden zunaechst erhalten.
- Frontend-Purchase-Form entfernt den Custom-Platform-Input und verwendet nur feste Plattformoptionen; Historie rendert Logo-Badges statt Freitext.
- Mileage API erhaelt ein Update-Endpoint (`PUT /mileage/{id}`); Frontend erweitert den Fahrtenbuch-Formflow um Edit-Mode.
- Für Routing/Map wird eine OpenStreetMap-basierte Loesung genutzt (Nominatim Geocoding + OSRM Route + Leaflet-Route-Visualisierung) mit Toggle fuer Hin-/Rueckfahrt und automatischer km-Uebernahme.

## 2026-02-12 - Standard-Pagination fuer alle Hauptlisten (20 pro Seite)

### Ausgangslage
- Mehrere Seiten rendern Historien/Listen aktuell ohne Pagination (nur Suche/Filter), wodurch lange Listen in Mobile/Desktop schnell unhandlich werden.
- Verhalten ist zwischen Seiten inkonsistent (teils harte API-Limits, teils unlimitierte Listen, teils nur visuelle Skeletons).

### Business-Entscheidung
- Fuer alle zentralen Listen-Views gilt ein einheitlicher Default von 20 Eintraegen pro Seite.
- Nutzer sollen auf allen Kernseiten dieselbe Navigation haben (vor/zurueck + Seitenangabe), damit die Bedienung vorhersehbar bleibt.

### Technische Entscheidung
- Shared Pagination-Helfer + UI-Control im Frontend (page-size konstant 20) werden zentral eingefuehrt.
- Die Listen-Views (`MasterProducts`, `Inventory`, `FBAShipments`, `Purchases`, `Sales`, `CostAllocations`, `Opex`, `Mileage`) nutzen dieselbe Pagination-Logik.
- Bei Filter-/Suchwechsel wird auf Seite 1 zurueckgesetzt; Seitennummer wird bei Datenaenderung auf gueltige Grenzen geklemmt.

## 2026-02-12 - Mileage Route-Mode ohne Dropdown (Scroll-Jump vermeiden)

### Ausgangslage
- Im Fahrtenbuch trat beim Oeffnen des Route-Mode-Dropdowns (Einfach vs Hin-/Rueckfahrt) weiterhin ein Viewport-Sprung nach oben auf.
- Der Effekt ist besonders stoerend im langen Formularkontext.

### Business-Entscheidung
- Fuer genau diesen Binär-Entscheid wird kein Dropdown mehr verwendet, sondern ein direkter Umschalter.
- Ziel ist ein stabiler Flow ohne Scroll-Spruenge bei gleicher Funktionalitaet.

### Technische Entscheidung
- Der `Select` fuer Route-Mode in `Mileage` wird durch zwei Toggle-Buttons ersetzt (`Einfach` / `Hin- und Rueckfahrt`).
- Bestehende Distanzlogik bleibt unveraendert; nur das Bedienelement wird getauscht.

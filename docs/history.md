# History

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

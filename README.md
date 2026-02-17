# Kater-Wegscheider Company (AT EPU) – MVP Backend

Lean ERP für Gebrauchtwarenhandel (z.B. Videospiele) mit **FastAPI + PostgreSQL**, integer-basierter Cent-Mathematik, Audit-Log, PDF-Belegen und Docker Compose.

## Runtime Baseline

- Python: `3.11` (CI + Docker baseline; siehe `.python-version`)
- Node: `22` (CI + Docker baseline; siehe `.nvmrc`)

## Quickstart (Docker)

1. `.env` anlegen:
   - `cp .env.example .env`
   - Werte in `.env` anpassen (Basic Auth, Company Daten, DB Credentials).
2. Start:
   - `docker compose up -d --build`
   - optional fuer lokale Backend-Hot-Reloads: `BACKEND_DEV_RELOAD=true`
   - optional fuer Container-Dev-Tooling (inkl. `requirements-dev`): `BACKEND_IMAGE_TARGET=dev`
3. Swagger UI:
   - `http://localhost:18000/docs` (HTTP Basic Auth aus `.env`)

## DB Migrations (Alembic)

- Docker Compose fuehrt Migrationen als dedizierten One-Shot-Service `backend-migrations` aus, bevor `backend` startet.
- Normallauf:
  - `docker compose up -d --build`
- Legacy-Bootstrap (nur fuer bereits befuellte DB ohne `alembic_version`):
  - in `.env` einmalig setzen:
    - `ALEMBIC_BOOTSTRAP_LEGACY=true`
    - `ALEMBIC_BOOTSTRAP_REVISION=e61db2bd6234`
  - danach Stack starten und Bootstrap wieder deaktivieren.

Neue Migration erzeugen:

- `docker compose exec backend alembic -c /app/alembic.ini revision --autogenerate -m "..."` (legt Datei unter `backend/alembic/versions/` an)

## Frontend (Vite + shadcn/ui)

1. `cd frontend`
2. `cp .env.example .env` (optional, default: `http://localhost:18000/api/v1`)
3. `npm install`
4. `npm run dev` → `http://localhost:5173`

Hinweis: Für Browser-Calls muss CORS erlaubt sein. Setze in `.env` (root) z.B.:
- `CORS_ORIGINS=http://localhost:15173,http://localhost:5173`

Alternative via Docker Compose (läuft dauerhaft als Service):
- `docker compose up -d frontend`
- Frontend ist dann über `http://localhost:15173` erreichbar.

## Storage

- PDFs: `./data/pdfs` (wird in den Container als `/data/pdfs` gemountet)
- Uploads (Eingangsbelege): `./data/uploads`
- Backups: `./backups`

## Backup

Manueller Backup-Lauf:

- `chmod +x backup.sh`
- `./backup.sh`

Docker-Backup-Service (täglich per Loop, default 24h):

- In `docker-compose.yml` Service `backup`
- Intervall via `BACKUP_INTERVAL_SECONDS` (siehe `.env.example`)

## Restore (Drill)

Warnung: Das Restore ist destruktiv (DB-Schema wird geloescht und neu erstellt).

- `chmod +x restore.sh`
- `./restore.sh --db backups/db_YYYYMMDD_HHMMSS.sql.gz --files backups/files_YYYYMMDD_HHMMSS.tar.gz`

Backup/Restore-Drill (sicher, nutzt eine temporaere neue DB und laesst die Haupt-DB unangetastet):

- `chmod +x backup_restore_drill.sh`
- `./backup_restore_drill.sh`
- Standard ist strikt (`RESTORE_DRILL_STRICT_ALEMBIC=true`) und failt ohne `alembic_version`.
- Fuer explizite Legacy-Dumps: `./backup_restore_drill.sh --allow-legacy-alembic`

## E2E (Playwright)

Minimaler Smoke-Test im Browser (Login + Dashboard laden):

1. Stack starten: `docker compose up -d --build`
2. E2E ausfuehren:
   - `cd e2e`
   - `npm install`
   - `npx playwright install --with-deps chromium`
   - `npm test`

## Sourcing Live Smoke (Kleinanzeigen)

- Reales Live-Ingestion-Signal (Scraper -> Backend-Persistenz):
  - `cd backend`
  - `RUN_LIVE_KLEINANZEIGEN_TEST=1 pytest -q tests/test_sourcing_live_ingestion.py -s`
- Test startet einen lokalen `sourcing-scraper`-Prozess, zieht echte Listings und validiert, dass sie in `sourcing_items` landen.

## API (V1)

Wichtige Endpoints (Prefix `/api/v1`, alle mit Basic Auth):

- Upload: `POST /uploads`
- Master Products: `POST/GET/PATCH /master-products`
- Purchases: `POST/GET /purchases` (Smart-Split: Summe Lines == Total)
  - Purchase↔Mileage Link: `GET/PUT/DELETE /purchases/{id}/mileage`
- Sourcing Radar:
  - `POST /sourcing/jobs/scrape`
  - `GET /sourcing/health`
  - `GET /sourcing/stats`
  - `GET /sourcing/items`
  - `GET /sourcing/items/{id}`
  - `PATCH /sourcing/items/{id}/matches/{match_id}`
  - `POST /sourcing/items/{id}/conversion-preview`
  - `POST /sourcing/items/{id}/convert`
  - `POST /sourcing/items/{id}/discard`
  - `GET/PUT /sourcing/settings`
- Inventory: `GET /inventory` (Filter: `status`, Suche: `q`)
- FBA Shipments: `POST/GET/PATCH /fba-shipments`, `POST /fba-shipments/{id}/ship`, `POST /fba-shipments/{id}/receive`
- Cost Allocation: `POST/GET /cost-allocations`
- OpEx: `POST/GET /opex`
- Sales: `POST /sales` → `POST /sales/{id}/finalize` (PDF + Status SOLD)
- Returns: `POST /sales/{order_id}/returns` (Korrektur-PDF + Restock/Write-Off)
- Dashboard: `GET /reports/dashboard`
- USt/Vorsteuer Report: `POST /reports/vat`
- Monatsabschluss ZIP: `POST /reports/month-close`

## Notes

- Geldbeträge werden **immer als Integer in Cents** gespeichert (keine Floats).
- PDF-Erstellung via **WeasyPrint** (HTML Templates unter `backend/app/templates`).
- Audit Trail in Tabelle `audit_logs` (Status- und Finanzoperationen).
- Bank-Sync-/Linking-Endpunkte wurden entfernt; `payment_source=BANK` bleibt als manuelle Zahlungsquelle verfügbar.

## Ops / Incident

- Incident-Runbook: `docs/incident-runbook.md`
- Schnellcheck Produktion: `./scripts/prod_health_monitor.sh` (strict Deep-Health-Migrationscheck standardmaessig aktiv)
- Deep Health (DB + Migration-Status): `GET /healthz/deep`
- Amazon-Scraper drosseln (CPU/RAM/PID + slow mode): `./scripts/prod_apply_amazon_scraper_limits.sh`
- Optionaler `agent-browser`-Sidecar ist als Compose-Profil `optional-agent-browser` hinterlegt.
  - Start mit Sidecar: `docker compose --profile optional-agent-browser up -d --build`

## Steuer-Notizen

- Implementationsnotizen zur (Einzel‑)Differenzbesteuerung und USt/Vorsteuer-Logik: `docs/tax.md`

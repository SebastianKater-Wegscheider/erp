# Kater-Wegscheider Company (AT EPU) – MVP Backend

Lean ERP für Gebrauchtwarenhandel (z.B. Videospiele) mit **FastAPI + PostgreSQL**, integer-basierter Cent-Mathematik, Audit-Log, PDF-Belegen und Docker Compose.

## Quickstart (Docker)

1. `.env` anlegen:
   - `cp .env.example .env`
   - Werte in `.env` anpassen (Basic Auth, Company Daten, DB Credentials).
2. Start:
   - `docker compose up -d --build`
3. Swagger UI:
   - `http://localhost:8000/docs` (HTTP Basic Auth aus `.env`)

## Frontend (Vite + shadcn/ui)

1. `cd frontend`
2. `cp .env.example .env` (optional, default: `http://localhost:8000/api/v1`)
3. `npm install`
4. `npm run dev` → `http://localhost:5173`

Hinweis: Für Browser-Calls muss CORS erlaubt sein. Setze in `.env` (root) z.B.:
- `CORS_ORIGINS=http://localhost:5173`

Alternative via Docker Compose (läuft dauerhaft als Service):
- `docker compose up -d frontend`

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

## API (V1)

Wichtige Endpoints (Prefix `/api/v1`, alle mit Basic Auth):

- Upload: `POST /uploads`
- Master Products: `POST/GET/PATCH /master-products`
- Purchases: `POST/GET /purchases` (Smart-Split: Summe Lines == Total)
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

## Steuer-Notizen

- Implementationsnotizen zur (Einzel‑)Differenzbesteuerung und USt/Vorsteuer-Logik: `docs/tax.md`

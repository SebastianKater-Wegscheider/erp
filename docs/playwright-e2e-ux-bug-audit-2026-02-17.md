# Playwright E2E UX + Bug Audit (Production)

Date: 2026-02-17
Target: `http://192.168.178.72:15173`
Method: Manual end-to-end audit via Playwright skill on live environment, route-by-route plus key user flows.
Constraint: Non-mutating test strategy on production DB (open dialogs, inspect, cancel/close; no create/update/delete submits).

## Scope executed

Visited and tested:
- `/dashboard`
- `/master-products`
- `/inventory`
- `/purchases`
- `/sales`
- `/marketplace` (Orders/Apply)
- `/cost-allocations`
- `/opex`
- `/mileage`
- `/vat`
- `/fba-shipments`
- `/sourcing`
- `/sourcing/settings`
- `/sourcing/agents`

UI interactions executed (non-mutating):
- Opened create/edit dialogs in purchases/sales/inventory/fba/opex/mileage/cost allocations and closed without submit.
- Opened marketplace tabs and file-import form without importing.
- Ran VAT calculate action (`POST /reports/vat` read-only compute).
- Inspected sourcing rows, pagination, and action affordances.

Evidence artifacts:
- Snapshots: `.playwright-cli/page-*.yml`
- Network logs: `.playwright-cli/network-*.log`
- Console logs: `.playwright-cli/console-*.log`
- Screenshots: `output/playwright/prod-audit-*.png`

## Findings (risk-first)

### P0

1. **Production frontend is running in Vite dev mode (not production build).**
- Impact: Source exposure, HMR runtime instability, weaker caching/perf profile, higher operational risk.
- Evidence:
  - `curl http://192.168.178.72:15173/` returns `/<@vite/client>` and `/src/main.tsx?t=...` script includes.
  - Console references Vite HMR endpoints: `.playwright-cli/console-2026-02-17T16-59-14-091Z.log:5`
- Recommendation:
  - Serve built static assets only (`npm run build` + static server/reverse proxy).
  - Block deployment if `@vite/client` or `/src/main.tsx` appears in production HTML.

2. **Login is transmitted over plain HTTP.**
- Impact: Credential interception risk on network path.
- Evidence:
  - Browser warning: `.playwright-cli/console-2026-02-17T20-53-46-828Z.log:3`
  - Same warning also in `.playwright-cli/console-2026-02-17T16-53-10-102Z.log:3`
- Recommendation:
  - Enforce HTTPS end-to-end (TLS termination + redirect HTTP->HTTPS + HSTS).

### P1

3. **Auth UX allows entering app shell with invalid credentials (partial login success state).**
- Impact: Confusing operator state, false sense of successful auth, noisy unauthorized API traffic.
- Evidence:
  - App shell visible with nav and dashboard while showing `Invalid credentials`: `.playwright-cli/page-2026-02-17T20-54-06-648Z.yml:35`
  - Unauthorized API calls in same flow: `.playwright-cli/network-2026-02-17T20-54-36-991Z.log:1`
- Recommendation:
  - Keep user on login route until backend-auth check succeeds.
  - Clear app state/session immediately on 401 during bootstrap.

4. **Strong DE/EN language mixing and transliterated German strings reduce UX consistency.**
- Impact: Lower trust/readability for operators; uneven professionalism.
- Evidence:
  - `Quick Actions`: `.playwright-cli/page-2026-02-17T20-54-06-648Z.yml:97`
  - `Import Orders (CSV)`: `.playwright-cli/page-2026-02-17T21-03-52-197Z.yml:41`
  - `Apply READY Orders`: `.playwright-cli/page-2026-02-17T21-04-07-179Z.yml:40`
  - `Choose File`: `.playwright-cli/page-2026-02-17T21-03-52-197Z.yml:56`
  - Transliteration examples (`fuer`, `befuellen`, `spaeter`, `koennen`, `Identitaet`):
    - `.playwright-cli/page-2026-02-17T21-02-09-667Z.yml:360`
    - `.playwright-cli/page-2026-02-17T21-02-55-820Z.yml:66`
    - `.playwright-cli/page-2026-02-17T21-03-52-197Z.yml:68`
- Recommendation:
  - Introduce centralized i18n dictionary and locale lint checks.
  - Normalize umlauts and terminology per domain glossary.

5. **Sourcing list is image-poor on current page, hurting triage speed.**
- Impact: Manual sourcing decisions become text-only and slower; more misclassification risk.
- Evidence:
  - First sourcing page shows `Seite 1 von 7`: `.playwright-cli/page-2026-02-17T21-07-57-606Z.yml:973`
  - Repeated `Kein Bild` rows across page:
    - `.playwright-cli/page-2026-02-17T21-07-57-606Z.yml:246`
    - `.playwright-cli/page-2026-02-17T21-07-57-606Z.yml:268`
    - `.playwright-cli/page-2026-02-17T21-07-57-606Z.yml:510`
- Recommendation:
  - Add scraper-level image fallback/proxy resolution per source.
  - Show strong visual placeholder states (source icon + reason) and prioritize listings with images.

6. **Item-picker tables expose raw UUIDs prominently and include off-domain products in gamecube workflows.**
- Impact: High cognitive load and wrong-item risk during manual operations.
- Evidence:
  - `ID` column first with UUIDs: `.playwright-cli/page-2026-02-17T21-07-27-997Z.yml:89`
  - Off-domain example in same picker: `Canon RF 50mm ... Kamera`: `.playwright-cli/page-2026-02-17T21-07-27-997Z.yml:185`
- Recommendation:
  - Demote UUID to secondary metadata.
  - Add scoped filtering defaults (platform/category relevance) for sourcing/gamecube workflows.

### P2

7. **Marketplace listing titles include low-information placeholders (`Neues Angebot`).**
- Impact: Reduced triage quality and matchability.
- Evidence:
  - `.playwright-cli/page-2026-02-17T21-07-59-672Z.yml:158`
- Recommendation:
  - Add title-quality validation and fallback enrichment (subtitle/source metadata extraction).

8. **Console emits framework migration warnings in runtime (`React Router future flags`).**
- Impact: Not an immediate outage, but signals pending behavior changes and technical debt.
- Evidence:
  - `.playwright-cli/console-2026-02-17T21-07-55-403Z.log:1`
- Recommendation:
  - Opt into/validate v7 future flags in non-prod first, then ship with regression tests.

## Production data safety check

- No intentional persistent writes were executed during this audit.
- Observed mutating network call during this pass: `POST /api/v1/reports/vat => 200` (calculation endpoint).
  - Evidence: `.playwright-cli/network-2026-02-17T20-58-49-952Z.log:2`
- No successful create/update/delete submissions were triggered from tested CRUD dialogs.

## Suggested remediation order

1. P0 infra/security first: serve built frontend + HTTPS enforcement.
2. P1 auth flow correctness: no app-shell routing before backend auth success.
3. P1 UX coherence: i18n/text normalization and sourcing image availability.
4. P1/P2 operational UX: picker simplification (no UUID-first), domain-scoped defaults, title quality controls.

# Tech Review (Risk-First) - 2026-02-17

## Scope and Method
This review covers backend, frontend, migrations/DB, Docker/ops, CI, and test reliability.

Evidence sources used:
- Static architecture/dependency inspection across `backend/`, `frontend/`, `sourcing-scraper/`, `docker-compose.yml`, `.github/workflows/ci.yml`.
- Runtime checks in this environment (2026-02-17):
  - `pytest -q` (backend)
  - `npm test`, `npm run typecheck`, `npm run build` (frontend)
  - `npm install`, `npx playwright test --list` (e2e)
  - Manual Playwright E2E run (`$playwright` skill) against live compose stack for sourcing run/convert/discard + UX gap audit.
  - Automated Playwright E2E reruns with and without explicit credentials to separate environment drift vs product defects.
  - Compose health/log checks
  - Migration checks (`alembic upgrade head`, `check_schema_drift.py`, `check_db_invariants.py`) against fresh and legacy-shaped DB states.

## Baseline Snapshot
- Local runtime: Python `3.14.2` (system), Python `3.12.11` (`.venv`), Node `v25.6.0`, npm `11.8.0`.
- CI runtime: Python `3.11`, Node `22` (`.github/workflows/ci.yml:18`, `.github/workflows/ci.yml:59`, `.github/workflows/ci.yml:97`, `.github/workflows/ci.yml:126`).
- Current compose state: backend is crash-looping, db/frontend/backup are running.
- Backend tests: `118 passed, 1 skipped`.
- Frontend tests: failing (`6 failed, 34 passed`), mostly timeout-driven.
- Frontend typecheck/build: pass.
- E2E setup: dependencies now install; Playwright discovers `5` tests.
- Automated E2E current: `4 passed, 2 failed` when run with local creds (`E2E_USER=admin`, `E2E_PASS=change-me`); default local run fails early with `401` seed setup due credential drift.
- Manual sourcing E2E current: live scrape executed, convert and discard flows functional, but multiple UX/operability gaps found (detailed below).

## Priority Risk Register

### P0-1: Backend unavailable on legacy DB due migration bootstrap gap
- Likelihood: High
- Impact: Critical (API unavailable, production outage risk)
- Evidence:
  - Startup command always runs `alembic upgrade head` before app start (`docker-compose.yml:40`).
  - Compose backend enters restart loop (`docker compose ps` showed `Restarting`).
  - Runtime error is deterministic: `DuplicateTableError: relation "audit_logs" already exists` while baseline migration attempts `CREATE TABLE audit_logs`.
  - Existing DB has baseline-era tables but no `alembic_version` table.
- Why this matters:
  - Any host with pre-Alembic or partially migrated schema cannot boot backend via standard deploy flow.
- Recommendation:
  1. Add explicit bootstrap mode for legacy DBs (preflight script: detect populated schema + missing `alembic_version`, then safe `stamp`).
  2. Split migration and app startup into separate compose steps with clear failure messages.
  3. Add runbook + automated pre-deploy migration check.

### P0-2: Live DB is materially behind model/schema contract
- Likelihood: High
- Impact: Critical (feature regressions, runtime mismatches, data integrity risks)
- Evidence:
  - Legacy DB drift script output shows large divergence (missing newer tables/columns and obsolete bank tables still present).
  - `check_db_invariants.py` fails on current DB with missing enum value `PRIVATE_EQUITY` (`purchase_kind`), expected by application enums (`backend/scripts/check_db_invariants.py:33-47`, `backend/scripts/check_db_invariants.py:77-82`).
  - Current DB table inventory includes deprecated tables (`bank_accounts`, `bank_transactions`, `bank_transaction_purchases`) despite removal migration (`backend/alembic/versions/c4b2d9a3f11e_remove_bank_sync_add_purchase_mileage_link.py`).
- Why this matters:
  - Newer purchase/sourcing/marketplace features rely on schema elements not present in current DB.
- Recommendation:
  1. Execute controlled migration recovery for production DB (backup, stamp baseline if required, migrate to head, run invariants).
  2. Block deploy if drift/invariant checks fail.
  3. Add post-migration smoke checks for critical business flows.

### P1-1: Drift guardrail is noisy even on freshly migrated DB
- Likelihood: High
- Impact: High (false alarms hide real drift)
- Evidence:
  - Fresh DB path: `alembic upgrade head` succeeds to `1d4f7b6c9a21`.
  - Immediately after, `check_schema_drift.py` still reports diffs (index differences + JSON/JSONB type mismatches).
  - Invariant check passes on fresh DB.
- Why this matters:
  - Drift check cannot currently be treated as a strict release gate.
- Recommendation:
  1. Reconcile models vs migrations (JSON/JSONB choices, explicit indexes/constraints).
  2. Tune `check_schema_drift.py` to ignore intentional/portable diffs only.
  3. Keep this gate required once reconciled.

### P1-2: Frontend test reliability is unstable
- Likelihood: High
- Impact: High (release confidence erosion, CI/local inconsistency)
- Evidence:
  - Current run failed with timeout-heavy failures in:
    - `frontend/src/pages/Dashboard.test.tsx:201`
    - `frontend/src/pages/Inventory.test.tsx:153`
    - `frontend/src/pages/Inventory.test.tsx:177`
    - `frontend/src/pages/MasterProducts.test.tsx:118`
    - `frontend/src/pages/MasterProducts.test.tsx:133`
    - `frontend/src/pages/Purchases.test.tsx:78`
  - Multiple React `act(...)` warnings emitted from Radix/UI interactions.
- Why this matters:
  - Test suite currently under-detects/over-flags regressions depending on machine timing.
- Recommendation:
  1. Stabilize async interaction tests (wait-for contracts, deterministic UI state transitions, reduced global side effects).
  2. Increase default timeout for heavy integration-style page tests where justified.
  3. Add targeted CI job rerun-once for flaky test classification until stabilized.

### P1-3: Production deploy path currently uses dev-style runtime flags
- Likelihood: Medium
- Impact: High (performance and reliability drift under production load)
- Evidence:
  - Backend runs `uvicorn ... --reload` in compose (`docker-compose.yml:40`).
  - Frontend container runs `npm install` at startup (`docker-compose.yml:88`).
  - Production deploy process in AGENTS uses this same compose file (`git pull` + `docker compose up -d --build`).
- Why this matters:
  - `--reload` and runtime installs are operationally brittle for production.
- Recommendation:
  1. Introduce separate production compose profile/file.
  2. Remove reload/watch behavior in production startup.
  3. Replace runtime `npm install` with immutable built assets or deterministic `npm ci` during image build.

### P1-4: Migration/DB health is not exposed in operational health endpoint
- Likelihood: High
- Impact: Medium-High (slow incident detection)
- Evidence:
  - `/healthz` only returns static `{"status":"ok"}` (`backend/app/main.py:39-41`).
  - Backend can be fully down due migration errors before app starts; no migration-state telemetry is exposed.
- Why this matters:
  - Ops cannot detect schema compatibility issues via health contract before user-facing impact.
- Recommendation:
  1. Add `/healthz/deep` or extend health to include DB connectivity + migration state checks.
  2. Wire deploy and monitor scripts to fail on migration-state mismatch.

### P1-5: Sourcing feed truncates actionable dataset (100 shown vs larger total)
- Likelihood: High
- Impact: High (operators can miss opportunities)
- Evidence:
  - Frontend hardcodes `limit=100` and `offset=0` for sourcing list requests (`frontend/src/pages/Sourcing.tsx:82-83`).
  - Backend supports pagination and returns `total` + `limit` + `offset` (`backend/app/api/v1/endpoints/sourcing.py:174-243`).
  - Live Playwright snapshot after scrape shows `Total: 177 • READY: 0`, but exactly `100` visible cards (`button "Details"` occurrences) with no pagination/load-more control in viewport-bottom snapshot (`output/playwright/sourcing-phase2-20260217/.playwright-cli/page-2026-02-17T12-10-37-520Z.yml`).
- Why this matters:
  - Review users can assume full coverage while 77 items are not visible in the default UI state.
- Recommendation:
  1. Add explicit pagination or infinite loading with `offset` progression.
  2. Display "loaded/total" to prevent false completeness assumptions.
  3. Add E2E assertion for total-to-render consistency.

### P1-6: Sourcing detail actions violate state contract and surface conflicts poorly
- Likelihood: High
- Impact: High (operator confusion, repeated failed actions)
- Evidence:
  - Detail page always renders `Purchase erstellen` / `Verwerfen` for non-ready states (`frontend/src/pages/SourcingDetail.tsx:245-254`).
  - Backend intentionally returns `409` for invalid conversions (`backend/app/api/v1/endpoints/sourcing.py:386-419`, `backend/app/services/sourcing.py:782-785`).
  - Live Playwright network log captured `POST /sourcing/items/{converted-id}/convert => 409 Conflict` after user clicks enabled button; no visible inline error rendered for convert/discard failures (`output/playwright/sourcing-phase2-20260217/.playwright-cli/network-2026-02-17T12-09-36-540Z.log`).
- Why this matters:
  - Users can trigger invalid operations from states that should be read-only or explicitly blocked in UI.
- Recommendation:
  1. Gate actions by item status in UI (`READY` only for convert, hide/disable discard once discarded).
  2. Add inline error messaging for mutation failures (`convert.error`, `discard.error`).
  3. Add idempotency tests for repeated conversion/discard clicks.

### P1-7: Automated E2E suite still has deterministic fragility points
- Likelihood: High
- Impact: High (CI confidence gaps on critical flows)
- Evidence:
  - With local credential contract aligned, current run is `4 passed, 2 failed` (`e2e`: `marketplace.spec.ts`, `sales.spec.ts`).
  - Marketplace failure is a strict-mode locator ambiguity on `getByText("READY")` (two matches).
  - Sales failure is a 60s timeout waiting/filling buyer name field in create-order dialog.
  - Without explicit credential alignment, the same suite fails early with `401` in API seed helper defaults.
- Why this matters:
  - E2E signal quality is environment-sensitive and currently under-protects two high-value flows.
- Recommendation:
  1. Enforce explicit E2E auth env contract in local+CI docs/scripts.
  2. Replace ambiguous text selectors with role-scoped locators.
  3. Harden sales dialog synchronization before fill/assert actions.

### P2-1: Complexity hotspots increase regression probability
- Likelihood: High
- Impact: Medium-High (future change friction)
- Evidence:
  - Very large files:
    - `frontend/src/pages/Purchases.tsx` (3098 LOC)
    - `frontend/src/pages/MasterProducts.tsx` (2421 LOC)
    - `frontend/src/pages/Inventory.tsx` (2192 LOC)
    - `backend/app/services/reports.py` (1374 LOC)
    - `backend/app/services/purchases.py` (1320 LOC)
    - `backend/app/services/sourcing.py` (1280 LOC)
- Why this matters:
  - These files combine orchestration, state transitions, formatting, and UI/business concerns, making safe refactors harder.
- Recommendation:
  1. Slice by domain concerns (query layer, policy/service layer, pure utility layer, presentational components).
  2. Enforce per-file complexity/size budgets for new work.

### P2-2: Redundant frontend helpers indicate copy-paste drift
- Likelihood: High
- Impact: Medium
- Evidence:
  - Near-identical localStorage + clipboard helper implementations appear in:
    - `frontend/src/pages/Inventory.tsx:168-216`
    - `frontend/src/pages/MasterProducts.tsx:607-655`
  - Repeated label/variant helper patterns across multiple pages.
- Why this matters:
  - Behavior diverges over time and increases test burden.
- Recommendation:
  1. Centralize shared browser helpers in `frontend/src/lib/`.
  2. Add focused unit tests for these shared utilities.

### P2-3: Broad exception handling obscures failure modes
- Likelihood: Medium
- Impact: Medium
- Evidence:
  - Silent exception swallowing in critical cleanup paths (`backend/app/services/purchases.py:210-214`, `backend/app/services/purchases.py:990-995`).
  - Scheduler loops catch broad exceptions and continue (`backend/app/services/sourcing_scheduler.py:112-114`, `backend/app/services/amazon_scrape_scheduler.py:188-189`).
- Why this matters:
  - Errors can be hidden until business symptoms appear.
- Recommendation:
  1. Replace blanket catches with typed exception handling where possible.
  2. Emit structured error metrics/log fields for every caught exception path.

### P2-4: Coverage asymmetry on API surface
- Likelihood: Medium
- Impact: Medium
- Evidence:
  - Backend exposes 93 API routes.
  - Frontend exposes 16 routed pages (`frontend/src/App.tsx:38-53`).
  - E2E currently covers 5 tests across 3 specs (marketplace, purchases, smoke).
  - Backend test suite is strong in service logic (106 tests), but endpoint-level HTTP coverage is limited and concentrated.
- Why this matters:
  - Wiring regressions across HTTP contracts can slip past service-heavy tests.
- Recommendation:
  1. Add endpoint contract tests for high-change domains (`sourcing`, `purchases`, `inventory`, `marketplace`).
  2. Expand e2e to cover sourcing and sales finalize/return flows.

### P2-5: Backend container includes dev dependencies in runtime image
- Likelihood: High
- Impact: Medium (image size and attack surface)
- Evidence:
  - Backend image installs both prod and dev requirements (`backend/Dockerfile:25-27`).
- Why this matters:
  - Larger image, longer build times, unnecessary prod footprint.
- Recommendation:
  1. Use multi-stage or separate prod/dev images.
  2. Install only `requirements.txt` in production image.

### P2-6: Sourcing imagery is available in API but absent from review UI
- Likelihood: High
- Impact: Medium-High (decision quality + review speed)
- Evidence:
  - List/detail contracts include `primary_image_url` / `image_urls` (`frontend/src/pages/Sourcing.tsx:25`, `frontend/src/pages/SourcingDetail.tsx:44`, `backend/app/api/v1/endpoints/sourcing.py:227`, `backend/app/api/v1/endpoints/sourcing.py:289`).
  - Current list/detail rendering does not display listing thumbnails or gallery, including seeded "ohne Bilder" validation cases.
- Why this matters:
  - Operators cannot quickly validate listing condition/completeness, increasing misclassification risk.
- Recommendation:
  1. Render thumbnail preview in list cards with fallback placeholder.
  2. Add detail gallery with image count and "no image" warning badge.

### P2-7: Match-action buttons are icon-only without explicit labels
- Likelihood: High
- Impact: Medium (accessibility and test robustness)
- Evidence:
  - Match row action buttons render only `<Check />` / `<X />` icons without visible text or explicit aria-labels (`frontend/src/pages/SourcingDetail.tsx:317-332`).
  - Playwright snapshot exposes unnamed action buttons in match table.
- Why this matters:
  - Reduced accessibility and brittle selector strategy in E2E.
- Recommendation:
  1. Add clear text or `aria-label` attributes for confirm/reject actions.
  2. Standardize resilient selectors (`getByRole` with exact names) in E2E.

### P3-1: Restore drill allows no-Alembic state as informational
- Likelihood: Medium
- Impact: Low-Medium (can normalize stale migration posture)
- Evidence:
  - Script treats missing `alembic_version` as note, not failure (`backup_restore_drill.sh:150-156`).
- Why this matters:
  - Backup validation can pass while deploy path still fails on migration bootstrap.
- Recommendation:
  1. Add strict mode to require valid Alembic state for modern environments.

## Redundancies and Dead-Ends Summary
- Confirmed redundancies:
  - Duplicated clipboard/storage/view-mode helper logic in major frontend pages.
- Confirmed dead-end/legacy burden:
  - Legacy bank-sync tables persist in live DB while feature was removed by migration lineage.
  - Legacy mileage compatibility path remains (`purchase_id` fallback + join-table model), increasing complexity until migration closure.
- Potential dead-end risk:
  - Drift script currently noisy enough that teams may start ignoring it.

## Route-to-Test Coverage Matrix (Current)
| Domain | API Routes | Backend Test Strength | Frontend Page Tests | E2E | Risk Note |
|---|---:|---|---|---|---|
| sourcing | 17 | good service/scheduler coverage | minimal UI tests | none | high contract/integration gap |
| purchases | 15 | strong business-flow coverage | 1 unstable page test | 3 tests | UI reliability gap |
| sales | 11 | covered in flow tests | none | none | finalize/returns not e2e-covered |
| inventory | 9 | target-pricing + queue coverage | 3 unstable tests | none | high-change area, flaky tests |
| marketplace | 7 | import/apply/payout tests | none | 1 test | moderate |
| master products | 6 | import/filter coverage | 8 tests (some flaky) | none | moderate |
| reports | 5 | strong reporting tests | dashboard test flaky | smoke only | moderate |
| files/uploads | 2 | files tested, uploads weak | none | none | upload contract risk |

## Acceptance Gate Status (from requested scenarios)
1. Legacy DB startup compatibility: **FAIL** (backend crash-loop).
2. Fresh DB migration to head: **PASS**.
3. Drift/invariant checks after migration flow: **FAIL** (drift script fails even on fresh DB; invariants fail on current legacy DB).
4. Frontend reliability: **FAIL** (timeouts/flakiness).
5. E2E readiness: **PARTIAL** (suite executes end-to-end; local credential drift can cause early `401` failures if env contract is not aligned; with correct creds, 4/6 pass).
6. Critical flow validation end-to-end: **PARTIAL** (purchases flows pass, sourcing run/convert/discard manually verified, but sales/marketplace still have failing automated scenarios).
7. Backup/restore drill robustness vs migration metadata: **PARTIAL** (script permits legacy no-Alembic state).
8. Security hygiene: **PARTIAL** (no tracked `.env` now, but runtime/prod hardening gaps remain).

## Immediate Next Actions (Order)
1. Recover migration state and backend availability on production-like DB (P0).
2. Fix drift baseline so `check_schema_drift.py` becomes trustworthy (P1).
3. Stabilize frontend tests and pin local runtimes to CI contract (P1).
4. Separate prod compose/runtime behavior from development defaults (P1).
5. Start modularization + helper dedupe work in highest-churn frontend/backend files (P2).

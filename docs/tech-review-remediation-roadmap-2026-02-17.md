# Remediation Roadmap - Tech Review (2026-02-17)

## Objective
Restore production continuity first, then stabilize release quality, then harden architecture and operational guardrails.

## Principles
- P0 continuity before feature work.
- Every phase has explicit test gates.
- Changes are deployable in small slices.
- New guardrails must be automated in CI/CD.

## Phase 0 - Hotfix (0-2 days)
Goal: recover backend availability and establish safe migration posture.

### Work Items
1. Migration bootstrap compatibility
- Add explicit bootstrap entrypoint that:
  - Detects populated schema + missing `alembic_version`.
  - Requires operator-confirmed stamp target.
  - Executes `alembic stamp <rev>` then `alembic upgrade head`.
- Estimated effort: M (0.5-1 day)
- Target files:
  - `docker-compose.yml`
  - new script under `backend/scripts/` (migration preflight/bootstrap)
  - deployment docs/runbook.

2. Backend startup decoupling
- Split migration from app launch in deploy flow.
- App start should not silently loop forever on migration failure.
- Estimated effort: S (2-4 hours)

3. DB state recovery on current environment
- Snapshot DB and files.
- Run controlled recovery (stamp + migrate).
- Validate enums and schema checks post-recovery.
- Estimated effort: M (0.5 day)

4. Migration state observability
- Add migration-state check to health (deep health or dedicated endpoint).
- Estimated effort: S (2-4 hours)

### Phase 0 Test Gates (must pass)
1. Legacy DB startup scenario
- From baseline-shaped DB without `alembic_version`, backend reaches healthy state via bootstrap workflow.
2. Fresh DB migration scenario
- `alembic upgrade head` passes on empty DB.
3. Invariant scenario
- `python backend/scripts/check_db_invariants.py` passes post-migration.
4. Compose health scenario
- `docker compose ps` shows backend stable (not restarting).

## Phase 1 - Stabilization (3-10 days)
Goal: re-establish trustworthy CI signals and deterministic local/CI parity.

### Work Items
1. Schema drift reconciliation
- Resolve current drift mismatches that appear even on fresh DB:
  - index expectations
  - JSON vs JSONB normalization
  - constraint/index generation consistency
- Keep `check_schema_drift.py` strict once clean.
- Estimated effort: M-L (1-2 days)

2. Frontend test stabilization
- Fix failing timeout tests and remove brittle async assumptions in:
  - `frontend/src/pages/Dashboard.test.tsx`
  - `frontend/src/pages/Inventory.test.tsx`
  - `frontend/src/pages/MasterProducts.test.tsx`
  - `frontend/src/pages/Purchases.test.tsx`
- Add deterministic helpers for UI interactions with Radix and async query state.
- Estimated effort: M (1-2 days)

3. Runtime parity codification
- Pin and document local runtime contract to CI versions.
- Add version files/tooling (`.nvmrc`, `.python-version` or equivalent).
- Update README for exact local setup.
- Estimated effort: S (2-4 hours)

4. Production compose hygiene
- Remove dev-only runtime behavior from production path:
  - no `--reload`
  - no runtime `npm install`
- Keep a dedicated dev profile preserving current DX behavior.
- Estimated effort: M (0.5-1 day)

### Phase 1 Test Gates (must pass)
1. `pytest -q` passes.
2. `npm run typecheck`, `npm test`, `npm run build` pass consistently on pinned runtime.
3. `check_schema_drift.py` and `check_db_invariants.py` both pass on fresh migrated DB.
4. E2E smoke run passes (`smoke`, `purchases`, `marketplace` minimum).

## Phase 2 - Hardening (2-6 weeks)
Goal: reduce long-term regression risk and maintenance cost.

### Work Items
1. Frontend internal interface cleanup (dedupe)
- Extract duplicated localStorage/clipboard/view-state helpers into shared modules under `frontend/src/lib/`.
- Consolidate repeated label/variant mapping helpers.
- Estimated effort: M (2-4 days, incremental)

2. Large-module decomposition
- Prioritize by size/churn:
  - `frontend/src/pages/Purchases.tsx`
  - `frontend/src/pages/MasterProducts.tsx`
  - `frontend/src/pages/Inventory.tsx`
  - `backend/app/services/reports.py`
  - `backend/app/services/purchases.py`
  - `backend/app/services/sourcing.py`
- Split into smaller, typed modules with pure-function seams.
- Estimated effort: L (2-4 weeks incremental)

3. Exception-handling hardening
- Replace blanket catches with typed exceptions where practical.
- Add structured logging/metrics for all catch-and-continue paths.
- Estimated effort: M (3-5 days)

4. API contract and E2E expansion
- Add endpoint-level tests for high-change surfaces (`sourcing`, `purchases`, `inventory`, `marketplace`, `sales`).
- Expand e2e coverage for sourcing + sales finalize/returns.
- Estimated effort: M-L (1-2 weeks)

5. Runtime image hardening
- Split prod/dev dependencies for backend image.
- Reduce image footprint and attack surface.
- Estimated effort: S-M (0.5-1 day)

6. Backup/restore and migration state tightening
- Add strict drill mode requiring valid Alembic state for modern deployments.
- Estimated effort: S (2-4 hours)

### Phase 2 Test Gates (must pass)
1. Route-to-test matrix for all critical domains has explicit coverage owner and minimum test count.
2. E2E includes coverage for:
- login/dashboard
- purchases + mileage
- marketplace import/apply
- sourcing run/convert/discard
- sales finalize + return
3. Operational checks detect migration mismatch pre-deploy.

## Public API / Interface / Type Changes to Implement
1. Startup/migration interface
- New bootstrap/preflight command and explicit migration-state contract.

2. Operational health interface
- Health endpoint includes DB + migration-state status (or dedicated deep health endpoint).

3. Tooling/runtime interface
- Explicit local runtime pins aligned to CI.

4. Frontend internal interfaces
- Shared clipboard/storage/view-mode utility API used by pages.

5. Test contracts
- Standardized async UI testing harness and timeout policy for integration-like page tests.

## Ownership and Sequencing
1. Backend/DB owner
- Phase 0 migration recovery + health checks.
2. Frontend owner
- Phase 1 test stabilization + helper extraction start.
3. DevOps/Platform owner
- production compose split + runtime pinning + CI gates.
4. Cross-functional
- Phase 2 module decomposition and coverage expansion.

## Rollout Strategy
1. Deploy Phase 0 behind maintenance window and verified backups.
2. Run Phase 1 in short-lived branches with strict CI blocking.
3. Roll out Phase 2 incrementally by domain, never as a single mega-refactor.

## Success Criteria (Quantitative)
- Backend restart loops from migration issues: 0.
- Drift/invariant gate false positives on fresh DB: 0.
- Frontend flaky timeout failures in CI over 10 consecutive runs: 0.
- Critical domain E2E coverage: all required flows green.
- Largest page/service files reduced below agreed thresholds (target: <1500 LOC per high-churn file).

# Route-to-Test Coverage Matrix (Phase 2 Hardening)

Stand: 2026-02-17

## Ziel
- Kritische Domains bekommen explizite Test-Eigentuemer und Mindestabdeckung.
- Fokus: API-Vertraege + End-to-End Kernpfade.

## Matrix
| Domain | Kritische Flows | Owner | Aktuelle Backend-Tests | Aktuelle Frontend-Tests | Aktuelle E2E-Tests | Mindestziel Backend | Mindestziel E2E |
|---|---|---|---:|---:|---:|---:|---:|
| purchases | create/update/delete, mileage link, PDF | Backend | 29 (`test_purchase_sales_flows.py`, `test_purchase_mileage_link.py`, `test_purchase_evidence_images.py`) | 1 (`Purchases.test.tsx`) | 3 (`purchases.spec.ts`) | 30 | 4 |
| sales | draft/finalize/reopen/return | Backend | 21 (`test_purchase_sales_flows.py`) | 0 | 1 (`sales.spec.ts`) | 24 | 2 |
| inventory | queues, target pricing, item code search | Backend | 9 (`test_inventory_work_queues.py`, `test_inventory_target_pricing.py`, `test_inventory_item_code_search.py`) | 3 (`Inventory.test.tsx`) | 0 | 12 | 1 |
| marketplace | order import/apply, payout import | Backend | 5 (`test_marketplace_order_import_apply.py`, `test_marketplace_payout_import.py`) | 0 | 1 (`marketplace.spec.ts`) | 8 | 2 |
| sourcing | scrape/analyze/convert/discard, scheduler agents | Backend | 14 (`test_sourcing_flows.py`, `test_sourcing_scheduler_agents.py`) | 0 | 0 | 16 | 1 |
| reports/dashboard | company dashboard, VAT/reporting flows | Backend | 9 (`test_ops_reporting_flows.py`) | 1 (`Dashboard.test.tsx`) | 1 (`smoke.spec.ts`) | 10 | 1 |

## Luecken (priorisiert)
1. Sourcing hat noch keine E2E-Abdeckung fuer run/convert/discard.
2. Inventory hat noch keinen dedizierten E2E-Smoke fuer Status-/Pricing-UI.
3. Marketplace hat erst einen happy-path E2E und braucht Error-/edge-path.

## Phase-2 Gate-Regel
- Jede Domain braucht:
  - zugewiesenen Owner
  - dokumentiertes Backend-Minimum
  - dokumentiertes E2E-Minimum
- CI darf bei Reduktion unter das dokumentierte Minimum nicht stillschweigend erweitert/veraendert werden.

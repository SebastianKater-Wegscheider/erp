# PRD: Sourcing Inbox with Codex Evaluation

## Summary
- The ERP is responsible for scraping, storing, enriching, and presenting sourcing listings.
- Codex is responsible for evaluating attractiveness, matching against ERP knowledge, and calculating expected profit, ROI, and max buy price.
- The sourcing UI is an operator inbox, not an internal valuation engine.

## Product goals
- Persist reliable listing snapshots from `KLEINANZEIGEN` and `EBAY_DE`.
- Automatically queue each new listing for Codex evaluation.
- Show operators the raw listing plus a structured Codex verdict.
- Keep the handoff into purchases manual for now.

## Responsibilities
### ERP
- Scrape and detail-enrich listings.
- Store raw and normalized listing data.
- Stage compact evaluation packets for Codex.
- Persist Codex responses, queue state, and retry state.
- Provide filters and review tools in the sourcing UI.

### Codex
- Read the ERP-provided local evaluation packet.
- Use ERP candidate and cached Amazon data first.
- Use live Amazon lookup only when ERP evidence is insufficient or stale.
- Return structured JSON with recommendation, evidence, and profitability estimates.

## Evaluation contract
### Input
- `summary.json`
  compact normalized listing data, ERP-prepared candidate context, cached Amazon context, and cost assumptions.
- `full.json`
  complete raw listing payload, full description, detail enrichment data, image URLs, and debug metadata.
- `schema.json`
  required output schema.
- `prompt.txt`
  fixed instructions telling Codex to avoid marketplace re-fetches and only use Amazon web fallback if necessary.

### Output
- `recommendation`
  one of `BUY`, `WATCH`, `SKIP`, `NEEDS_REVIEW`
- `summary`
- `expected_profit_cents`
- `expected_roi_bp`
- `max_buy_price_cents`
- `confidence`
- `amazon_source_used`
- `matched_products`
- `risks`
- `reasoning_notes`

## Operator workflow
1. Scheduler or manual trigger scrapes listings.
2. Backend enriches each new listing and queues it for Codex.
3. Codex evaluates the listing asynchronously.
4. Operator reviews the verdict in the sourcing inbox.
5. Operator either discards the listing, re-runs evaluation, or manually creates a purchase elsewhere.

## Non-goals
- No internal fuzzy-match driven attractiveness scoring in ERP.
- No sourcing-side conversion preview or auto-purchase draft creation.
- No Bidbag integration.
- No second frontend implementation.

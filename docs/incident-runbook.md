# Production Incident Runbook

## Scope
- ERP stack: `/home/seb/kater-wegscheider-company`
- Amazon scraper stack: `/home/seb/amazon-scraper`
- Sourcing scraper stack: `/home/seb/kater-wegscheider-company` (compose services `sourcing-scraper`, `agent-browser`)
- Host: `seb@192.168.178.72`

## 1) Fast triage (2-3 minutes)
Run from local machine:

```bash
./scripts/prod_health_monitor.sh
```

Key signals:
- `healthz` timeout on `:18000` + frontend timeout on `:15173`
- `docker compose ps` shows unhealthy/restarting services
- warnings in docker journal: `health check timed out`, `dns ... i/o timeout`

## 2) Immediate recovery
### ERP stack
```bash
ssh seb@192.168.178.72 'cd /home/seb/kater-wegscheider-company && docker compose up -d --build && docker compose ps'
```

### Amazon scraper stack
```bash
ssh seb@192.168.178.72 'cd /home/seb/amazon-scraper && docker compose up -d --build && docker compose ps'
```

### Sourcing scraper services (same ERP compose)
```bash
ssh seb@192.168.178.72 'cd /home/seb/kater-wegscheider-company && docker compose up -d --build sourcing-scraper agent-browser && docker compose ps'
```

If both fail to respond and SSH is unstable, reboot host (already validated as effective fallback), then rerun both commands.

## 3) Stabilize load (scraper slow mode + limits)
Apply conservative limits and delays:

```bash
./scripts/prod_apply_amazon_scraper_limits.sh
```

Defaults applied by script:
- `cpus=1.00`
- `mem_limit=1024m`
- `mem_reservation=512m`
- `pids_limit=128`
- `SCRAPER_MIN_DELAY_NAV=4.0`
- `SCRAPER_MAX_DELAY_NAV=8.0`
- `SCRAPER_MAX_OFFER_PAGES=8`

## 4) Root-cause evidence collection
On host:

```bash
journalctl -b -u docker --no-pager | egrep -i 'health check|timed out|dns|i/o timeout|failed' | tail -n 120
journalctl -b -k --no-pager | egrep -i 'oom|hung task|blocked for more than|nvme|ext4|I/O error' | tail -n 120
docker stats --no-stream
```

DB pressure hints:
- long checkpoints
- autovacuum warnings (`autovacuum worker took too long to start`)
- startup recovery logs after abrupt interruption

## 5) Post-incident hardening checklist
- Keep scraper in slow mode for production stability.
- Keep ERP scraper scheduler conservative (see `.env` values):
  - `AMAZON_SCRAPER_LOOP_TICK_SECONDS=180`
  - `AMAZON_SCRAPER_MIN_SUCCESS_INTERVAL_SECONDS=172800`
  - `AMAZON_SCRAPER_MAX_BACKOFF_SECONDS=43200`
- Re-check app health via `./scripts/prod_health_monitor.sh`.

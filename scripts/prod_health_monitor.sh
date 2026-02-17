#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-192.168.178.72}"
SSH_USER="${SSH_USER:-seb}"
SSH_TARGET="${SSH_USER}@${HOST}"
CURL_TIMEOUT_SECONDS="${CURL_TIMEOUT_SECONDS:-10}"

echo "== Prod Health @ ${HOST} =="
date -u +"UTC %Y-%m-%d %H:%M:%S"

echo
echo "-- HTTP checks --"
curl -sS --max-time "${CURL_TIMEOUT_SECONDS}" -w "backend healthz: %{http_code} in %{time_total}s\n" -o /tmp/erp_healthz.json "http://${HOST}:18000/healthz"
cat /tmp/erp_healthz.json
echo
if curl -sS --max-time "${CURL_TIMEOUT_SECONDS}" -w "backend deep healthz: %{http_code} in %{time_total}s\n" -o /tmp/erp_healthz_deep.json "http://${HOST}:18000/healthz/deep"; then
  cat /tmp/erp_healthz_deep.json
else
  echo "backend deep healthz: WARN (unavailable)"
fi
echo
curl -sS -I --max-time "${CURL_TIMEOUT_SECONDS}" -w "frontend root: %{http_code} in %{time_total}s\n" -o /tmp/erp_front_headers.txt "http://${HOST}:15173/"
head -n 1 /tmp/erp_front_headers.txt
if ssh -o ConnectTimeout=10 "${SSH_TARGET}" "cd /home/seb/amazon-scraper && docker compose exec -T backend python -c \"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:4236/healthz', timeout=5).read().decode())\"" >/tmp/scraper_health_payload.txt 2>/tmp/scraper_health_err.txt; then
  sed 's/^/scraper healthz (internal): /' /tmp/scraper_health_payload.txt
else
  echo "scraper healthz (internal): WARN (temporarily unavailable)"
  tail -n 2 /tmp/scraper_health_err.txt | sed 's/^/  /'
fi

echo
echo "-- Host + resources --"
ssh -o ConnectTimeout=10 "${SSH_TARGET}" "hostname; uptime; free -h | sed -n '1,2p'; df -h /"

echo
echo "-- ERP compose --"
ssh -o ConnectTimeout=10 "${SSH_TARGET}" "cd /home/seb/kater-wegscheider-company && docker compose ps"

echo
echo "-- Amazon scraper compose --"
ssh -o ConnectTimeout=10 "${SSH_TARGET}" "cd /home/seb/amazon-scraper && docker compose ps"

echo
echo "-- Docker top consumers --"
ssh -o ConnectTimeout=10 "${SSH_TARGET}" "docker stats --no-stream | sed -n '1,10p'"

echo
echo "-- Recent warning signals (current boot) --"
ssh -o ConnectTimeout=10 "${SSH_TARGET}" "journalctl -b -u docker --no-pager | egrep -i 'health check|timed out|dns|i/o timeout|failed' | tail -n 30 || true"

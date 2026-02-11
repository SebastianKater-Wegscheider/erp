#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-192.168.178.72}"
SSH_USER="${SSH_USER:-seb}"
SSH_TARGET="${SSH_USER}@${HOST}"
SCRAPER_DIR="${SCRAPER_DIR:-/home/seb/amazon-scraper}"

CPU_LIMIT="${CPU_LIMIT:-1.00}"
MEM_LIMIT="${MEM_LIMIT:-1024m}"
MEM_RESERVATION="${MEM_RESERVATION:-512m}"
PIDS_LIMIT="${PIDS_LIMIT:-128}"

MIN_DELAY_NAV="${MIN_DELAY_NAV:-4.0}"
MAX_DELAY_NAV="${MAX_DELAY_NAV:-8.0}"
MAX_OFFER_PAGES="${MAX_OFFER_PAGES:-8}"

echo "Applying conservative amazon-scraper limits on ${SSH_TARGET} ..."

ssh -o ConnectTimeout=10 "${SSH_TARGET}" "set -euo pipefail
cd ${SCRAPER_DIR}
ts=\$(date +%Y%m%d_%H%M%S)
cp docker-compose.yml docker-compose.yml.bak.\${ts}
cat > docker-compose.yml <<'YAML'
services:
  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    ports:
      - \"192.168.178.72:4236:4236\"
    environment:
      - SCRAPER_PROFILE=/data/agent-browser/profiles/amazon-de
      - SCRAPER_ZIP=80331
      - SCRAPER_MIN_DELAY_NAV=${MIN_DELAY_NAV}
      - SCRAPER_MAX_DELAY_NAV=${MAX_DELAY_NAV}
      - SCRAPER_MAX_OFFER_PAGES=${MAX_OFFER_PAGES}
    volumes:
      - ./.agent-browser:/data/agent-browser
    restart: unless-stopped
    cpus: \"${CPU_LIMIT}\"
    mem_limit: ${MEM_LIMIT}
    mem_reservation: ${MEM_RESERVATION}
    pids_limit: ${PIDS_LIMIT}

  frontend:
    build:
      context: .
      dockerfile: frontend/Dockerfile
    ports:
      - \"192.168.178.72:8381:8381\"
    depends_on:
      - backend
    restart: unless-stopped
YAML

docker compose up -d --build
docker compose ps
"

echo
echo "Verifying scraper backend health from inside container ..."
ssh -o ConnectTimeout=10 "${SSH_TARGET}" "set -euo pipefail
cd ${SCRAPER_DIR}
ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if docker compose exec -T backend python -c \"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:4236/healthz', timeout=5).read().decode())\" >/tmp/scraper_health.txt 2>/dev/null; then
    ok=1
    echo \"health_ok_attempt=\$i\"
    cat /tmp/scraper_health.txt
    break
  fi
  sleep 3
done
if [ \"\$ok\" -ne 1 ]; then
  echo 'scraper backend health check failed after retries' >&2
  docker compose logs --tail=120 backend
  exit 1
fi
"
echo "Done."

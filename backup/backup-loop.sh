#!/usr/bin/env bash
set -euo pipefail

interval="${BACKUP_INTERVAL_SECONDS:-86400}"

while true; do
  /app/backup.sh || true
  sleep "${interval}"
done


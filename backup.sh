#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
DATA_DIR="${DATA_DIR:-${ROOT_DIR}/data}"
TIMESTAMP="$(date +"%Y%m%d_%H%M%S")"

mkdir -p "${BACKUP_DIR}"

DB_DUMP_PATH="${BACKUP_DIR}/db_${TIMESTAMP}.sql.gz"
FILES_ARCHIVE_PATH="${BACKUP_DIR}/files_${TIMESTAMP}.tar.gz"

dump_via_compose() {
  docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip >"${DB_DUMP_PATH}"
}

dump_direct() {
  : "${PGHOST:?PGHOST is required for direct pg_dump}"
  : "${PGUSER:?PGUSER is required for direct pg_dump}"
  : "${PGDATABASE:?PGDATABASE is required for direct pg_dump}"

  pg_dump | gzip >"${DB_DUMP_PATH}"
}

if command -v docker >/dev/null 2>&1 && command -v docker-compose >/dev/null 2>&1; then
  # Prefer legacy docker-compose if available (some hosts still use it).
  dump_via_compose() {
    docker-compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip >"${DB_DUMP_PATH}"
  }
fi

if command -v docker >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1 || docker compose version >/dev/null 2>&1; then
    if (cd "${ROOT_DIR}" && (docker compose ps -q db >/dev/null 2>&1 || docker-compose ps -q db >/dev/null 2>&1)); then
      (cd "${ROOT_DIR}" && (dump_via_compose))
    else
      dump_direct
    fi
  else
    dump_direct
  fi
else
  dump_direct
fi

paths=()
for p in pdfs uploads; do
  if [[ -d "${DATA_DIR}/${p}" ]]; then
    paths+=("${p}")
  fi
done

if ((${#paths[@]} == 0)); then
  tar -czf "${FILES_ARCHIVE_PATH}" --files-from /dev/null
else
  tar -C "${DATA_DIR}" -czf "${FILES_ARCHIVE_PATH}" "${paths[@]}"
fi

echo "DB backup: ${DB_DUMP_PATH}"
echo "File backup: ${FILES_ARCHIVE_PATH}"

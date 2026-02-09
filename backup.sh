#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_dotenv() {
  local env_file="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Trim leading/trailing whitespace.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue

    # Parse KEY=VALUE (VALUE may contain spaces).
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"

      # Strip surrounding quotes if present.
      if [[ "${#val}" -ge 2 && "${val:0:1}" == "\"" && "${val: -1}" == "\"" ]]; then
        val="${val:1:${#val}-2}"
      elif [[ "${#val}" -ge 2 && "${val:0:1}" == "'" && "${val: -1}" == "'" ]]; then
        val="${val:1:${#val}-2}"
      fi

      export "$key=$val"
    fi
  done <"$env_file"
}

if [[ -f "${ROOT_DIR}/.env" ]]; then
  load_dotenv "${ROOT_DIR}/.env"
fi

BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
DATA_DIR="${DATA_DIR:-${ROOT_DIR}/data}"

# `.env.example` uses container paths (`/backups`, `/data`). When running this script on
# the host, fall back to the repo folders if those container paths don't exist.
if [[ "${BACKUP_DIR}" == "/backups" && ! -d "/backups" ]]; then
  BACKUP_DIR="${ROOT_DIR}/backups"
fi
if [[ "${DATA_DIR}" == "/data" && ! -d "/data" ]]; then
  DATA_DIR="${ROOT_DIR}/data"
fi
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

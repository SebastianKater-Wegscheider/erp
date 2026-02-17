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

usage() {
  cat <<'EOF'
Usage:
  ./backup_restore_drill.sh [--keep-db] [--no-backup] [--strict-alembic|--allow-legacy-alembic]

What it does:
  1) (optional) runs ./backup.sh to create a fresh dump + files archive
  2) restores the newest db_*.sql.gz into a new temporary database
  3) validates basic invariants (alembic_version + expected tables)
  4) (optional) leaves the drill DB behind if --keep-db is set

This drill does NOT touch your main database schema.
EOF
}

KEEP_DB=0
RUN_BACKUP=1
STRICT_ALEMBIC="${RESTORE_DRILL_STRICT_ALEMBIC:-true}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-db)
      KEEP_DB=1; shift ;;
    --no-backup)
      RUN_BACKUP=0; shift ;;
    --strict-alembic)
      STRICT_ALEMBIC=true; shift ;;
    --allow-legacy-alembic)
      STRICT_ALEMBIC=false; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage; exit 1 ;;
  esac
done

COMPOSE=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    echo "docker compose (or docker-compose) is required." >&2
    exit 1
  fi
fi

if [[ -z "$("${COMPOSE[@]}" ps -q db 2>/dev/null)" ]]; then
  echo "No running 'db' service found. Start the stack first (docker compose up -d)." >&2
  exit 1
fi

if [[ "${RUN_BACKUP}" == "1" ]]; then
  "${ROOT_DIR}/backup.sh" >/dev/null
fi

BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
# `.env.example` uses a container path (`/backups`). When running this script on the host,
# fall back to the repo folder if that container path doesn't exist.
if [[ "${BACKUP_DIR}" == "/backups" && ! -d "/backups" ]]; then
  BACKUP_DIR="${ROOT_DIR}/backups"
fi
DB_DUMP_PATH="$(ls -1t "${BACKUP_DIR}"/db_*.sql.gz 2>/dev/null | head -n 1 || true)"
FILES_ARCHIVE_PATH="$(ls -1t "${BACKUP_DIR}"/files_*.tar.gz 2>/dev/null | head -n 1 || true)"

if [[ -z "${DB_DUMP_PATH}" ]]; then
  echo "No db_*.sql.gz found in: ${BACKUP_DIR}" >&2
  exit 1
fi

if [[ -n "${FILES_ARCHIVE_PATH}" ]]; then
  tar -tzf "${FILES_ARCHIVE_PATH}" >/dev/null
fi

timestamp="$(date +"%Y%m%d_%H%M%S")"
base_db="${POSTGRES_DB:-erp}"
drill_db="${base_db}_restore_drill_${timestamp}"

created=0
cleanup() {
  if [[ "${KEEP_DB}" == "1" ]]; then
    return 0
  fi
  if [[ "${created}" != "1" ]]; then
    return 0
  fi
  echo "Dropping drill database: ${drill_db}"
  "${COMPOSE[@]}" exec -T db sh -lc "
    psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d postgres -c \"DROP DATABASE IF EXISTS \\\"${drill_db}\\\";\"
  " >/dev/null
}
trap cleanup EXIT

echo "Creating drill database: ${drill_db}"
"${COMPOSE[@]}" exec -T db sh -lc "
  psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d postgres -c \"CREATE DATABASE \\\"${drill_db}\\\";\"
" >/dev/null
created=1

echo "Restoring dump into drill database: ${DB_DUMP_PATH}"
gunzip -c "${DB_DUMP_PATH}" | "${COMPOSE[@]}" exec -T db sh -lc "
  psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"${drill_db}\"
" >/dev/null

echo "Validating restore..."
"${COMPOSE[@]}" exec -T db sh -lc "
  set -e

  has_purchases=\$(psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"${drill_db}\" -tAc \"select to_regclass('public.purchases') is not null\" | tr -d '[:space:]')
  if [ \"\$has_purchases\" != \"t\" ]; then
    echo \"Missing table: purchases\" >&2
    exit 1
  fi

  has_inventory_items=\$(psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"${drill_db}\" -tAc \"select to_regclass('public.inventory_items') is not null\" | tr -d '[:space:]')
  if [ \"\$has_inventory_items\" != \"t\" ]; then
    echo \"Missing table: inventory_items\" >&2
    exit 1
  fi

  # Enforce Alembic metadata by default; legacy mode must be explicit.
  has_alembic=\$(psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"${drill_db}\" -tAc \"select to_regclass('public.alembic_version') is not null\" | tr -d '[:space:]')
  if [ \"\$has_alembic\" = \"t\" ]; then
    psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"${drill_db}\" -c \"select version_num from alembic_version;\"
  elif [ \"${STRICT_ALEMBIC}\" = \"true\" ]; then
    echo \"Missing table: alembic_version (strict drill mode).\" >&2
    exit 1
  else
    echo \"Note: legacy backup (no alembic_version table).\" >&2
  fi
"

if [[ "${KEEP_DB}" == "1" ]]; then
  echo "Drill DB kept: ${drill_db}"
else
  echo "Drill completed successfully."
fi

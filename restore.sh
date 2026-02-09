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
  ./restore.sh --db <path.sql|path.sql.gz> [--files <path.tar.gz>] [--data-dir <dir>] [--yes]

Notes:
  - This is destructive: it drops and recreates the `public` schema in Postgres.
  - It expects a running `docker compose` stack with a `db` service.
EOF
}

DB_DUMP_PATH=""
FILES_ARCHIVE_PATH=""
DATA_DIR="${DATA_DIR:-${ROOT_DIR}/data}"
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      DB_DUMP_PATH="${2:-}"; shift 2 ;;
    --files)
      FILES_ARCHIVE_PATH="${2:-}"; shift 2 ;;
    --data-dir)
      DATA_DIR="${2:-}"; shift 2 ;;
    -y|--yes)
      ASSUME_YES=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage; exit 1 ;;
  esac
done

# `.env.example` uses a container path (`/data`). When running this script on the host,
# fall back to the repo folder if that container path doesn't exist.
if [[ "${DATA_DIR}" == "/data" && ! -d "/data" ]]; then
  DATA_DIR="${ROOT_DIR}/data"
fi

if [[ -z "${DB_DUMP_PATH}" ]]; then
  echo "--db is required." >&2
  usage
  exit 1
fi
if [[ ! -f "${DB_DUMP_PATH}" ]]; then
  echo "DB dump not found: ${DB_DUMP_PATH}" >&2
  exit 1
fi
if [[ -n "${FILES_ARCHIVE_PATH}" && ! -f "${FILES_ARCHIVE_PATH}" ]]; then
  echo "Files archive not found: ${FILES_ARCHIVE_PATH}" >&2
  exit 1
fi

COMPOSE=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    echo "docker compose (or docker-compose) is required." >&2
    exit 1
  fi
fi

if [[ "${ASSUME_YES}" != "1" ]]; then
  echo "About to restore the database from: ${DB_DUMP_PATH}"
  if [[ -n "${FILES_ARCHIVE_PATH}" ]]; then
    echo "About to restore files from: ${FILES_ARCHIVE_PATH}"
  fi
  echo
  echo "This will:"
  echo "  1) stop backend/frontend/backup services (best-effort)"
  echo "  2) DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  echo "  3) restore the dump into \$POSTGRES_DB"
  echo "  4) (optional) restore ./data/pdfs and ./data/uploads"
  echo
  read -r -p "Type RESTORE to continue: " confirm
  if [[ "${confirm}" != "RESTORE" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

if [[ -z "$("${COMPOSE[@]}" ps -q db 2>/dev/null)" ]]; then
  echo "No running 'db' service found. Start the stack first (docker compose up -d)." >&2
  exit 1
fi

echo "Stopping writers (backend/frontend/backup)..."
set +e
"${COMPOSE[@]}" stop backend frontend backup >/dev/null 2>&1
set -e

echo "Terminating active DB connections..."
"${COMPOSE[@]}" exec -T db sh -lc '
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid();
  "
'

echo "Dropping and recreating public schema..."
"${COMPOSE[@]}" exec -T db sh -lc '
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO \"$POSTGRES_USER\";
    GRANT ALL ON SCHEMA public TO public;
  "
'

echo "Restoring DB dump..."
if [[ "${DB_DUMP_PATH}" == *.gz ]]; then
  gunzip -c "${DB_DUMP_PATH}" | "${COMPOSE[@]}" exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
else
  cat "${DB_DUMP_PATH}" | "${COMPOSE[@]}" exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
fi

if [[ -n "${FILES_ARCHIVE_PATH}" ]]; then
  echo "Restoring files into: ${DATA_DIR}"
  ts="$(date +"%Y%m%d_%H%M%S")"
  mkdir -p "${DATA_DIR}"

  for d in pdfs uploads; do
    if [[ -d "${DATA_DIR}/${d}" ]] && [[ -n "$(ls -A "${DATA_DIR}/${d}" 2>/dev/null)" ]]; then
      mv "${DATA_DIR}/${d}" "${DATA_DIR}/${d}_pre_restore_${ts}"
    fi
  done

  tar -C "${DATA_DIR}" -xzf "${FILES_ARCHIVE_PATH}"
fi

echo "Starting services..."
"${COMPOSE[@]}" up -d backend frontend backup >/dev/null

echo "Restore complete."

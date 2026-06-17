#!/usr/bin/env bash
# Restore a PostgreSQL dump produced by deploy/backup.sh.
#
# DESTRUCTIVE: drops and recreates objects in the target database (pg_restore --clean --if-exists).
# Requires interactive confirmation (type the DB name) unless FORCE=1 is set.
#
# Usage:   ./deploy/restore.sh <path-to-dump>
#          FORCE=1 ./deploy/restore.sh backups/communication_20260617_120000.dump
# Env overrides: ENV_FILE, PG_IMAGE (see backup.sh).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
DUMP="${1:-}"

if [[ -z "${DUMP}" || ! -f "${DUMP}" ]]; then
  echo "usage: $0 <path-to-dump>" >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[restore] error: env file not found: ${ENV_FILE}" >&2
  exit 1
fi

readenv() { grep -E "^$1=" "${ENV_FILE}" | head -n1 | sed -E "s/^$1=//; s/\r$//; s/^\"//; s/\"$//"; }

PGHOST="$(readenv POSTGRES_HOST)"
PGPORT="$(readenv POSTGRES_PORT)"; PGPORT="${PGPORT:-5432}"
PGDB="$(readenv POSTGRES_DB)"
PGUSER="$(readenv POSTGRES_USER)"
PGPASS="$(readenv POSTGRES_PASSWORD)"

echo "[restore] target: ${PGDB}@${PGHOST}:${PGPORT}"
echo "[restore] source: ${DUMP}"
echo "[restore] WARNING: existing objects in ${PGDB} will be dropped and replaced."

if [[ "${FORCE:-0}" != "1" ]]; then
  read -r -p "Type the database name (${PGDB}) to confirm: " CONFIRM
  if [[ "${CONFIRM}" != "${PGDB}" ]]; then
    echo "[restore] aborted (confirmation mismatch)"
    exit 1
  fi
fi

echo "[restore] restoring..."
docker run --rm -i --network host -e PGPASSWORD="${PGPASS}" "${PG_IMAGE}" \
  pg_restore -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDB}" \
  --clean --if-exists --no-owner --no-privileges < "${DUMP}"

echo "[restore] done. Tip: re-run migrations afterwards if the dump predates the current schema:"
echo "  docker compose --env-file ${ENV_FILE} -f ${ROOT_DIR}/docker-compose.prod.yml run --rm migrate"

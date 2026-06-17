#!/usr/bin/env bash
# PostgreSQL backup for the energy platform.
#
# Dumps the configured database (custom/compressed format) using a one-shot postgres
# container, so no psql client is required on the host. Designed for an external DB (RDS)
# reached over the host network (Linux EC2). Old dumps beyond the retention window are pruned.
#
# Usage:   ./deploy/backup.sh
# Env overrides:
#   ENV_FILE              (default: <repo>/.env.production)
#   BACKUP_DIR            (default: <repo>/backups)
#   PG_IMAGE              (default: postgres:16-alpine; must be >= the server major version)
#   BACKUP_RETENTION_DAYS (default: 14)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[backup] error: env file not found: ${ENV_FILE}" >&2
  exit 1
fi

# Read a KEY=value line from the env file without sourcing it (avoids running arbitrary content).
readenv() { grep -E "^$1=" "${ENV_FILE}" | head -n1 | sed -E "s/^$1=//; s/\r$//; s/^\"//; s/\"$//"; }

PGHOST="$(readenv POSTGRES_HOST)"
PGPORT="$(readenv POSTGRES_PORT)"; PGPORT="${PGPORT:-5432}"
PGDB="$(readenv POSTGRES_DB)"
PGUSER="$(readenv POSTGRES_USER)"
PGPASS="$(readenv POSTGRES_PASSWORD)"

if [[ -z "${PGHOST}" || -z "${PGDB}" || -z "${PGUSER}" ]]; then
  echo "[backup] error: POSTGRES_HOST/DB/USER must be set in ${ENV_FILE}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
TS="$(date +%Y%m%d_%H%M%S)"
OUT="${BACKUP_DIR}/${PGDB}_${TS}.dump"

echo "[backup] dumping ${PGDB}@${PGHOST}:${PGPORT} -> ${OUT}"
docker run --rm --network host -e PGPASSWORD="${PGPASS}" "${PG_IMAGE}" \
  pg_dump -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDB}" \
  -Fc --no-owner --no-privileges > "${OUT}"

if [[ ! -s "${OUT}" ]]; then
  echo "[backup] error: dump is empty; removing ${OUT}" >&2
  rm -f "${OUT}"
  exit 1
fi

echo "[backup] ok: $(du -h "${OUT}" | cut -f1) -> ${OUT}"

echo "[backup] pruning dumps older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "${PGDB}_*.dump" -type f -mtime +"${RETENTION_DAYS}" -print -delete || true

echo "[backup] done"

#!/usr/bin/env bash
# Daily PostgreSQL backup for the containerized DB (docker exec pg_dump).
# Use this on hosts where Postgres runs as the `communication-postgres` container
# (not reachable over the host network). For external/RDS databases use deploy/backup.sh.
#
# Install (daily 03:30, 14-day retention):
#   ( crontab -l 2>/dev/null | grep -v db-backup-local.sh; \
#     echo "30 3 * * * /home/ubuntu/app/deploy/db-backup-local.sh >> /home/ubuntu/app/backups/backup.log 2>&1" ) | crontab -
set -euo pipefail
ROOT="${ROOT_DIR:-/home/ubuntu/app}"
BDIR="${BACKUP_DIR:-$ROOT/backups}"
RET="${BACKUP_RETENTION_DAYS:-14}"
CONTAINER="${PG_CONTAINER:-communication-postgres}"
DB="${POSTGRES_DB:-communication}"
USER="${POSTGRES_USER:-communication_app}"

mkdir -p "$BDIR"
TS="$(date +%Y%m%d_%H%M%S)"
OUT="$BDIR/${DB}_${TS}.dump"

docker exec "$CONTAINER" pg_dump -U "$USER" -d "$DB" -Fc --no-owner --no-privileges > "$OUT"
if [[ ! -s "$OUT" ]]; then
  echo "[db-backup] ERROR: empty dump, removing $OUT" >&2
  rm -f "$OUT"
  exit 1
fi
echo "[db-backup] ok $(du -h "$OUT" | cut -f1) -> $OUT"

find "$BDIR" -name "${DB}_*.dump" -type f -mtime +"$RET" -print -delete || true
echo "[db-backup] done"

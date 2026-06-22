#!/usr/bin/env bash
# Safe production update deploy.
#
# Always uses .env.production (never dev .env). Builds, migrates, restarts, verifies DB + auth.
#
# Usage:
#   ./deploy/deploy.sh              # git pull + deploy + verify
#   ./deploy/deploy.sh --no-pull    # deploy current checkout only
#   ./deploy/deploy.sh --backup     # pg_dump before deploy
#
# Never run bare `docker compose up` on production without --env-file .env.production.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
source "${ROOT_DIR}/deploy/lib/common.sh"

DO_PULL=1
DO_BACKUP=0
for arg in "$@"; do
  case "${arg}" in
    --no-pull) DO_PULL=0 ;;
    --backup) DO_BACKUP=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "[deploy] unknown option: ${arg} (try --help)" >&2
      exit 1
      ;;
  esac
done

cd "${ROOT_DIR}"
deploy_preflight
deploy_print_compose_hint

if [[ "${DO_BACKUP}" -eq 1 ]]; then
  echo "[deploy] pre-deploy backup..."
  "${ROOT_DIR}/deploy/backup.sh"
fi

if [[ "${DO_PULL}" -eq 1 ]]; then
  if [[ -d .git ]]; then
    echo "[deploy] git pull..."
    git fetch origin
    branch="$(git rev-parse --abbrev-ref HEAD)"
    git pull --ff-only origin "${branch}"
    echo "[deploy]   at $(git rev-parse --short HEAD)"
  else
    echo "[deploy] warning: not a git repo — skipping pull"
  fi
fi

echo "[deploy] building api + mqtt-worker..."
deploy_compose build api mqtt-worker

echo "[deploy] running migrations..."
deploy_compose run --rm migrate

echo "[deploy] starting / updating stack..."
deploy_compose up -d

echo "[deploy] service status:"
deploy_compose ps

deploy_verify_stack
echo "[deploy] done — production stack is healthy"

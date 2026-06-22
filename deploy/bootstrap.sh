#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.production"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"

# shellcheck source=deploy/lib/common.sh
source "${ROOT_DIR}/deploy/lib/common.sh"

echo "[bootstrap] checking docker..."
deploy_require_tools

echo "[bootstrap] checking required files..."
deploy_require_files

echo "[bootstrap] preflight: checking .env.production..."
deploy_check_required_secrets
deploy_check_production_topology

echo "[bootstrap] building images (api + worker)..."
deploy_compose build

echo "[bootstrap] running database migrations..."
deploy_compose run --rm migrate

echo "[bootstrap] starting production stack..."
deploy_compose up -d

echo "[bootstrap] current service status:"
deploy_compose ps

echo "[bootstrap] waiting for health checks..."
API_PORT_VALUE="$(deploy_readenv "${ENV_FILE}" API_PORT)"; API_PORT_VALUE="${API_PORT_VALUE:-3000}"
WORKER_PORT_VALUE="$(deploy_readenv "${ENV_FILE}" WORKER_HEALTH_PORT)"; WORKER_PORT_VALUE="${WORKER_PORT_VALUE:-9100}"

check_health() {
  local name="$1" url="$2" ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "[bootstrap]   ${name}: healthy (${url})"
      ok=1
      break
    fi
    sleep 3
  done
  if [[ "${ok}" -ne 1 ]]; then
    echo "[bootstrap]   ${name}: NOT healthy after timeout (${url})"
    return 1
  fi
}

rc=0
check_health "api" "http://127.0.0.1:${API_PORT_VALUE}/health" || rc=1
check_health "mqtt-worker" "http://127.0.0.1:${WORKER_PORT_VALUE}/health" || rc=1

if [[ "${rc}" -ne 0 ]]; then
  echo "[bootstrap] one or more services failed health checks; inspect logs:"
  deploy_print_compose_hint
  echo "[bootstrap]   ... logs --tail=50"
  exit 1
fi

deploy_verify_stack

echo "[bootstrap] done. API /metrics: http://127.0.0.1:${API_PORT_VALUE}/metrics  worker /metrics: http://127.0.0.1:${WORKER_PORT_VALUE}/metrics"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.production"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"

echo "[bootstrap] checking docker..."
if ! command -v docker >/dev/null 2>&1; then
  echo "[bootstrap] error: docker is not installed"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[bootstrap] error: docker daemon is not running"
  exit 1
fi

echo "[bootstrap] checking docker compose..."
if ! docker compose version >/dev/null 2>&1; then
  echo "[bootstrap] error: docker compose plugin is not available"
  exit 1
fi

echo "[bootstrap] checking required files..."
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[bootstrap] error: ${ENV_FILE} not found"
  echo "[bootstrap] copy .env.production.example to .env.production and fill values"
  exit 1
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "[bootstrap] error: ${COMPOSE_FILE} not found"
  exit 1
fi

echo "[bootstrap] preflight: checking .env.production for unfilled placeholders..."
# Abort if any secret still holds the example placeholder — a common deploy-day mistake.
REQUIRED_VARS=(POSTGRES_PASSWORD API_AUTH_TOKEN MQTT_PASSWORD DEVICE_MQTT_PASSWORD)
preflight_rc=0
for var in "${REQUIRED_VARS[@]}"; do
  line="$(grep -E "^${var}=" "${ENV_FILE}" | head -n1 || true)"
  value="${line#*=}"
  value="$(echo "${value}" | tr -d '[:space:]')"
  if [[ -z "${line}" ]]; then
    echo "[bootstrap]   MISSING: ${var} is not set in .env.production"
    preflight_rc=1
  elif [[ -z "${value}" || "${value}" == "change_me"* ]]; then
    echo "[bootstrap]   PLACEHOLDER: ${var} still holds an empty/'change_me' value"
    preflight_rc=1
  fi
done
if [[ "${preflight_rc}" -ne 0 ]]; then
  echo "[bootstrap] error: fill the values above in ${ENV_FILE} before deploying"
  exit 1
fi
echo "[bootstrap]   ok: required secrets are set"

COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

echo "[bootstrap] building images (api + worker)..."
"${COMPOSE[@]}" build

echo "[bootstrap] running database migrations..."
"${COMPOSE[@]}" run --rm migrate

echo "[bootstrap] starting production stack..."
"${COMPOSE[@]}" up -d

echo "[bootstrap] current service status:"
"${COMPOSE[@]}" ps

echo "[bootstrap] waiting for health checks..."
API_PORT_VALUE="$(grep -E '^API_PORT=' "${ENV_FILE}" | head -n1 | cut -d= -f2 | tr -d '[:space:]')"
WORKER_PORT_VALUE="$(grep -E '^WORKER_HEALTH_PORT=' "${ENV_FILE}" | head -n1 | cut -d= -f2 | tr -d '[:space:]')"
API_PORT_VALUE="${API_PORT_VALUE:-3000}"
WORKER_PORT_VALUE="${WORKER_PORT_VALUE:-9100}"

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
  echo "[bootstrap]   ${COMPOSE[*]} logs --tail=50"
  exit 1
fi

echo "[bootstrap] done. API /metrics: http://127.0.0.1:${API_PORT_VALUE}/metrics  worker /metrics: http://127.0.0.1:${WORKER_PORT_VALUE}/metrics"

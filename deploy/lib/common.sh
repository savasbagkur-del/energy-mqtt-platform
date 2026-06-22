#!/usr/bin/env bash
# Shared helpers for production deploy scripts.
# Always uses .env.production — never the dev .env file.
set -euo pipefail

deploy_root_dir() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")/../.." && pwd)"
  printf '%s' "${here}"
}

deploy_env_file() {
  printf '%s' "${ENV_FILE:-$(deploy_root_dir)/.env.production}"
}

deploy_compose_file() {
  printf '%s' "${COMPOSE_FILE:-$(deploy_root_dir)/docker-compose.prod.yml}"
}

# Read KEY=value from env file without sourcing it (avoids executing arbitrary content).
deploy_readenv() {
  local file="$1" key="$2"
  grep -E "^${key}=" "${file}" | head -n1 | sed -E "s/^${key}=//; s/\r$//; s/^\"//; s/\"$//"
}

deploy_compose() {
  local root env compose
  root="$(deploy_root_dir)"
  env="$(deploy_env_file)"
  compose="$(deploy_compose_file)"
  docker compose --env-file "${env}" -f "${compose}" "$@"
}

deploy_require_tools() {
  command -v docker >/dev/null 2>&1 || { echo "[deploy] error: docker not installed" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "[deploy] error: docker daemon not running" >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "[deploy] error: docker compose plugin missing" >&2; exit 1; }
}

deploy_require_files() {
  local env compose
  env="$(deploy_env_file)"
  compose="$(deploy_compose_file)"
  [[ -f "${env}" ]] || { echo "[deploy] error: ${env} not found (copy .env.production.example)" >&2; exit 1; }
  [[ -f "${compose}" ]] || { echo "[deploy] error: ${compose} not found" >&2; exit 1; }
}

# Abort when secrets still hold example placeholders.
deploy_check_required_secrets() {
  local env rc=0 var line value
  env="$(deploy_env_file)"
  local required=(POSTGRES_PASSWORD API_AUTH_TOKEN MQTT_PASSWORD DEVICE_MQTT_PASSWORD)
  for var in "${required[@]}"; do
    line="$(grep -E "^${var}=" "${env}" | head -n1 || true)"
    value="${line#*=}"
    value="$(echo "${value}" | tr -d '[:space:]')"
    if [[ -z "${line}" ]]; then
      echo "[deploy]   MISSING: ${var} is not set in ${env}"
      rc=1
    elif [[ -z "${value}" || "${value}" == change_me* ]]; then
      echo "[deploy]   PLACEHOLDER: ${var} still holds an empty/'change_me' value"
      rc=1
    fi
  done
  if [[ "${rc}" -ne 0 ]]; then
    echo "[deploy] error: fill required secrets in ${env} before deploying" >&2
    exit 1
  fi
  echo "[deploy]   ok: required secrets are set"
}

# Catch the misconfiguration that broke production login (dev .env used for compose).
deploy_check_production_topology() {
  local env pg_host pg_port api_port rc=0
  env="$(deploy_env_file)"
  pg_host="$(deploy_readenv "${env}" POSTGRES_HOST)"
  pg_port="$(deploy_readenv "${env}" POSTGRES_PORT)"; pg_port="${pg_port:-5432}"
  api_port="$(deploy_readenv "${env}" API_PORT)"; api_port="${api_port:-3000}"

  if [[ "${pg_host}" == "127.0.0.1" || "${pg_host}" == "localhost" ]]; then
    echo "[deploy]   INVALID: POSTGRES_HOST=${pg_host} — inside Docker use POSTGRES_HOST=postgres"
    rc=1
  fi
  if [[ "${pg_host}" == "postgres" && "${pg_port}" != "5432" ]]; then
    echo "[deploy]   INVALID: POSTGRES_PORT=${pg_port} with compose postgres (must be 5432, not dev 5433)"
    rc=1
  fi
  if [[ "${api_port}" != "3000" ]]; then
    echo "[deploy]   INVALID: API_PORT=${api_port} — container/nginx expect 3000"
    rc=1
  fi

  local dev_env
  dev_env="$(deploy_root_dir)/.env"
  if [[ -f "${dev_env}" ]]; then
    local dev_host dev_port
    dev_host="$(deploy_readenv "${dev_env}" POSTGRES_HOST 2>/dev/null || true)"
    dev_port="$(deploy_readenv "${dev_env}" POSTGRES_PORT 2>/dev/null || true)"
    if [[ "${dev_host}" == "127.0.0.1" || "${dev_port}" == "5433" ]]; then
      echo "[deploy]   NOTE: ${dev_env} looks like local-dev config — deploy scripts ignore it"
      echo "[deploy]         always run: docker compose --env-file .env.production ..."
    fi
  fi

  if [[ "${rc}" -ne 0 ]]; then
    echo "[deploy] error: fix topology values in ${env} (see .env.production.example)" >&2
    exit 1
  fi
  echo "[deploy]   ok: POSTGRES_HOST=${pg_host}:${pg_port}, API_PORT=${api_port}"
}

deploy_preflight() {
  echo "[deploy] preflight..."
  deploy_require_tools
  deploy_require_files
  deploy_check_required_secrets
  deploy_check_production_topology
}

deploy_wait_http() {
  local name="$1" url="$2" expect="${3:-200}" tries="${4:-30}"
  local i code
  for ((i = 1; i <= tries; i++)); do
    code="$(curl -fsS -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null || echo 000)"
    if [[ "${code}" == "${expect}" ]]; then
      echo "[deploy]   ${name}: ok (${url} -> ${code})"
      return 0
    fi
    sleep 3
  done
  echo "[deploy]   ${name}: FAILED (${url}, last http=${code}, expected ${expect})" >&2
  return 1
}

deploy_verify_stack() {
  local env api_port rc=0
  env="$(deploy_env_file)"
  api_port="$(deploy_readenv "${env}" API_PORT)"; api_port="${api_port:-3000}"

  echo "[deploy] verifying stack..."
  deploy_wait_http "api /health" "http://127.0.0.1:${api_port}/health" 200 || rc=1

  local ready
  ready="$(curl -fsS "http://127.0.0.1:${api_port}/ready" 2>/dev/null || echo '{}')"
  if echo "${ready}" | grep -q '"dbUp":true'; then
    echo "[deploy]   api /ready: dbUp=true"
  else
    echo "[deploy]   api /ready: dbUp=false or unreachable — ${ready}" >&2
    rc=1
  fi

  # Wrong DB creds return 500 login_failed; correct wiring returns 401 invalid_credentials.
  local login_body login_code
  login_body="$(curl -fsS -X POST "http://127.0.0.1:${api_port}/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"__deploy_probe__"}' 2>/dev/null || echo '{}')"
  login_code="$(curl -fsS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${api_port}/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"__deploy_probe__"}' 2>/dev/null || echo 000)"
  if [[ "${login_code}" == "401" ]]; then
    echo "[deploy]   auth/login: ok (401 invalid_credentials — DB reachable)"
  else
    echo "[deploy]   auth/login: unexpected http=${login_code} body=${login_body}" >&2
    rc=1
  fi

  if [[ "${rc}" -ne 0 ]]; then
    echo "[deploy] verification failed — inspect: deploy_compose logs --tail=80 api" >&2
    exit 1
  fi
  echo "[deploy] verification passed"
}

deploy_print_compose_hint() {
  local env
  env="$(deploy_env_file)"
  echo "[deploy] compose: docker compose --env-file ${env} -f $(deploy_compose_file)"
}

#!/usr/bin/env bash
# Read-only production config check (no build/restart).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/lib/common.sh
source "${ROOT_DIR}/deploy/lib/common.sh"

cd "${ROOT_DIR}"
deploy_require_tools
deploy_require_files
echo "[preflight] secrets..."
deploy_check_required_secrets
echo "[preflight] topology..."
deploy_check_production_topology

env="$(deploy_env_file)"
if deploy_compose ps --status running 2>/dev/null | grep -q api; then
  echo "[preflight] running containers detected — checking /ready..."
  api_port="$(deploy_readenv "${env}" API_PORT)"; api_port="${api_port:-3000}"
  ready="$(curl -fsS "http://127.0.0.1:${api_port}/ready" 2>/dev/null || echo '{}')"
  if echo "${ready}" | grep -q '"dbUp":true'; then
    echo "[preflight]   ok: api dbUp=true"
  else
    echo "[preflight]   WARN: api running but dbUp=false — run ./deploy/deploy.sh" >&2
    exit 1
  fi
else
  echo "[preflight]   stack not running (ok for first install — use ./deploy/bootstrap.sh)"
fi

echo "[preflight] all checks passed"

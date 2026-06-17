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

echo "[bootstrap] starting production stack..."
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d

echo "[bootstrap] current service status:"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps

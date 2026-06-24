#!/usr/bin/env bash
set -euo pipefail
API="${API_BASE:-http://127.0.0.1:3000}"

echo "=== API customers (integration_mode=api) ==="
docker exec communication-postgres psql -U communication_app -d communication -c \
  "SELECT c.id, c.name, pu.username, (pu.password_md5 IS NOT NULL) AS has_md5
   FROM customers c
   JOIN panel_users pu ON pu.customer_id = c.id
   WHERE c.integration_mode = 'api'
   ORDER BY c.id;"

USER="${EASYTECH_USER:-}"
PASS_MD5="${EASYTECH_PASS_MD5:-}"

if [[ -z "$USER" || -z "$PASS_MD5" ]]; then
  echo ""
  echo "Skip login test: set EASYTECH_USER and EASYTECH_PASS_MD5 to run /login smoke test."
  exit 0
fi

echo ""
echo "=== POST /login ==="
LOGIN_JSON=$(curl -sS -X POST "$API/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS_MD5\"}")
echo "$LOGIN_JSON" | python3 -m json.tool 2>/dev/null || echo "$LOGIN_JSON"

USER_TOKEN=$(echo "$LOGIN_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('userToken',''))" 2>/dev/null || true)
if [[ -z "$USER_TOKEN" ]]; then
  echo "Login failed — no userToken"
  exit 1
fi

echo ""
echo "=== GET /getMeterList ==="
curl -sS "$API/getMeterList" -H "token: $USER_TOKEN" | python3 -m json.tool 2>/dev/null | head -80

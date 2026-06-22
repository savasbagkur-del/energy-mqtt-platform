set -euo pipefail
cd /home/ubuntu/app
git fetch origin master
git reset --hard origin/master
git --no-pager log --oneline -1
ENV=.env.production
COMPOSE="docker compose --env-file $ENV -f docker-compose.prod.yml"
echo '--- build api ---'
$COMPOSE build api
echo '--- recreate api ---'
$COMPOSE up -d api
sleep 6
docker ps --format '{{.Names}} {{.Status}}' | grep communication-api || true
echo '--- live asset version ---'
curl -s https://app.volt4amper.com/index.html | grep -o 'app.js?v=[0-9]*' | head -1 || true
echo '--- health ---'
curl -s -o /dev/null -w '%{http_code}\n' https://app.volt4amper.com/health || true

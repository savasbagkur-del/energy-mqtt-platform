#!/usr/bin/env bash
# Docker Engine + Compose plugin kurulumu (EC2 ilk açılış / user-data icin).
# Amazon Linux 2023 ve Ubuntu/Debian destekler. Idempotent: tekrar calistirilabilir.
#
# Kullanim (SSH ile sunucuda):
#   curl -fsSL <bu_dosyanin_url'i> -o install-docker.sh && sudo bash install-docker.sh
# veya EC2 "User data" alanina bu dosyanin tamamini yapistirin (launch sirasinda root calisir).
set -euo pipefail

log() { echo "[ec2-docker] $*"; }

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "docker + compose zaten kurulu; atlaniyor"
  docker --version
  docker compose version
  exit 0
fi

OS_ID=""
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"
fi
log "tespit edilen OS: ${OS_ID:-bilinmiyor}"

install_amazon_linux() {
  log "Amazon Linux 2023 icin kurulum"
  dnf -y update || true
  dnf -y install docker
  systemctl enable --now docker
  # Compose v2 plugin (AL2023 repolarinda olmayabilir) -> manuel kur
  local plugin_dir="/usr/libexec/docker/cli-plugins"
  mkdir -p "${plugin_dir}"
  local arch; arch="$(uname -m)"
  local cver="v2.29.7"
  local url="https://github.com/docker/compose/releases/download/${cver}/docker-compose-linux-${arch}"
  curl -fsSL "${url}" -o "${plugin_dir}/docker-compose"
  chmod +x "${plugin_dir}/docker-compose"
}

install_debian_like() {
  log "Ubuntu/Debian icin kurulum (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

case "${OS_ID}" in
  amzn) install_amazon_linux ;;
  ubuntu|debian) install_debian_like ;;
  *)
    log "OS otomatik tespit edilemedi; get.docker.com deneniyor"
    install_debian_like
    ;;
esac

# Yonetici kullanicisini docker grubuna ekle (sudo'suz docker icin; yeniden login gerekir).
for u in ec2-user ubuntu; do
  if id "${u}" >/dev/null 2>&1; then
    usermod -aG docker "${u}" || true
    log "kullanici '${u}' docker grubuna eklendi (yeniden SSH login sonrasi etkin)"
  fi
done

log "tamamlandi:"
docker --version
docker compose version

#!/usr/bin/env bash
# Switch the Pi to images published by the Release workflow. Called over SSH by
# .github/workflows/release.yml after it has copied deploy/ and scripts/ to /tmp:
#
#   sudo bash /tmp/pivault-scripts/deploy-release.sh <github-owner> <version>
set -euo pipefail

OWNER="$(echo "${1:?github owner}" | tr '[:upper:]' '[:lower:]')"
VERSION="${2:?version}"
HOME_DIR=/opt/pivault

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

rsync -a --exclude '.env' /tmp/pivault-deploy/ "$HOME_DIR/deploy/"
rsync -a /tmp/pivault-scripts/ "$HOME_DIR/scripts/"
chmod 755 "$HOME_DIR"/scripts/*.sh

cd "$HOME_DIR/deploy"
set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s#^$1=.*#$1=$2#" .env
  else
    echo "$1=$2" >> .env
  fi
}
set_env PIVAULT_BACKEND_IMAGE "ghcr.io/$OWNER/pivault-backend:$VERSION"
set_env PIVAULT_WEB_IMAGE "ghcr.io/$OWNER/pivault-web:$VERSION"

docker compose pull --quiet caddy api worker
docker compose up -d --no-build --remove-orphans

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/api/health; then
    echo
    echo "PiVault $VERSION is running"
    exit 0
  fi
  sleep 5
done
echo "the API did not become healthy after the update" >&2
exit 1

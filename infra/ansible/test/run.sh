#!/usr/bin/env bash
# Run the whole playbook in a disposable Debian 13 machine (a privileged container
# with systemd and its own Docker), then check PiVault answers. Takes 10+ minutes.
#
#   infra/ansible/test/run.sh          # create the machine and run everything
#   infra/ansible/test/run.sh --keep   # leave the machine running afterwards
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
NAME=pivault-ansible-test
MOUNT="$REPO"
CONTEXT="$HERE"
# Docker Desktop on Windows needs Windows-style paths.
if command -v cygpath > /dev/null 2>&1; then
  MOUNT="$(cygpath -m "$REPO")"
  CONTEXT="$(cygpath -m "$HERE")"
fi
export MSYS_NO_PATHCONV=1

docker build -q -t "$NAME" "$CONTEXT" > /dev/null
docker rm -f "$NAME" > /dev/null 2>&1 || true
docker volume rm -f "$NAME-docker" "$NAME-containerd" > /dev/null 2>&1 || true

# Docker inside the container needs real volumes for its storage (overlay on overlay
# does not work).
docker run -d --name "$NAME" --hostname pitest --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "$NAME-docker:/var/lib/docker" -v "$NAME-containerd:/var/lib/containerd" \
  -v "$MOUNT:/repo:ro" "$NAME" > /dev/null
sleep 5

docker exec "$NAME" bash -c '
set -euo pipefail
mkdir -p /opt/pivault /etc/pivault
rsync -a --exclude .git --exclude node_modules --exclude mobile/dist --exclude mobile/.expo \
  --exclude infra/image/build --exclude mobile/test-results --exclude mobile/playwright-report \
  --exclude deploy/.env /repo/ /opt/pivault/
find /opt/pivault -type f \( -name "*.sh" -o -name "*.yml" -o -name "*.j2" -o -name "*.cfg" -o -name Caddyfile \) \
  -exec sed -i "s/\r$//" {} +
chmod -R go-w /opt/pivault
cat > /etc/pivault/ansible-vars.yml <<VARS
pivault_hostname: "pitest"
pivault_admin_email: "admin@pivault.dev"
pivault_admin_password: "test-password-123"
allow_lan_http: true
VARS
cd /opt/pivault/infra/ansible
ANSIBLE_FORCE_COLOR=0 ansible-playbook -i localhost, -c local site.yml -e @/etc/pivault/ansible-vars.yml \
  > /var/log/pivault-playbook.log 2>&1 || { tail -c 3000 /var/log/pivault-playbook.log; exit 1; }
grep -A3 "PLAY RECAP" /var/log/pivault-playbook.log

echo "--- second run must change nothing but the container restart"
ANSIBLE_FORCE_COLOR=0 ansible-playbook -i localhost, -c local site.yml -e @/etc/pivault/ansible-vars.yml \
  --skip-tags app > /var/log/pivault-playbook-2.log 2>&1 || { tail -c 3000 /var/log/pivault-playbook-2.log; exit 1; }
grep -A3 "PLAY RECAP" /var/log/pivault-playbook-2.log

echo "--- containers"
docker compose -f /opt/pivault/deploy/docker-compose.yml ps --format "table {{.Service}}\t{{.Status}}"
echo "--- through Caddy on port 80"
curl -fsS http://127.0.0.1/api/health; echo
curl -fsS -o /dev/null -w "web app: HTTP %{http_code}, %{size_download} bytes\n" http://127.0.0.1/
curl -s -o /dev/null -w "metrics hidden: HTTP %{http_code}\n" http://127.0.0.1/metrics
curl -fsS -o /dev/null -w "grafana: HTTP %{http_code}\n" http://127.0.0.1/grafana/login
echo "--- smoke test through Caddy"
bash /opt/pivault/scripts/smoke-test.sh http://127.0.0.1 admin@pivault.dev test-password-123 | tail -4
echo "--- nightly jobs"
bash /opt/pivault/scripts/pg-dump.sh | tail -1
bash /opt/pivault/scripts/snapraid-sync.sh | tail -1
bash /opt/pivault/scripts/backup.sh | tail -1
ls /var/lib/pivault/metrics
echo "--- pivault-info"
pivault-info | head -30
'

if [ "${1:-}" != "--keep" ]; then
  docker rm -f "$NAME" > /dev/null
  docker volume rm -f "$NAME-docker" "$NAME-containerd" > /dev/null
fi

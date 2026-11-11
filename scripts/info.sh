#!/usr/bin/env bash
# Show where PiVault is reachable and how it is doing:  pivault-info
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"

ENV_FILE="$PIVAULT_HOME/deploy/.env"
value() { [ -r "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -n1; }

echo "PiVault"
echo "======="
if [ ! -f /var/lib/pivault/provisioned ]; then
  echo "Setup is still running (or failed). Follow it with:"
  echo "  sudo tail -f /var/log/pivault-firstboot.log"
  echo
fi

DOMAIN="$(value PIVAULT_DOMAIN)"
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
TS_STATE="$(tailscale status --json 2>/dev/null | sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' | head -n1)"

echo "Addresses"
if [ "$TS_STATE" = "Running" ] && [ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ]; then
  echo "  From anywhere (Tailscale):  https://$DOMAIN"
else
  echo "  Tailscale is not connected yet. Run:  sudo tailscale up"
  echo "  then:                                 sudo pivault-apply"
fi
echo "  On the Pi itself:           http://127.0.0.1:8000/api/health"
[ -n "$LAN_IP" ] && echo "  Home network (SSH):         ssh $(id -un 1000 2>/dev/null || echo pi)@$LAN_IP"
echo

echo "Login"
if [ -r "$ENV_FILE" ]; then
  echo "  Email:     $(value PIVAULT_ADMIN_EMAIL)"
  echo "  Password:  $(value PIVAULT_ADMIN_PASSWORD)"
  echo "  Grafana:   https://${DOMAIN:-<your-pi>}/grafana/  (admin / $(value GRAFANA_ADMIN_PASSWORD))"
else
  echo "  Run with sudo to see the login details."
fi
echo

echo "Storage"
if mountpoint -q /mnt/storage; then
  df -h --output=target,size,used,avail,pcent /mnt/storage /mnt/disk* /mnt/parity* 2>/dev/null | sed 's/^/  /'
else
  echo "  Using the SD card (no SSDs set up yet). When the drives are plugged in, run:"
  echo "    sudo pivault-setup-disks"
  df -h --output=target,size,used,avail,pcent / | sed 's/^/  /'
fi
echo

echo "Services"
if [ -r "$ENV_FILE" ]; then
  compose ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null | sed 's/^/  /'
else
  echo "  Run with sudo to see container status."
fi
echo
HEALTH="$(curl -fsS -m 5 http://127.0.0.1:8000/api/health 2>/dev/null || true)"
echo "Health: ${HEALTH:-API is not answering}"
echo
if [ -r /etc/pivault/restic-password ] && [ ! -f /etc/pivault/restic.env ]; then
  echo "Backups: not set up yet. See docs/SETUP.md, 'Backups'."
fi

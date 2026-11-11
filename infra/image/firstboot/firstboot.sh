#!/usr/bin/env bash
# Runs once on the Pi's first boot (as root, from pivault-firstboot.service):
#   1. make sure you can log in over SSH with your key
#   2. connect Wi-Fi if it was configured
#   3. install Ansible and run the PiVault playbook on this machine
#
# It is safe to run again: `sudo systemctl start pivault-firstboot` after fixing
# whatever stopped it. Progress is in /var/log/pivault-firstboot.log.
set -euo pipefail

LOG=/var/log/pivault-firstboot.log
exec > >(tee -a "$LOG") 2>&1
echo
echo "=== PiVault first boot: $(date) ==="

CONFIG=/etc/pivault/image.env
# shellcheck disable=SC1090
[ -f "$CONFIG" ] && . "$CONFIG"

PI_USER="${PI_USER:-pi}"
WIFI_SSID="${WIFI_SSID:-}"
WIFI_PASSWORD="${WIFI_PASSWORD:-}"
WIFI_COUNTRY="${WIFI_COUNTRY:-CA}"

step() { echo; echo "--- $* ---"; }

step "Login user and SSH"
if id "$PI_USER" > /dev/null 2>&1; then
  usermod -s /bin/bash "$PI_USER"
  for group in sudo adm; do usermod -aG "$group" "$PI_USER" || true; done
  HOME_DIR="$(getent passwd "$PI_USER" | cut -d: -f6)"
  mkdir -p "$HOME_DIR/.ssh"
  if [ -s /etc/pivault/authorized_keys ]; then
    touch "$HOME_DIR/.ssh/authorized_keys"
    while IFS= read -r key; do
      [ -n "$key" ] && ! grep -qxF "$key" "$HOME_DIR/.ssh/authorized_keys" \
        && echo "$key" >> "$HOME_DIR/.ssh/authorized_keys"
    done < /etc/pivault/authorized_keys
  fi
  chown -R "$PI_USER:$PI_USER" "$HOME_DIR/.ssh"
  chmod 700 "$HOME_DIR/.ssh"
  chmod 600 "$HOME_DIR/.ssh/authorized_keys" 2> /dev/null || true
  echo "$PI_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/010_pivault
  chmod 440 /etc/sudoers.d/010_pivault
else
  echo "warning: user $PI_USER does not exist yet"
fi
if [ -s /etc/pivault/authorized_keys ]; then
  # Key-only SSH: nobody can guess their way in with a password.
  mkdir -p /etc/ssh/sshd_config.d
  printf 'PasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-pivault.conf
fi
systemctl enable --now ssh || true
systemctl reload ssh 2> /dev/null || true

step "Wi-Fi"
if [ -n "$WIFI_SSID" ]; then
  raspi-config nonint do_wifi_country "$WIFI_COUNTRY" 2> /dev/null || true
  rfkill unblock wifi 2> /dev/null || true
  if ! nmcli -t -f NAME connection show | grep -qxF "$WIFI_SSID"; then
    for attempt in 1 2 3 4 5; do
      if nmcli device wifi connect "$WIFI_SSID" password "$WIFI_PASSWORD" 2>&1; then
        break
      fi
      echo "Wi-Fi not joined yet (attempt $attempt), retrying"
      sleep 10
      nmcli device wifi rescan 2> /dev/null || true
    done
  fi
  # Ethernet wins when both are connected.
  nmcli connection modify "$WIFI_SSID" ipv4.route-metric 600 ipv6.route-metric 600 2> /dev/null || true
else
  echo "no Wi-Fi configured; using Ethernet"
fi

step "Waiting for the internet"
ONLINE=0
for _ in $(seq 1 60); do
  if curl -fsS -m 5 -o /dev/null https://deb.debian.org/ 2> /dev/null; then
    ONLINE=1
    break
  fi
  sleep 5
done
if [ "$ONLINE" -ne 1 ]; then
  echo "No internet connection. Plug in Ethernet (or check the Wi-Fi details)."
  echo "Setup will try again in two minutes."
  exit 1
fi
echo "online"

step "Setting the clock"
timedatectl set-ntp true 2> /dev/null || true
# Package signatures fail to verify while the clock is far off.
for _ in $(seq 1 30); do
  [ "$(timedatectl show -p NTPSynchronized --value 2> /dev/null)" = "yes" ] && break
  sleep 2
done
date

step "Installing Ansible"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ansible rsync

step "Running the PiVault playbook"
cd /opt/pivault/infra/ansible
EXTRA=()
[ -f /etc/pivault/ansible-vars.yml ] && EXTRA+=(-e @/etc/pivault/ansible-vars.yml)
ansible-playbook -i localhost, -c local site.yml "${EXTRA[@]}"

mkdir -p /var/lib/pivault
date > /var/lib/pivault/provisioned

step "Done"
/opt/pivault/scripts/info.sh || true
echo
echo "=== PiVault first boot finished: $(date) ==="

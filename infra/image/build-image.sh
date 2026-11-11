#!/usr/bin/env bash
# Builds the PiVault SD-card image. Runs INSIDE a privileged Linux container; start it
# with infra/image/build.sh (Git Bash, WSL, Linux, macOS) or build.ps1 (PowerShell).
#
# What it does:
#   1. downloads the official Raspberry Pi OS Lite (64-bit) image and checks its hash
#   2. writes the headless setup files (user, SSH key, hostname, Wi-Fi) to the boot partition
#   3. copies this repository to /opt/pivault inside the image
#   4. installs a first-boot service that provisions the Pi with the Ansible playbook
#
# It does not flash anything. Write the result to an SD card with Raspberry Pi Imager.
set -euo pipefail

REPO=/repo
IMAGE_DIR="$REPO/infra/image"
WORK="$IMAGE_DIR/build"
CONFIG="$IMAGE_DIR/config.env"

# Pinned base image. To move to a newer Raspberry Pi OS release, update both lines
# (the .sha256 file sits next to the image on downloads.raspberrypi.com).
BASE_URL="https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-10-06/2026-10-06-raspios-trixie-arm64-lite.img.xz"
BASE_SHA256="483db18a48da399b5b7022ffae9a07bc6d99daab30e593aedac09b69ff422843"

BASE_XZ="$WORK/raspios-lite-arm64.img.xz"
OUT_IMG="$WORK/pivault-rpi5-arm64.img"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

say "Installing build tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq > /dev/null
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl xz-utils fdisk mount util-linux e2fsprogs dosfstools rsync openssl > /dev/null

# ---- settings ---------------------------------------------------------------
[ -f "$CONFIG" ] || die "infra/image/config.env not found. Copy config.env.example to config.env and edit it."
# Tolerate Windows line endings in the config file.
set -a
# shellcheck disable=SC1090
. <(sed 's/\r$//' "$CONFIG")
set +a

PI_HOSTNAME="${PI_HOSTNAME:-pivault}"
PI_TIMEZONE="${PI_TIMEZONE:-America/Toronto}"
PI_USER=pi   # the image's built-in uid 1000 account; it owns the stored files
WIFI_SSID="${WIFI_SSID:-}"
WIFI_PASSWORD="${WIFI_PASSWORD:-}"
WIFI_COUNTRY="${WIFI_COUNTRY:-CA}"
PIVAULT_ADMIN_EMAIL="${PIVAULT_ADMIN_EMAIL:-admin@pivault.local}"
PIVAULT_ADMIN_PASSWORD="${PIVAULT_ADMIN_PASSWORD:-}"
PI_PASSWORD="${PI_PASSWORD:-}"
TAILSCALE_AUTHKEY="${TAILSCALE_AUTHKEY:-}"
ALLOW_LAN_HTTP="${ALLOW_LAN_HTTP:-false}"

[[ "$PI_HOSTNAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "PI_HOSTNAME must be lower-case letters, digits and hyphens"
if [ -n "$WIFI_SSID" ] && [ "${#WIFI_PASSWORD}" -lt 8 ]; then
  die "WIFI_PASSWORD must be at least 8 characters (or leave WIFI_SSID empty for Ethernet only)"
fi

KEYS="$WORK/authorized_keys"
[ -s "$KEYS" ] || die "no SSH public key at infra/image/build/authorized_keys (build.sh creates it)"

random_password() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-"$1"; }
GENERATED=()
if [ -z "$PI_PASSWORD" ]; then PI_PASSWORD="$(random_password 16)"; GENERATED+=("Pi console password"); fi
if [ -z "$PIVAULT_ADMIN_PASSWORD" ]; then PIVAULT_ADMIN_PASSWORD="$(random_password 20)"; GENERATED+=("PiVault app password"); fi
[ "${#PIVAULT_ADMIN_PASSWORD}" -ge 8 ] || die "PIVAULT_ADMIN_PASSWORD must be at least 8 characters"

# Quote a value for YAML (double-quoted scalar).
yq() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# ---- base image -------------------------------------------------------------
mkdir -p "$WORK"
if [ ! -f "$BASE_XZ" ]; then
  say "Downloading Raspberry Pi OS Lite (about 550 MB)"
  curl -fL --retry 5 -o "$BASE_XZ.partial" "$BASE_URL"
  mv "$BASE_XZ.partial" "$BASE_XZ"
fi
say "Checking the download"
echo "$BASE_SHA256  $BASE_XZ" | sha256sum -c - > /dev/null || die "the Raspberry Pi OS download is corrupt; delete $BASE_XZ and run again"
echo "sha256 matches the published value"

say "Unpacking"
xz -dc -T0 "$BASE_XZ" > "$OUT_IMG"

# Partition offsets (in 512-byte sectors) from the partition table.
read -r BOOT_START BOOT_SIZE < <(sfdisk -d "$OUT_IMG" | awk -F'[=, ]+' '/img1/ {print $4, $6}')
read -r ROOT_START ROOT_SIZE < <(sfdisk -d "$OUT_IMG" | awk -F'[=, ]+' '/img2/ {print $4, $6}')
[ -n "$BOOT_START" ] && [ -n "$ROOT_START" ] || die "could not read the partition table"

BOOT=/mnt/pi-boot
ROOT=/mnt/pi-root
mkdir -p "$BOOT" "$ROOT"
cleanup() {
  sync
  mountpoint -q "$BOOT" && umount "$BOOT"
  mountpoint -q "$ROOT" && umount "$ROOT"
  return 0
}
trap cleanup EXIT

# ---- boot partition: headless setup ----------------------------------------
say "Writing the headless setup files"
mount -o loop,offset=$((BOOT_START * 512)),sizelimit=$((BOOT_SIZE * 512)) "$OUT_IMG" "$BOOT"

# Classic Raspberry Pi OS switches: enable SSH, and set the password for "pi".
: > "$BOOT/ssh"
printf '%s:%s\n' "$PI_USER" "$(openssl passwd -6 "$PI_PASSWORD")" > "$BOOT/userconf.txt"

# cloud-init (used by Raspberry Pi OS since the Debian 13 "trixie" release).
{
  echo "#cloud-config"
  echo "# Written by PiVault's build-image.sh."
  echo "hostname: $PI_HOSTNAME"
  echo "manage_etc_hosts: true"
  echo "timezone: $PI_TIMEZONE"
  echo "ssh_pwauth: false"
  echo "users:"
  echo "  - name: $PI_USER"
  echo "    gecos: PiVault"
  echo "    shell: /bin/bash"
  echo "    lock_passwd: false"
  echo "    groups: [sudo, adm, users]"
  echo "    sudo: \"ALL=(ALL) NOPASSWD:ALL\""
  echo "    ssh_authorized_keys:"
  while IFS= read -r key; do
    [ -n "$key" ] && echo "      - $(yq "$key")"
  done < <(sed 's/\r$//' "$KEYS")
} > "$BOOT/user-data"

if [ -n "$WIFI_SSID" ]; then
  {
    echo "# Written by PiVault's build-image.sh."
    echo "network:"
    echo "  version: 2"
    echo "  ethernets:"
    echo "    eth0:"
    echo "      dhcp4: true"
    echo "      dhcp6: true"
    echo "      optional: true"
    echo "  wifis:"
    echo "    wlan0:"
    echo "      dhcp4: true"
    echo "      dhcp6: true"
    echo "      optional: true"
    echo "      regulatory-domain: $(yq "$WIFI_COUNTRY")"
    echo "      access-points:"
    echo "        $(yq "$WIFI_SSID"):"
    echo "          password: $(yq "$WIFI_PASSWORD")"
  } > "$BOOT/network-config"
fi
umount "$BOOT"

# ---- root filesystem: PiVault itself ----------------------------------------
say "Copying PiVault into the image"
mount -o loop,offset=$((ROOT_START * 512)),sizelimit=$((ROOT_SIZE * 512)) "$OUT_IMG" "$ROOT"

mkdir -p "$ROOT/opt/pivault"
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '__pycache__' \
  --exclude '.pytest_cache' --exclude '.ruff_cache' --exclude '.coverage' \
  --exclude 'mobile/dist' --exclude 'mobile/.expo' --exclude 'mobile/test-results' \
  --exclude 'mobile/playwright-report' --exclude 'mobile/e2e' \
  --exclude 'infra/image/build' --exclude 'infra/image/config.env' \
  --exclude 'deploy/.env' --exclude 'docs/screenshots' \
  "$REPO/" "$ROOT/opt/pivault/"
chown -R 0:0 "$ROOT/opt/pivault"

# Scripts edited on Windows may carry CRLF line endings; Linux needs LF.
find "$ROOT/opt/pivault" -type f \( -name '*.sh' -o -name '*.yml' -o -name '*.yaml' -o -name '*.j2' \
  -o -name '*.service' -o -name '*.timer' -o -name 'Caddyfile' -o -name 'Dockerfile' -o -name '*.Dockerfile' \
  -o -name '*.py' -o -name '*.ini' -o -name '*.txt' -o -name '*.env.example' \) -exec sed -i 's/\r$//' {} +
find "$ROOT/opt/pivault" -type f -name '*.sh' -exec chmod 755 {} +

install -d -m 750 "$ROOT/etc/pivault"
install -m 600 <(sed 's/\r$//' "$KEYS") "$ROOT/etc/pivault/authorized_keys"

cat > "$ROOT/etc/pivault/image.env" <<EOF
# Written by PiVault's build-image.sh; read by the first-boot script.
PI_USER=$(printf '%q' "$PI_USER")
WIFI_SSID=$(printf '%q' "$WIFI_SSID")
WIFI_PASSWORD=$(printf '%q' "$WIFI_PASSWORD")
WIFI_COUNTRY=$(printf '%q' "$WIFI_COUNTRY")
EOF
chmod 600 "$ROOT/etc/pivault/image.env"

cat > "$ROOT/etc/pivault/ansible-vars.yml" <<EOF
# Settings for the PiVault playbook on this Pi. Edit, then run: sudo pivault-apply
pivault_hostname: $(yq "$PI_HOSTNAME")
pivault_timezone: $(yq "$PI_TIMEZONE")
pivault_user: $(yq "$PI_USER")
pivault_admin_email: $(yq "$PIVAULT_ADMIN_EMAIL")
pivault_admin_password: $(yq "$PIVAULT_ADMIN_PASSWORD")
tailscale_authkey: $(yq "$TAILSCALE_AUTHKEY")
allow_lan_http: $([ "$ALLOW_LAN_HTTP" = "true" ] && echo true || echo false)
EOF
chmod 600 "$ROOT/etc/pivault/ansible-vars.yml"

# The SSH key goes in directly as well, so login works even if cloud-init is skipped.
PI_HOME="$ROOT/home/$PI_USER"
install -d -m 755 -o 1000 -g 1000 "$PI_HOME"
install -d -m 700 -o 1000 -g 1000 "$PI_HOME/.ssh"
install -m 600 -o 1000 -g 1000 <(sed 's/\r$//' "$KEYS") "$PI_HOME/.ssh/authorized_keys"

echo "$PI_HOSTNAME" > "$ROOT/etc/hostname"

# First-boot service.
install -m 644 "$IMAGE_DIR/firstboot/pivault-firstboot.service" "$ROOT/etc/systemd/system/pivault-firstboot.service"
sed -i 's/\r$//' "$ROOT/etc/systemd/system/pivault-firstboot.service"
ln -sf /etc/systemd/system/pivault-firstboot.service \
  "$ROOT/etc/systemd/system/multi-user.target.wants/pivault-firstboot.service"

cat > "$ROOT/etc/motd" <<'EOF'

  PiVault server.   Status and login details:  sudo pivault-info
                    First-boot setup log:      sudo tail -f /var/log/pivault-firstboot.log
                    Set up the SSDs:           sudo pivault-setup-disks

EOF

USED="$(du -sm "$ROOT/opt/pivault" | cut -f1)"
echo "PiVault files in the image: ${USED} MB"
df -h "$ROOT" | tail -n1
umount "$ROOT"
trap - EXIT

# ---- verify -----------------------------------------------------------------
say "Verifying the image"
mount -o loop,ro,offset=$((BOOT_START * 512)),sizelimit=$((BOOT_SIZE * 512)) "$OUT_IMG" "$BOOT"
for f in ssh userconf.txt user-data cmdline.txt config.txt; do
  [ -e "$BOOT/$f" ] || die "boot partition is missing $f"
done
grep -q '^#cloud-config' "$BOOT/user-data" || die "user-data is malformed"
umount "$BOOT"
CHECK_DEV="$(losetup -f --show -o $((ROOT_START * 512)) --sizelimit $((ROOT_SIZE * 512)) "$OUT_IMG")"
e2fsck -fn "$CHECK_DEV" > /dev/null 2>&1 || { losetup -d "$CHECK_DEV"; die "the image's root filesystem failed its check"; }
losetup -d "$CHECK_DEV"
mount -o loop,ro,offset=$((ROOT_START * 512)),sizelimit=$((ROOT_SIZE * 512)) "$OUT_IMG" "$ROOT"
for f in opt/pivault/deploy/docker-compose.yml opt/pivault/infra/ansible/site.yml \
         opt/pivault/infra/image/firstboot/firstboot.sh opt/pivault/backend/Dockerfile \
         opt/pivault/mobile/package.json etc/pivault/ansible-vars.yml \
         etc/systemd/system/multi-user.target.wants/pivault-firstboot.service \
         "home/$PI_USER/.ssh/authorized_keys"; do
  [ -e "$ROOT/$f" ] || [ -L "$ROOT/$f" ] || die "image is missing /$f"
done
if grep -rIl $'\r' "$ROOT/opt/pivault/scripts" "$ROOT/opt/pivault/infra" "$ROOT/opt/pivault/deploy" > /dev/null 2>&1; then
  die "Windows line endings found in the image's scripts"
fi
umount "$ROOT"
echo "boot files, PiVault files and the first-boot service are all in place"

# ---- compress and report ----------------------------------------------------
say "Compressing (a few minutes)"
rm -f "$OUT_IMG.xz"
xz -T0 -3 "$OUT_IMG"
sha256sum "$OUT_IMG.xz" | sed "s#$WORK/##" > "$OUT_IMG.xz.sha256"

cat > "$WORK/credentials.txt" <<EOF
PiVault image credentials (keep this file private; it is not committed)
Built: $(date -u '+%Y-%m-%d %H:%M UTC')

PiVault app login
  Email:     $PIVAULT_ADMIN_EMAIL
  Password:  $PIVAULT_ADMIN_PASSWORD

Raspberry Pi
  Hostname:  $PI_HOSTNAME  (pivault.local on your home network)
  SSH:       ssh -i ~/.ssh/pivault_ed25519 $PI_USER@$PI_HOSTNAME.local
  Console:   user "$PI_USER", password "$PI_PASSWORD"  (keyboard and screen only; SSH uses the key)

Wi-Fi:       ${WIFI_SSID:-not configured (Ethernet only)}
Tailscale:   $([ -n "$TAILSCALE_AUTHKEY" ] && echo "joins automatically with the auth key" || echo "run 'sudo tailscale up' on the Pi once")
EOF
chmod 600 "$WORK/credentials.txt" 2> /dev/null || true

say "Done"
ls -lh "$OUT_IMG.xz" | awk '{print "Image:       infra/image/build/pivault-rpi5-arm64.img.xz (" $5 ")"}'
echo "Credentials: infra/image/build/credentials.txt"
[ "${#GENERATED[@]}" -gt 0 ] && echo "Generated:   ${GENERATED[*]} (see credentials.txt)"
echo
echo "Next: open Raspberry Pi Imager, choose 'Use custom', pick the .img.xz file, choose"
echo "your SD card and write it. If Imager offers to apply OS customisation, choose NO:"
echo "the image is already configured."

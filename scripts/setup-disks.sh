#!/usr/bin/env bash
# Prepare the SSDs for PiVault. Run on the Pi once the drives are plugged in:
#
#   sudo pivault-setup-disks
#
# It shows the drives it found, asks which one plays which role, and asks you to type
# a confirmation before it erases anything. Then it formats them, labels them, moves
# any data PiVault already stored on the SD card onto them, and restarts PiVault.
#
# Roles (labels):
#   pivault-data1, pivault-data2, ...   pooled by mergerfs at /mnt/storage
#   pivault-parity1                     SnapRAID parity (optional, needs 2+ drives)
#
# With one drive you get a plain data drive. With three 250 GB drives you get
# 500 GB usable that survives one drive failing.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
require_root

FALLBACK=/var/lib/pivault/sd-fallback
PLAYBOOK="$PIVAULT_HOME/infra/ansible/site.yml"

echo
echo "PiVault disk setup"
echo "=================="
echo

# The disk holding the running system must never be offered.
ROOT_SRC="$(findmnt -no SOURCE / 2>/dev/null || true)"
ROOT_PARENT="$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null | head -n1 || true)"
ROOT_DISK="/dev/${ROOT_PARENT:-none}"

# PIVAULT_TEST_DISKS lets the automated test hand in loop devices instead of real drives.
if [ -n "${PIVAULT_TEST_DISKS:-}" ]; then
  read -r -a DISKS <<< "$PIVAULT_TEST_DISKS"
else
  mapfile -t DISKS < <(lsblk -dnpo NAME,TYPE | awk '$2 == "disk" {print $1}' | grep -v -e "^$ROOT_DISK$" -e '/dev/zram' -e '/dev/loop' -e '/dev/ram' || true)
fi
if [ "${#DISKS[@]}" -eq 0 ]; then
  die "no drives found besides the SD card. Plug the SSD enclosures into the powered hub and try again."
fi

echo "Drives found (the SD card with the system is not listed):"
echo
i=1
for disk in "${DISKS[@]}"; do
  size="$(lsblk -dno SIZE "$disk")"
  model="$(lsblk -dno MODEL "$disk" | sed 's/ *$//')"
  serial="$(lsblk -dno SERIAL "$disk" | sed 's/ *$//')"
  labels="$(lsblk -no LABEL "$disk" | grep -v '^$' | paste -sd, - || true)"
  printf '  %d) %-12s %-8s %s  serial %s%s\n' "$i" "$disk" "$size" "${model:-unknown}" "${serial:-?}" \
    "${labels:+  (current labels: $labels)}"
  i=$((i + 1))
done
echo

COUNT="${#DISKS[@]}"
if [ "$COUNT" -ge 3 ]; then
  SUGGEST_PARITY=1
  echo "Suggested layout: the largest drive holds parity, the rest hold data."
else
  SUGGEST_PARITY=0
  echo "With $COUNT drive(s) there is no parity drive. Add drives later and run this again."
fi
echo

read -r -p "Use ALL of the drives listed above for PiVault? [y/N] " answer
[[ "$answer" =~ ^[Yy]$ ]] || die "cancelled. Unplug drives you do not want used, then run this again."

# Largest drive becomes parity: SnapRAID needs parity to be at least as big as any data drive.
mapfile -t SORTED < <(for d in "${DISKS[@]}"; do echo "$(lsblk -dnbo SIZE "$d") $d"; done | sort -rn | awk '{print $2}')
PARITY=()
DATA=("${SORTED[@]}")
if [ "$SUGGEST_PARITY" -eq 1 ]; then
  read -r -p "Reserve one drive for parity so the pool survives a drive failure? [Y/n] " answer
  if [[ ! "$answer" =~ ^[Nn]$ ]]; then
    PARITY=("${SORTED[0]}")
    DATA=("${SORTED[@]:1}")
  fi
fi

echo
echo "This will ERASE EVERYTHING on:"
n=1
for d in "${DATA[@]}"; do printf '  %-12s %-8s -> pivault-data%d\n' "$d" "$(lsblk -dno SIZE "$d")" "$n"; n=$((n + 1)); done
n=1
for d in "${PARITY[@]}"; do printf '  %-12s %-8s -> pivault-parity%d\n' "$d" "$(lsblk -dno SIZE "$d")" "$n"; n=$((n + 1)); done
echo
read -r -p "Type ERASE to continue: " confirm
[ "$confirm" = "ERASE" ] || die "cancelled, nothing was changed"

echo
log "checking drive health (SMART)"
for d in "${DATA[@]}" "${PARITY[@]}"; do
  if smartctl -H "$d" 2>/dev/null | grep -qiE 'FAILED|FAILING'; then
    die "$d reports a failing SMART status. Do not trust it with photos."
  fi
done

log "stopping PiVault"
if [ -f "$PIVAULT_COMPOSE" ] && [ -f "$PIVAULT_HOME/deploy/.env" ]; then
  compose down || true
fi

# Move whatever PiVault stored on the SD card out of the way, so the new drives can
# be mounted in its place and the data copied back onto them.
mkdir -p "$FALLBACK"
for dir in /mnt/storage /mnt/disk1; do
  if [ -d "$dir" ] && ! mountpoint -q "$dir" && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    name="$(basename "$dir")"
    log "setting aside existing data from $dir"
    chattr -i "$dir" 2>/dev/null || true
    rm -rf "${FALLBACK:?}/$name"
    mv "$dir" "$FALLBACK/$name"
    mkdir -p "$dir"
  fi
done

# Unmount anything currently using the pool or the drives.
umount /mnt/storage 2>/dev/null || true
systemctl stop mnt-storage.mount 2>/dev/null || true
for d in "${DATA[@]}" "${PARITY[@]}"; do
  for part in $(lsblk -lnpo NAME "$d"); do umount "$part" 2>/dev/null || true; done
done

format() {
  local disk="$1" label="$2" part=""
  log "formatting $disk as $label"
  wipefs -a "$disk" > /dev/null
  if [ -n "${PIVAULT_TEST_DISKS:-}" ]; then
    # Loop devices in the test machine get no partition nodes; use the whole device.
    part="$disk"
  else
    parted -s "$disk" mklabel gpt mkpart primary ext4 1MiB 100%
    partprobe "$disk" || true
    udevadm settle || true
    # The partition can take a moment to appear on USB enclosures.
    for _ in $(seq 1 20); do
      part="$(lsblk -lnpo NAME "$disk" | sed -n 2p)"
      [ -n "$part" ] && [ -b "$part" ] && break
      sleep 0.5
    done
    [ -n "$part" ] && [ -b "$part" ] || die "could not find the new partition on $disk"
  fi
  # -m 0: no space reserved for root on a pure data drive. -T largefile for parity.
  if [[ "$label" == pivault-parity* ]]; then
    mkfs.ext4 -q -F -m 0 -T largefile4 -L "$label" "$part"
  else
    mkfs.ext4 -q -F -m 0 -L "$label" "$part"
  fi
}

n=1
for d in "${DATA[@]}"; do format "$d" "pivault-data$n"; n=$((n + 1)); done
n=1
for d in "${PARITY[@]}"; do format "$d" "pivault-parity$n"; n=$((n + 1)); done
udevadm settle

log "configuring mounts, the mergerfs pool and SnapRAID"
ansible-playbook -i localhost, -c local "$PLAYBOOK" --tags storage \
  -e @/etc/pivault/ansible-vars.yml > /var/log/pivault-setup-disks.log 2>&1 \
  || die "storage configuration failed; see /var/log/pivault-setup-disks.log"

mountpoint -q /mnt/disk1 || die "/mnt/disk1 did not mount; see /var/log/pivault-setup-disks.log"
mountpoint -q /mnt/storage || die "/mnt/storage did not mount; see /var/log/pivault-setup-disks.log"

# Copy the data that was on the SD card onto the new drives.
if [ -d "$FALLBACK/storage" ]; then
  log "copying existing photos and files onto the pool"
  rsync -aHAX --info=progress2 "$FALLBACK/storage/" /mnt/storage/
fi
if [ -d "$FALLBACK/disk1/postgres" ]; then
  log "copying the database onto drive 1"
  rsync -aHAX "$FALLBACK/disk1/postgres" /mnt/disk1/
fi

log "starting PiVault"
ansible-playbook -i localhost, -c local "$PLAYBOOK" --tags storage,app \
  -e @/etc/pivault/ansible-vars.yml >> /var/log/pivault-setup-disks.log 2>&1 \
  || die "could not start PiVault; see /var/log/pivault-setup-disks.log"

echo
log "done"
df -h /mnt/storage /mnt/disk* /mnt/parity* 2>/dev/null || true
echo
if [ -d "$FALLBACK/storage" ] || [ -d "$FALLBACK/disk1" ]; then
  echo "The old copy from the SD card is still in $FALLBACK."
  echo "Once you have checked your photos in the app, free the space with:"
  echo "  sudo rm -rf $FALLBACK"
fi
if [ "${#PARITY[@]}" -gt 0 ]; then
  echo "Parity is built by the nightly job. To build it now: sudo pivault-snapraid-sync"
fi

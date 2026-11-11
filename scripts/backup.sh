#!/usr/bin/env bash
# Nightly 03:30: encrypted, deduplicated, versioned backup with restic.
#
# Backs up the originals, the Files area and the database dumps to every repository
# configured in /etc/pivault/restic.env (an external drive and/or Backblaze B2), then
# keeps 7 daily, 4 weekly and 12 monthly snapshots.
#
# Thumbnails are not backed up: the worker can rebuild them from the originals
# (`python -m app.cli reprocess`).
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"

CONFIG="${PIVAULT_RESTIC_ENV:-/etc/pivault/restic.env}"
if [ ! -f "$CONFIG" ]; then
  log "no $CONFIG yet: offsite backup is not set up (see docs/SETUP.md, 'Backups')"
  exit 0
fi
set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

[ -n "${RESTIC_PASSWORD_FILE:-}" ] && [ -s "${RESTIC_PASSWORD_FILE:-/nonexistent}" ] \
  || die "RESTIC_PASSWORD_FILE is not set or the file is empty"

PATHS=()
for sub in originals files db-dumps; do
  [ -d "$PIVAULT_DATA/$sub" ] && PATHS+=("$PIVAULT_DATA/$sub")
done
[ "${#PATHS[@]}" -gt 0 ] || die "nothing to back up under $PIVAULT_DATA"

backup_to() {
  local name="$1" repo="$2" job="restic_$1"
  log "[$name] backing up to $repo"
  if ! restic -r "$repo" cat config > /dev/null 2>&1; then
    log "[$name] repository does not exist yet; creating it"
    restic -r "$repo" init || return 1
  fi
  # Explicit returns: bash turns off "exit on error" inside a function called with ||.
  restic -r "$repo" backup "${PATHS[@]}" --tag pivault --host "$(hostname)" --exclude-caches \
    || return 1
  restic -r "$repo" forget --tag pivault --host "$(hostname)" \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune || return 1
  record_metric "$job" 1
  log "[$name] done"
}

FAILED=0
RAN=0
if [ -n "${RESTIC_REPO_LOCAL:-}" ]; then
  RAN=1
  # An unplugged backup drive must not turn into a backup onto the SD card.
  MOUNT="${RESTIC_LOCAL_MOUNT:-}"
  if [ -n "$MOUNT" ] && ! mountpoint -q "$MOUNT"; then
    log "[local] $MOUNT is not mounted; skipping"
    record_metric restic_local 0
    FAILED=1
  else
    backup_to local "$RESTIC_REPO_LOCAL" || { record_metric restic_local 0; FAILED=1; }
  fi
fi
if [ -n "${RESTIC_REPO_B2:-}" ]; then
  RAN=1
  backup_to b2 "$RESTIC_REPO_B2" || { record_metric restic_b2 0; FAILED=1; }
fi

[ "$RAN" -eq 1 ] || log "no repositories configured in $CONFIG"
[ "$FAILED" -eq 0 ] || die "one or more backups failed"

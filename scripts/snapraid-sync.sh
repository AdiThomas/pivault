#!/usr/bin/env bash
# Nightly 03:00: update SnapRAID parity. With `scrub` as the first argument (weekly),
# check part of the array for silent corruption instead.
#
# Safety: if an unusual number of files disappeared since the last sync, the sync is
# skipped. Syncing would make that deletion permanent in parity, which is exactly what
# you do not want after an accident or a dying drive.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="${1:-sync}"
JOB="snapraid_$MODE"
DELETE_LIMIT="${PIVAULT_SNAPRAID_DELETE_LIMIT:-500}"

if [ ! -f /etc/snapraid.conf ] || ! grep -q '^parity ' /etc/snapraid.conf; then
  log "SnapRAID is not configured (no parity drive); nothing to do"
  exit 0
fi
trap 'record_metric "$JOB" 0; log "snapraid $MODE FAILED"' ERR

# A drive that dropped out of the pool shows up as an empty mount point.
for dir in $(awk '$1 == "data" {print $3}' /etc/snapraid.conf) \
           $(awk '$1 == "parity" {print $2}' /etc/snapraid.conf | xargs -n1 dirname); do
  mountpoint -q "$dir" || die "$dir is not mounted; refusing to touch parity"
done

if [ "$MODE" = "scrub" ]; then
  log "scrubbing 12% of the array (blocks not checked in the last 10 days)"
  snapraid scrub -p 12 -o 10
  record_metric "$JOB" 1
  log "scrub finished"
  exit 0
fi

log "checking what changed since the last sync"
# diff exits 2 when there are differences, which is the normal case.
DIFF="$(snapraid diff 2>&1)" || [ $? -eq 2 ]
REMOVED="$(printf '%s\n' "$DIFF" | awk '/^ *[0-9]+ removed$/ {print $1}' | tail -n1)"
REMOVED="${REMOVED:-0}"
log "files removed since last sync: $REMOVED (limit $DELETE_LIMIT)"

if [ "$REMOVED" -gt "$DELETE_LIMIT" ]; then
  record_metric "$JOB" 0 pivault_snapraid_removed_files "$REMOVED"
  die "$REMOVED files were removed, more than the limit of $DELETE_LIMIT. Parity was NOT updated. If the deletions are intended, run: sudo snapraid sync"
fi

snapraid sync
record_metric "$JOB" 1 pivault_snapraid_removed_files "$REMOVED"
log "sync finished"

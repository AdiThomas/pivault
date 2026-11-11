#!/usr/bin/env bash
# Monthly: prove the backup can actually be restored.
#
# Picks one random month folder of originals, restores it from the newest restic
# snapshot into a scratch directory, and compares every restored file with the live
# copy by SHA-256. A backup you have never restored from is only a hope.
#
#   sudo restore-test.sh            # uses the local repo, else B2
#   sudo restore-test.sh b2         # force a repository
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"

JOB=restore_test
CONFIG="${PIVAULT_RESTIC_ENV:-/etc/pivault/restic.env}"
if [ ! -f "$CONFIG" ]; then
  log "no $CONFIG yet: offsite backup is not set up, nothing to test"
  exit 0
fi
set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

case "${1:-auto}" in
  local) REPO="${RESTIC_REPO_LOCAL:-}" ;;
  b2) REPO="${RESTIC_REPO_B2:-}" ;;
  *) REPO="${RESTIC_REPO_LOCAL:-${RESTIC_REPO_B2:-}}" ;;
esac
[ -n "$REPO" ] || die "no restic repository configured"

SCRATCH="$(mktemp -d "${PIVAULT_RESTORE_SCRATCH:-/var/tmp}/pivault-restore.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
trap 'record_metric "$JOB" 0; log "restore test FAILED"' ERR

# A random YYYY/MM folder that exists in the newest snapshot. restic lists one level
# at a time, so pick a year first and then a month inside it.
children() {
  restic -r "$REPO" ls latest --tag pivault "$1" 2>/dev/null | grep -E "^$1/$2$" || true
}
YEARS="$(children "$PIVAULT_DATA/originals" '[0-9]{4}')"
[ -n "$YEARS" ] || die "the newest snapshot contains no originals to test"
YEAR="$(shuf -n1 <<< "$YEARS")"
MONTHS="$(children "$YEAR" '[0-9]{2}')"
[ -n "$MONTHS" ] || die "the newest snapshot has an empty year folder: $YEAR"
TARGET="$(shuf -n1 <<< "$MONTHS")"

log "restoring $TARGET from $REPO"
restic -r "$REPO" restore latest --tag pivault --include "$TARGET" --target "$SCRATCH"

RESTORED="$SCRATCH$TARGET"
[ -d "$RESTORED" ] || die "restore produced no files"

TOTAL=0
BAD=0
MISSING_LIVE=0
while IFS= read -r -d '' file; do
  rel="${file#"$RESTORED"/}"
  live="$TARGET/$rel"
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$live" ]; then
    # Deleted from the server since the snapshot (for example purged from the trash).
    MISSING_LIVE=$((MISSING_LIVE + 1))
    continue
  fi
  if [ "$(sha256sum < "$file")" != "$(sha256sum < "$live")" ]; then
    BAD=$((BAD + 1))
    log "MISMATCH: $rel"
  fi
done < <(find "$RESTORED" -type f -print0)

[ "$TOTAL" -gt 0 ] || die "the restored folder is empty"
log "restored $TOTAL files from $TARGET: $BAD mismatched, $MISSING_LIVE no longer on the server"

if [ "$BAD" -gt 0 ]; then
  record_metric "$JOB" 0 pivault_restore_test_files "$TOTAL"
  die "$BAD restored files differ from the live copies"
fi
record_metric "$JOB" 1 pivault_restore_test_files "$TOTAL"
log "restore test passed"

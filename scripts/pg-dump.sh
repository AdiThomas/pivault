#!/usr/bin/env bash
# Nightly 02:30: dump the PiVault database into the storage pool, where SnapRAID and
# restic pick it up along with the photos.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"

JOB=pg_dump
KEEP_DAYS="${PIVAULT_DUMP_KEEP_DAYS:-14}"
DEST="$PIVAULT_DATA/db-dumps"
trap 'record_metric "$JOB" 0; log "database dump FAILED"' ERR

mkdir -p "$DEST"
OUT="$DEST/pivault-$(date +%F).dump"
TMP="$OUT.partial"

log "dumping database to $OUT"
# Custom format: compressed, and pg_restore can restore single tables from it.
compose exec -T postgres pg_dump -U pivault -Fc pivault > "$TMP"
[ -s "$TMP" ] || die "dump is empty"
# Check the archive is readable before trusting it.
compose exec -T postgres pg_restore --list < "$TMP" > /dev/null
mv "$TMP" "$OUT"

find "$DEST" -name 'pivault-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name '*.partial' -mtime +1 -delete

record_metric "$JOB" 1 pivault_db_dump_bytes "$(stat -c %s "$OUT")"
log "database dump finished ($(du -h "$OUT" | cut -f1))"

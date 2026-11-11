#!/usr/bin/env bash
# End-to-end check against a running PiVault server: log in, upload a photo and a
# video, wait for the worker, fetch thumbnails, seek inside the video, trash, restore.
#
#   scripts/smoke-test.sh http://localhost:8000 admin@pivault.dev pivault-dev-pass
#
# Needs curl. Uses the sample media in mobile/e2e/fixtures.
set -euo pipefail

BASE="${1:-http://localhost:8000}"
EMAIL="${2:-admin@pivault.dev}"
PASSWORD="${3:-pivault-dev-pass}"
FIXTURES="$(cd "$(dirname "$0")/../mobile/e2e/fixtures" && pwd)"

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; exit 1; }
# Pull one string value out of a flat JSON response without needing jq.
json() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1; }

echo "PiVault smoke test against $BASE"

curl -fsS "$BASE/api/health" | grep -q '"status":"ok"' && pass "health" || fail "health"

TOKEN=$(curl -fsS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | json access_token)
[ -n "$TOKEN" ] && pass "login" || fail "login"
AUTH="Authorization: Bearer $TOKEN"

DEVICE=$(curl -fsS -X POST "$BASE/api/devices" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test","platform":"script"}' | json id)
[ -n "$DEVICE" ] && pass "register device" || fail "register device"

# A unique file each run, so the upload is always new content.
STAMP="smoke-$(date +%s)-$RANDOM"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Git Bash on Windows: curl needs a Windows-style path for -F file=@...
if command -v cygpath >/dev/null 2>&1; then TMP=$(cygpath -m "$TMP"); fi
cp "$FIXTURES/sunset.jpg" "$TMP/photo.jpg"
printf '%s' "$STAMP" >> "$TMP/photo.jpg"   # trailing bytes after the JPEG end marker are ignored
cp "$FIXTURES/clip.mp4" "$TMP/clip.mp4"
# Unique too, so the cleanup at the end can never delete a video you already had.
printf '%s' "$STAMP" >> "$TMP/clip.mp4"

MISSING=$(curl -fsS -X POST "$BASE/api/assets/check" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"device_id\":\"$DEVICE\",\"device_asset_ids\":[\"$STAMP\"]}")
echo "$MISSING" | grep -q "$STAMP" && pass "check reports the new photo as missing" || fail "check"

PHOTO=$(curl -fsS -X POST "$BASE/api/assets" -H "$AUTH" \
  -F "file=@$TMP/photo.jpg;type=image/jpeg" -F "device_id=$DEVICE" -F "device_asset_id=$STAMP" | json id)
[ -n "$PHOTO" ] && pass "upload photo ($PHOTO)" || fail "upload photo"

DUP=$(curl -fsS -X POST "$BASE/api/assets" -H "$AUTH" -F "file=@$TMP/photo.jpg;type=image/jpeg")
echo "$DUP" | grep -q '"duplicate":true' && pass "second upload is deduplicated" || fail "dedup"

MISSING=$(curl -fsS -X POST "$BASE/api/assets/check" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"device_id\":\"$DEVICE\",\"device_asset_ids\":[\"$STAMP\"]}")
echo "$MISSING" | grep -q '"missing":\[\]' && pass "check now reports it as backed up" || fail "check after upload"

VIDEO=$(curl -fsS -X POST "$BASE/api/assets" -H "$AUTH" -F "file=@$TMP/clip.mp4;type=video/mp4" | json id)
[ -n "$VIDEO" ] && pass "upload video ($VIDEO)" || fail "upload video"

wait_ready() {
  for _ in $(seq 1 60); do
    STATUS=$(curl -fsS "$BASE/api/assets/$1" -H "$AUTH" | json status)
    [ "$STATUS" = "ready" ] && return 0
    [ "$STATUS" = "failed" ] && return 1
    sleep 1
  done
  return 1
}
wait_ready "$PHOTO" && pass "worker processed the photo" || fail "photo never became ready"
wait_ready "$VIDEO" && pass "worker processed the video" || fail "video never became ready"

for ID in "$PHOTO" "$VIDEO"; do
  TYPE=$(curl -fsS -o /dev/null -w '%{content_type}' "$BASE/api/assets/$ID/thumbnail" -H "$AUTH")
  [ "$TYPE" = "image/webp" ] || fail "thumbnail for $ID (got $TYPE)"
done
pass "thumbnails are WebP"

CODE=$(curl -fsS -o "$TMP/range.bin" -w '%{http_code}' -H "$AUTH" -H 'Range: bytes=1000-1999' \
  "$BASE/api/assets/$VIDEO/original")
SIZE=$(wc -c < "$TMP/range.bin" | tr -d ' ')
[ "$CODE" = "206" ] && [ "$SIZE" = "1000" ] && pass "video supports Range requests (seek)" \
  || fail "range request (code $CODE, $SIZE bytes)"

curl -fsS -o "$TMP/back.jpg" "$BASE/api/assets/$PHOTO/original" -H "$AUTH"
cmp -s "$TMP/photo.jpg" "$TMP/back.jpg" && pass "download matches the upload byte for byte" \
  || fail "download differs from upload"

curl -fsS -X DELETE "$BASE/api/assets/$PHOTO" -H "$AUTH" -o /dev/null && pass "move to trash" || fail "trash"
curl -fsS -X POST "$BASE/api/assets/$PHOTO/restore" -H "$AUTH" -o /dev/null && pass "restore" || fail "restore"

# Clean up what this run created.
curl -fsS -X DELETE "$BASE/api/assets/$PHOTO?permanent=true" -H "$AUTH" -o /dev/null
curl -fsS -X DELETE "$BASE/api/assets/$VIDEO?permanent=true" -H "$AUTH" -o /dev/null
curl -fsS -X DELETE "$BASE/api/devices/$DEVICE" -H "$AUTH" -o /dev/null
pass "cleanup"

curl -fsS "$BASE/api/stats" -H "$AUTH" | grep -q '"disk_free"' && pass "stats" || fail "stats"
echo "All checks passed."

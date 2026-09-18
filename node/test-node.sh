#!/usr/bin/env bash
# Conformance check for a deployed Amply node.
#   ./test-node.sh https://amply-test-node.example.workers.dev
#
# Exercises the behaviour a music player actually depends on — seeking above
# all. Typechecking cannot catch any of this; only a deployed node can.
set -uo pipefail

BASE="${1:-}"
[ -z "$BASE" ] && { echo "usage: $0 <node-base-url>"; exit 2; }
BASE="${BASE%/}"
PASS=0; FAIL=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then printf "  ok   %-32s %s\n" "$1" "$3"; PASS=$((PASS+1))
  else printf "  FAIL %-32s expected %s, got %s\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
code() { curl -s -m 25 -o /dev/null -w '%{http_code}' "$@"; }

echo "Testing $BASE"

MANIFEST=$(curl -s -m 25 "$BASE/manifest.json")
AUDIO=$(printf '%s' "$MANIFEST" | tr ',' '\n' | grep -oE 'https://[^"]+\.(m4a|mp3|ogg|flac|wav)' | head -1)

echo
echo "manifest + version"
check "manifest 200"        200 "$(code "$BASE/manifest.json")"
check "manifest CORS"       "*" "$(curl -s -m 25 -D- -o /dev/null "$BASE/manifest.json" | grep -i '^access-control-allow-origin' | tr -d '\r' | awk '{print $2}')"
check "version 200"         200 "$(code "$BASE/version")"

# A node with no tracks yet is a correctly provisioned node, not a broken one.
# Say so plainly rather than reporting a failure that is really an empty catalog.
if [ -z "$AUDIO" ]; then
  echo
  echo "audio + seeking"
  echo "  --   no tracks published yet — skipping (this is normal for a new node)"
  echo
  echo "safety"
  check "missing key 404"     404 "$(code "$BASE/audio/does-not-exist.m4a")"
  check "path traversal 400"  400 "$(code "$BASE/audio/..%2F..%2Fsecret")"
  check "unknown route 404"   404 "$(code "$BASE/admin")"
  echo
  echo "$PASS passed, $FAIL failed (audio checks skipped — no tracks)"
  [ "$FAIL" -eq 0 ] || exit 1
  exit 0
fi

echo
echo "audio + seeking"
check "full GET 200"        200 "$(code "$AUDIO")"
check "range 206"           206 "$(code -H 'Range: bytes=0-1023' "$AUDIO")"
check "mid-file seek 206"   206 "$(code -H 'Range: bytes=400000-' "$AUDIO")"
check "beyond EOF 416"      416 "$(code -H 'Range: bytes=99999999-' "$AUDIO")"
check "accept-ranges"       bytes "$(curl -s -m 25 -D- -o /dev/null "$AUDIO" | grep -i '^accept-ranges' | tr -d '\r' | awk '{print $2}')"
check "range byte accuracy" 100 "$(curl -s -m 25 -H 'Range: bytes=100-199' "$AUDIO" | wc -c | tr -d ' ')"

ETAG=$(curl -s -m 25 -D- -o /dev/null "$AUDIO" | grep -i '^etag' | tr -d '\r' | cut -d' ' -f2)
check "conditional 304"     304 "$(code -H "If-None-Match: $ETAG" "$AUDIO")"
check "HEAD has no body"    0   "$(curl -s -m 25 -I "$AUDIO" -o /dev/null -w '%{size_download}')"

echo
echo "safety"
check "missing key 404"     404 "$(code "$BASE/audio/does-not-exist.m4a")"
check "path traversal 400"  400 "$(code "$BASE/audio/..%2F..%2Fsecret")"
check "unknown route 404"   404 "$(code "$BASE/admin")"
check "OPTIONS 204"         204 "$(code -X OPTIONS "$AUDIO")"
check "POST rejected 405"   405 "$(code -X POST "$AUDIO")"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1

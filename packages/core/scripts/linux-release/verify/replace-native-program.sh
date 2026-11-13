#!/bin/sh
# Runs the remote Native replacement program against a live process on Linux:
#   docker run --rm --platform linux/amd64 -v DIR:/t:ro node:24-bookworm sh /t/replace-native-program.sh
# DIR holds this script and replace-native.cjs (the REPLACE_NATIVE program text).
set -eu
state="$(mktemp -d)"; mkdir -p "$state/ctxmux/replay" "$state/core-releases"; chmod 700 "$state/ctxmux"
printf db > "$state/ctxmux/state.sqlite3"; printf wal > "$state/ctxmux/state.sqlite3-wal"; printf r > "$state/ctxmux/replay/replay-1.bin"
chmod 600 "$state/ctxmux/state.sqlite3" "$state/ctxmux/state.sqlite3-wal"
start_native() { node -e "process.on('SIGINT',()=>process.exit(0)); setInterval(()=>{},1000)" & native=$!; sleep 0.3
  ticks=$(awk '{print $22}' "/proc/$native/stat"); sha=$(sha256sum "/proc/$native/exe" | cut -d' ' -f1); }
input() { printf '{"pid":%s,"startTicks":"%s","nativeSha256":"%s","stateDirectory":"%s","nativeStateDirectory":"%s/ctxmux","reserveBytes":%s,"stop":%s,"copyDirectory":"%s/core-releases/op.native-state","runProcessIds":[]}' \
  "$native" "$2" "$sha" "$state" "$state" "$3" "$1" "$state"; }
fail() { echo "FAIL: $*"; exit 1; }
start_native
echo "== the plan confirms the process and the room for a copy"; input false "$ticks" 0 | node /t/replace-native.cjs | grep -q '"ready":true' || fail "plan"
echo "== a changed birth identity is refused before any signal"
input true 1 0 | node /t/replace-native.cjs | grep -q '"outcome":"refused"' || fail "changed process accepted"; kill -0 "$native" || fail "signalled a changed process"
echo "== too little space is refused before any signal"
input true "$ticks" 9007199254740991 | node /t/replace-native.cjs | grep -q '"outcome":"refused"' || fail "space"; kill -0 "$native" || fail "signalled without space"
echo "== the exact Native stops and its whole state is copied with its modes"
input true "$ticks" 0 | node /t/replace-native.cjs | grep -q '"outcome":"replaced"' || fail "replace"
kill -0 "$native" 2>/dev/null && fail "native still alive"
copy="$state/core-releases/op.native-state"
[ "$(stat -c %a "$copy")" = 700 ] && [ "$(stat -c %a "$copy/state.sqlite3")" = 600 ] || fail "modes"
cmp -s "$state/ctxmux/state.sqlite3-wal" "$copy/state.sqlite3-wal" && cmp -s "$state/ctxmux/replay/replay-1.bin" "$copy/replay/replay-1.bin" || fail "contents"
echo "== a failed copy leaves no partial copy"
start_native
input true "$ticks" 0 | node /t/replace-native.cjs | grep -q '"outcome":"copy-failed"' || fail "copy over an existing copy"
[ -z "$(ls "$state/core-releases" | grep partial || true)" ] || fail "partial left"
echo PASS

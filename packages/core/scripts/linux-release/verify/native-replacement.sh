#!/bin/sh
# End-to-end Native replacement on Linux, from a real older release to this candidate.
#   docker run --rm --platform linux/amd64 \
#     -v OLD:/old:ro -v RELEASE:/release:ro -v VERIFY:/verify:ro node:24-bookworm sh /verify/native-replacement.sh
# OLD is an installed release directory (with deployment.json) whose Native is older than the
# candidate's; RELEASE holds the candidate tarball; VERIFY holds this script and the driver.
# Both the old Core and the client side run with the candidate's bundled Node.
# Set FAIL_COPY=1 to make the state copy fail after the stop and check that the original Core
# and Native come back.
set -eu
export HOME=/home/amux; mkdir -p "$HOME" && cd "$HOME"
fail() { echo "FAIL: $*"; exit 1; }
archive="$(ls /release/agentmux-core-*-linux-x64.tar.gz)"; name="$(basename "$archive" .tar.gz)"
tar -xzf "$archive" -C /tmp
node_dir="/tmp/$name/node/dist"; node="$node_dir/bin/node"
state="$HOME/.agentmux/server/state" runtime="$HOME/.agentmux/server/runtime"
mkdir -p "$state/core-releases" "$runtime"; chmod 700 "$HOME/.agentmux/server" "$state" "$runtime"
old_digest="$(basename "$(readlink -f /old)")"
cp -R /old "$state/core-releases/$old_digest"
# The old launcher names the Node and paths of its original host; rewrite it for this one.
printf "#!/bin/sh\nexec '%s' '%s/dist/agentmux.js' \"\$@\"\n" "$node" "$state/core-releases/$old_digest" > "$state/core-releases/$old_digest/launcher/amux"
ln -s "$old_digest" "$state/core-releases/current"
echo "== start the old Core; it activates the old Native"
cd "$HOME"
env -i HOME="$HOME" PATH="$node_dir/bin:/usr/bin:/bin" SHELL=/bin/sh LANG=C.UTF-8 \
  AGENTMUX_STATE_DIRECTORY="$state" AGENTMUX_RUNTIME_DIRECTORY="$runtime" AGENTMUX_AGENT_SESSION_STORE="$state/agent-sessions.json" \
  setsid "$node" "$state/core-releases/$old_digest/dist/headless-runtime-cli.js" serve >> "$state/serve.log" 2>&1 < /dev/null &
for attempt in $(seq 1 120); do [ -S "$runtime/control.sock" ] && [ -S "$runtime/ctxmux.sock" ] && break; sleep 0.5; done
[ -S "$runtime/ctxmux.sock" ] || { tail -20 "$state/serve.log"; fail "the old Native did not start"; }
FAIL_COPY="${FAIL_COPY:-0}" "$node" /verify/native-replacement-driver.mjs "$state" "$runtime" "$old_digest" "/tmp/$name"

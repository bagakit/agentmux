#!/bin/sh
# Runs inside a clean linux/amd64 container that has python3 and no Node:
#   docker run --rm --platform linux/amd64 -v DIR:/release:ro python:3.12-slim-bookworm \
#     sh -c 'ln -sf /usr/local/bin/python3 /usr/bin/python3; sh /release/verify/container.sh'
# DIR holds the built tarball and this verify/ directory.
set -eu
export HOME=/home/amux
mkdir -p "$HOME" && cd "$HOME"
if command -v node >/dev/null 2>&1; then echo "FAIL: this check needs a machine without Node"; exit 1; fi
archive="$(ls /release/agentmux-core-*-linux-x64.tar.gz)"
name="$(basename "$archive" .tar.gz)"
tar -xzf "$archive" -C /tmp
"/tmp/$name/install.sh"
server="$HOME/.agentmux/server" socket="$HOME/.agentmux/server/runtime/control.sock"
echo "== JSON-RPC over the stdio pipe that SSH uses"
reply="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"runtime.owner.identity","params":{}}' | "$server/bin/amux" --endpoint "unix:$socket" system endpoint --stdio)"
echo "$reply" | grep -q '"runtimeId"' || { echo "FAIL: no Runtime identity: $reply"; exit 1; }
echo "ok"
echo "== the current release pointer names the installed release"
current="$(readlink "$server/state/core-releases/current")"
[ -f "$server/state/core-releases/$current/deployment.json" ] || { echo "FAIL: current does not name an installed release: $current"; exit 1; }
echo "ok"
echo "== rerunning install keeps the serving Core and its release"
"/tmp/$name/install.sh" | grep -q "already serving" || { echo "FAIL: second install did not reuse the serving Core"; exit 1; }
[ "$(readlink "$server/state/core-releases/current")" = "$current" ] || { echo "FAIL: a rerun moved the current release"; exit 1; }
echo "ok"
echo "== restart follows the current release"
"$server/bin/amux" --endpoint "unix:$socket" system endpoint --inspect >/dev/null
pid="$(cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\0' ' ' | grep -o "core-releases/$current/dist/headless-runtime-cli.js serve" | head -1)"
[ -n "$pid" ] || { echo "FAIL: the serving Core does not run the current release"; exit 1; }
echo "ok"
echo "== no AgentMux TypeScript source, source map or declaration installed"
leaked="$(find "$server/state/core-releases" \( -name '*.ts' -o -name '*.js.map' \) -path '*/@agentmux/*' -not -path '*/@agentmux/*/node_modules/*' | head -5)"
leaked="$leaked$(find "$server/state/core-releases"/*/dist \( -name '*.d.ts' -o -name '*.js.map' \) | head -5)"
[ -z "$leaked" ] || { echo "FAIL: development files shipped:"; echo "$leaked"; exit 1; }
echo "ok"
echo "== the App's Core upgrade check accepts this installation"
node="$(ls -d "$server"/node/*/bin/node)"
result="$("$node" /release/verify/upgrade-check.mjs)"
echo "$result"
echo "$result" | grep -q '"eligible": true' || { echo "FAIL: the upgrade check did not qualify this installation"; exit 1; }
echo "PASS"

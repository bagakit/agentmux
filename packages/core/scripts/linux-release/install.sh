#!/bin/sh
# AgentMux headless Core installer for Linux x64.
#
# Installs this release with its bundled Node, starts the headless Core and
# prints the values to save on the client's Host (Service command, socket path).
# A Core that is already serving keeps running; existing state, Sessions and
# Runs are never deleted. Rerunning with a newer release stages it beside the
# old one; replace the serving Core from the App (Connection → Core upgrade).
#
#   ./install.sh [--prefix DIR] [--no-start]
#
# DIR defaults to ~/.agentmux/server. Agent CLIs (codex, claude, ...) must be on
# PATH for this user when the Core starts.
set -eu

prefix="${AGENTMUX_SERVER_PREFIX:-$HOME/.agentmux/server}"
start=1
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || { echo "install.sh: --prefix needs a directory" >&2; exit 2; }; prefix="$2"; shift 2 ;;
    --prefix=*) prefix="${1#--prefix=}"; shift ;;
    --no-start) start=0; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
case "$prefix" in /*) ;; *) echo "install.sh: --prefix must be an absolute path" >&2; exit 2 ;; esac
case "$prefix" in *"'"*|*'
'*) echo "install.sh: --prefix cannot contain quotes or newlines" >&2; exit 2 ;; esac

[ "$(uname -s)" = Linux ] || { echo "install.sh: this release supports Linux only" >&2; exit 1; }
case "$(uname -m)" in x86_64|amd64) ;; *) echo "install.sh: this release supports x86_64 only (found $(uname -m))" >&2; exit 1 ;; esac
glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if [ -z "$glibc" ]; then
  echo "install.sh: glibc was not found; the bundled Node and native runtime need glibc 2.34 or newer" >&2; exit 1
fi
if [ "$(printf '%s\n2.34\n' "$glibc" | sort -t. -k1,1n -k2,2n | head -n1)" != 2.34 ]; then
  echo "install.sh: glibc $glibc is older than 2.34, which the bundled native runtime requires" >&2; exit 1
fi

here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
state="$prefix/state" runtime="$prefix/runtime"
mkdir -p "$prefix" "$state" "$runtime"
chmod 700 "$prefix" "$state" "$runtime"

# Node is installed once per version; the Core release directory is the same
# content-addressed layout the App's Core upgrade stages into.
node_version="$(cat "$here/node/VERSION")"
node_dir="$prefix/node/$node_version"
if [ ! -x "$node_dir/bin/node" ]; then
  mkdir -p "$prefix/node"
  rm -rf "$node_dir.partial"
  cp -R "$here/node/dist" "$node_dir.partial"
  mv "$node_dir.partial" "$node_dir"
fi
node="$node_dir/bin/node"
"$node" --version >/dev/null

staged="$("$node" "$here/stage.mjs" --core "$here/core" --state "$state" --node "$node")"
release_dir="$(printf '%s' "$staged" | sed -n 1p)"
command="$release_dir/launcher/amux"
[ -x "$command" ] || { echo "install.sh: staging did not produce $command" >&2; exit 1; }

# One stable entry for SSH clients. It names the release that this installer
# staged; the App's Core upgrade saves its own exact release command instead.
mkdir -p "$prefix/bin"
printf "#!/bin/sh\nexec '%s' \"\$@\"\n" "$command" > "$prefix/bin/amux.partial"
chmod 755 "$prefix/bin/amux.partial"
mv "$prefix/bin/amux.partial" "$prefix/bin/amux"

# Only the environment that the App's Core upgrade can reconstruct later.
cat > "$prefix/start.sh" <<EOF
#!/bin/sh
# Starts this machine's AgentMux headless Core unless one is already serving.
set -eu
socket='$runtime/control.sock'
if '$prefix/bin/amux' --endpoint "unix:\$socket" system endpoint --inspect >/dev/null 2>&1; then
  echo "AgentMux Core is already serving at \$socket"; exit 0
fi
cd "\$HOME"
env -i HOME="\$HOME" PATH='$node_dir/bin':"\$PATH" SHELL="\${SHELL:-/bin/sh}" LANG="\${LANG:-C.UTF-8}" \\
  AGENTMUX_STATE_DIRECTORY='$state' AGENTMUX_RUNTIME_DIRECTORY='$runtime' \\
  AGENTMUX_AGENT_SESSION_STORE='$state/agent-sessions.json' \\
  setsid '$node' '$release_dir/dist/headless-runtime-cli.js' serve >> '$state/serve.log' 2>&1 < /dev/null &
attempt=0
while [ \$attempt -lt 60 ]; do
  if '$prefix/bin/amux' --endpoint "unix:\$socket" system endpoint --inspect >/dev/null 2>&1; then
    echo "AgentMux Core is serving at \$socket"; exit 0
  fi
  attempt=\$((attempt + 1)); sleep 0.5
done
echo "AgentMux Core did not publish \$socket within 30 seconds; see $state/serve.log" >&2
exit 1
EOF
chmod 755 "$prefix/start.sh"

if [ "$start" = 1 ]; then "$prefix/start.sh"; fi

cat <<EOF

AgentMux Core is installed in $prefix.

On the client: Settings → Remote → Hosts → Add host (or edit this machine's Host).
Host or SSH alias is the alias you already use for this machine. In Connection
options set:

  Service command      $prefix/bin/amux
  Service socket path  $runtime/control.sock

Save hosts, then press Test. After this machine reboots, run $prefix/start.sh.
EOF

#!/bin/sh
# Mirrors the official CLI's saved-key contract: genkey refuses an existing key, printpub reads one, --force is never expected.
[ -n "$FAKE_TAILCAT_LOG" ] && printf '%s|%s\n' "$*" "${TAILCAT_ADDR_FILE:-}" >> "$FAKE_TAILCAT_LOG"
if [ "$(uname)" = Darwin ]; then
  dir="$HOME/Library/Application Support/tailcat/keys"
elif [ -n "$XDG_CONFIG_HOME" ]; then
  dir="$XDG_CONFIG_HOME/tailcat/keys"
else
  dir="$HOME/.config/tailcat/keys"
fi
hex() { printf '%064d' 0 | tr 0 "$1"; }
key= client= command=
for argument do
  case "$argument" in
    --key=*) key="${argument#--key=}" ;;
    --client) client=1 ;;
    --force) exit 64 ;;
    genkey|printpub) command="$argument" ;;
  esac
done
case "$key" in /*) file="$key" ;; *) file="$dir/$key.private.json" ;; esac
case "$command" in
  genkey)
    mkdir -p "$dir"
    [ -n "$FAKE_TAILCAT_RACE" ] && cp "$FAKE_TAILCAT_RACE" "$FAKE_TAILCAT_RACE_TARGET"
    [ -e "$file" ] && { echo "$file already exists; use --force to overwrite" >&2; exit 1; }
    [ -n "$FAKE_TAILCAT_GENKEY_FAIL" ] && { echo 'derpmap fetch: offline' >&2; exit 1; }
    if [ -n "$client" ]; then
      printf '{"Private":"privkey:%s","Public":{}}' "$(hex 1)" > "$file"
      echo "nodekey:$(hex c)"
    else
      printf '{"Private":"privkey:%s","Public":{"PresharedKey":"psk:%s","RegionID":7}}' "$(hex 2)" "$(hex 3)" > "$file"
      echo 'tcprivate-listener-address'
    fi ;;
  printpub)
    [ -e "$file" ] || { echo "open $file: no such file" >&2; exit 1; }
    echo "nodekey:$(hex c)" ;;
  *) exit 2 ;;
esac

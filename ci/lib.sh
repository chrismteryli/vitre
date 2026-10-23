#!/usr/bin/env bash
# Shared helpers for the Vitre CI scripts. Source this file; do not run it.
#   REPO   the Vitre tree under test (a checkout of this repository). VITRE_REPO overrides it.
#   OUT    a folder for logs, the summary and the screenshot (CI uploads it as an artifact). VITRE_CI_OUT overrides it.
# shellcheck shell=bash

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${VITRE_REPO:-$CI_DIR/..}" && pwd)"
OUT="${VITRE_CI_OUT:-$PWD/ci-out}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
export LC_ALL=C.UTF-8 LANG=C.UTF-8

CHECKS=0
FAILS=0
IN_GH="${GITHUB_ACTIONS:-}"

group()    { if [ -n "$IN_GH" ]; then echo "::group::$*"; else echo; echo "== $*"; fi; }
endgroup() { if [ -n "$IN_GH" ]; then echo "::endgroup::"; fi; }
note()     { echo "     $*"; }
pass()     { CHECKS=$((CHECKS + 1)); echo "  ok   $*"; }
fail()     {
  CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); echo "  FAIL $*"
  if [ -n "$IN_GH" ]; then echo "::error title=Vitre CI::$*"; fi
}
die()      { echo "vitre-ci: $*" >&2; if [ -n "$IN_GH" ]; then echo "::error title=Vitre CI::$*"; fi; exit 2; }

# check "what is checked" command args...   (passes when the command exits 0; its output is hidden)
check() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}

# expect_eq "what" "expected" "actual"
expect_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected: $2 | got: $3)"; fi
}

# Appends a line to the job summary shown on the GitHub run page (and to $OUT/summary.md).
summary_line() {
  echo "$*" >> "$OUT/summary.md"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -w "${GITHUB_STEP_SUMMARY}" ]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}

# Prints the totals and returns 1 when anything failed.
finish() {
  local name="$1"
  echo
  echo "$name: $CHECKS checks, $FAILS failed"
  summary_line "- $name: $CHECKS checks, $FAILS failed ($(uname -m))"
  [ "$FAILS" -eq 0 ]
}

# Refuses to go on unless HOME is a throwaway folder: the install and smoke tests write settings and files into HOME and must never
# touch a real desktop when someone runs them by hand.
require_throwaway_home() {
  case "$HOME" in
    "${VITRE_CI_WORK:-/nonexistent}"/*) ;;
    *) die "HOME ($HOME) is not inside the throwaway work folder; refusing to run" ;;
  esac
}

# Starts from a clean environment for everything that reads or writes settings (so nothing inherited from a real session leaks in).
# Call this in the OUTER half of a test script, then re-run the script inside dbus-run-session.
make_throwaway_env() {
  local prefix="$1"
  VITRE_CI_WORK="$(mktemp -d "${TMPDIR:-/tmp}/$prefix.XXXXXX")"
  chmod 700 "$VITRE_CI_WORK"
  export VITRE_CI_WORK
  export HOME="$VITRE_CI_WORK/home"
  mkdir -p "$HOME"
  export XDG_RUNTIME_DIR="$VITRE_CI_WORK/run"
  # the shell's Wayland socket lives here and unix socket paths are limited to 107 bytes
  [ "${#XDG_RUNTIME_DIR}" -le 80 ] || die "TMPDIR is too long ($XDG_RUNTIME_DIR): use a shorter one, for example TMPDIR=/tmp"
  mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
  unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_STATE_HOME XDG_DATA_DIRS XDG_CONFIG_DIRS DCONF_PROFILE GSETTINGS_BACKEND \
        GSETTINGS_SCHEMA_DIR DBUS_SESSION_BUS_ADDRESS DISPLAY WAYLAND_DISPLAY GNOME_SETUP_DISPLAY
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME NO_AT_BRIDGE=1 GTK_A11Y=none
  # Nothing here may use the machine's own system bus. A path that does not exist is fine for scripts that only need dconf (the install
  # test), but NOT for GNOME Shell: see start_private_system_bus.
  export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$VITRE_CI_WORK/no-system-bus"
}

# A system bus for GNOME Shell. The shell talks to logind, UPower, NetworkManager, polkit and more on the SYSTEM bus. Where those services
# are missing (a container has no system bus at all) it copes with a plain "ServiceUnknown" answer, but not with a bus it cannot connect
# to: Gio.DBus.system then throws, LoginManagerSystemd logs a CRITICAL and TimeLimitsManager dies with a JS ERROR while the shell builds
# its UI, and gnome-shell aborts. So this starts a private dbus-daemon with NO activatable services on a socket in $XDG_RUNTIME_DIR and
# points DBUS_SYSTEM_BUS_ADDRESS at it; every call to a missing service then gets ServiceUnknown, as on a desktop without that service.
# Needs dbus-daemon (VITRE_CI_DBUS_DAEMON overrides the command). Call after make_throwaway_env; stop_private_system_bus ends it.
SYSBUS_PID=""
start_private_system_bus() {
  local daemon="${VITRE_CI_DBUS_DAEMON:-dbus-daemon}" sock="$XDG_RUNTIME_DIR/system-bus" conf="$VITRE_CI_WORK/system-bus.conf" i
  command -v "$daemon" >/dev/null || die "$daemon is missing (Ubuntu package: dbus-daemon)"
  cat > "$conf" <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=$sock</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
CONF
  "$daemon" --config-file="$conf" --nofork > "$OUT/system-bus.log" 2>&1 &
  SYSBUS_PID=$!
  for i in $(seq 1 50); do
    [ -S "$sock" ] && break
    kill -0 "$SYSBUS_PID" 2>/dev/null || break
    sleep 0.1
  done
  if [ ! -S "$sock" ]; then
    sed 's/^/     /' "$OUT/system-bus.log"
    die "the private system bus did not start ($daemon --config-file=$conf)"
  fi
  export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$sock"
  echo "private system bus: pid $SYSBUS_PID, $DBUS_SYSTEM_BUS_ADDRESS"
}
stop_private_system_bus() {
  if [ -n "$SYSBUS_PID" ]; then kill "$SYSBUS_PID" 2>/dev/null; wait "$SYSBUS_PID" 2>/dev/null; fi
  SYSBUS_PID=""
  return 0
}

# The ids in settings/extensions.txt (the extensions install.sh enables), one per line.
vitre_extension_ids() { grep -v '^[[:space:]]*$' "$REPO/settings/extensions.txt" | sed 's/[[:space:]]*$//'; }

#!/usr/bin/env bash
# Smoke test: installs Vitre into a throwaway HOME, starts a real GNOME Shell 51 on a virtual monitor (no GPU, no display needed) in a private
# session bus, and checks that every extension install.sh enables reaches the ACTIVE state and that the shell log has no "JS ERROR" from a
# Vitre extension. Takes one screenshot of the finished desktop.
#
#   gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800     (the only way to run a shell without a screen in GNOME 51)
#
# Writes into $VITRE_CI_OUT (CI uploads it): gnome-shell.log, extension-states.txt, screenshot.png, vitre-info.log, summary.md.
# Settings: VITRE_SMOKE_TIMEOUT (seconds to wait for every extension, default 180), VITRE_SMOKE_SETTLE (seconds to keep watching after they
# are all active, default 15), VITRE_SMOKE_MONITOR (default 1280x800), VITRE_ICONS_SRC (icon theme checkout; else install.sh downloads it).
# Needs (Ubuntu 26.10): gnome-shell, mesa-libgallium + libegl-mesa0 (software rendering), dbus-daemon, dconf-*, libglib2.0-bin, python3,
# fonts; gvfs + gvfs-daemons for the Dock's trash watcher (without them the CI probe stands in for gvfs and says so).
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TIMEOUT="${VITRE_SMOKE_TIMEOUT:-180}"
SETTLE="${VITRE_SMOKE_SETTLE:-15}"
MONITOR="${VITRE_SMOKE_MONITOR:-1280x800}"
PROBE_ID="vitre-ci-probe@vitre-ci"

if [ "${1:-}" != "--inner" ]; then
  command -v dbus-run-session >/dev/null || die "dbus-run-session is missing (Ubuntu package: dbus-daemon)"
  command -v gnome-shell >/dev/null || die "gnome-shell is missing"
  [ "$(id -u)" -ne 0 ] || die "run as a normal user: install.sh refuses root"
  make_throwaway_env vitre-smoke
  trap 'stop_private_system_bus; rm -rf "$VITRE_CI_WORK"' EXIT
  start_private_system_bus     # the shell needs a system bus it can connect to (see lib.sh)
  # GNOME's Extensions D-Bus service (what `gnome-extensions` and vitre-info.sh talk to) is a GTK program that the bus starts on demand;
  # it needs a display to start, and the only one here is the shell's own Wayland socket. The bus passes this variable on to it.
  export WAYLAND_DISPLAY=vitre-ci-wayland
  dbus-run-session -- bash "$SELF" --inner
  exit $?
fi

# ---- inside the private session bus -------------------------------------------------------------------------------------------------
require_throwaway_home
EXT="$HOME/.local/share/gnome-shell/extensions"
SHELL_LOG="$OUT/gnome-shell.log"
SHELL_PID=""
EXPECTED=()
while IFS= read -r u; do EXPECTED+=("$u"); done < <(vitre_extension_ids)

shell_alive() { [ -n "$SHELL_PID" ] && kill -0 "$SHELL_PID" 2>/dev/null; }
shell_up()    { gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell 2>/dev/null | grep -q true; }
# The shell's own D-Bus API (org.gnome.Shell.Extensions on org.gnome.Shell, the same one gnome-extensions and the Extensions app use):
# GetExtensionInfo answers {} for an extension it does not know, else a dict with a numeric "state".
SHELL_EXT="gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method"
state_name() {
  case "$1" in
    1) echo ACTIVE ;; 2) echo INACTIVE ;; 3) echo ERROR ;; 4) echo "OUT OF DATE" ;; 5) echo DOWNLOADING ;; 6) echo INITIALIZED ;;
    7) echo DEACTIVATING ;; 8) echo ACTIVATING ;; 99) echo UNINSTALLED ;; *) echo UNKNOWN ;;
  esac
}
# "uuid<TAB>STATE" for each extension we expect
ext_states() {
  local u raw n
  for u in "${EXPECTED[@]}" "$PROBE_ID"; do
    raw="$($SHELL_EXT org.gnome.Shell.Extensions.GetExtensionInfo "$u" 2>/dev/null)"
    n="$(sed -n "s/.*'state': <\([0-9]*\)[.0-9]*>.*/\1/p" <<< "$raw" | head -1)"
    printf '%s\t%s\n' "$u" "$(state_name "$n")"
  done
}
state_of()   { awk -F'\t' -v u="$1" '$1 == u {print $2}' "$2"; }
probe()      { gdbus call --session --dest org.vitre.CiProbe --object-path /org/vitre/CiProbe --method "org.vitre.CiProbe.$1" "${@:2}" 2>&1; }
# the shell is gone although nobody stopped it: say what it exited with and show the end of its log
shell_died() {
  local rc=0
  wait "$SHELL_PID" 2>/dev/null; rc=$?
  SHELL_PID=""
  fail "gnome-shell died $1 (exit status $rc)"
  echo "---- last lines of the shell log"; tail -40 "$SHELL_LOG" | sed 's/^/     /'
}
stop_shell() {
  [ -n "$SHELL_PID" ] || return 0
  kill -TERM "$SHELL_PID" 2>/dev/null
  for _ in $(seq 1 20); do shell_alive || break; sleep 0.5; done
  shell_alive && kill -KILL "$SHELL_PID" 2>/dev/null
  wait "$SHELL_PID" 2>/dev/null
  SHELL_PID=""
}
trap stop_shell EXIT

# Reads the shell log: lists the error records, fails on one from a Vitre extension
scan_shell_log() {
  local n_third
  python3 -I "$CI_DIR/smoke-helpers.py" scan-log "$SHELL_LOG" "$REPO/settings/extensions.txt" | tee "$OUT/js-errors.txt"
  if [ "${PIPESTATUS[0]}" -eq 0 ]; then pass "no JS ERROR or critical error from a Vitre extension in the shell log"; else fail "JS ERROR or critical error from a Vitre extension (see above and $OUT/js-errors.txt)"; fi
  if grep -qE 'Segmentation fault|Stack trace of thread|core dumped|Aborted' "$SHELL_LOG"; then fail "the shell log shows a crash"; else pass "no crash in the shell log"; fi
  n_third="$(grep -c 'error from THIRD-PARTY' "$OUT/js-errors.txt")"
  if [ "$n_third" -gt 0 ]; then
    note "warning: $n_third error record(s) come from bundled third-party extensions (not a failure)"
    if [ -n "$IN_GH" ]; then echo "::warning title=Vitre CI::$n_third error record(s) from bundled third-party extensions; see js-errors.txt in the artifact"; fi
  fi
}

group "environment"
echo "$(gnome-shell --version), $(uname -m), $(. /etc/os-release && echo "${PRETTY_NAME:-unknown}")"
echo "tree: $REPO (Vitre $(cat "$REPO/VERSION")), ${#EXPECTED[@]} extensions to enable"
expect_eq "GNOME Shell major version" "51" "$(gnome-shell --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
endgroup

# ---- 1. install ---------------------------------------------------------------------------------------------------------------------
group "install Vitre into the throwaway HOME"
dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'99.0'"      # no welcome dialog over the desktop
dconf write /org/gnome/shell/had-bluetooth-devices-setup true
bash "$REPO/install.sh" > "$OUT/smoke-install.log" 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then tail -15 "$OUT/smoke-install.log" | sed 's/^/       /'; fail "./install.sh exited $RC"; endgroup; finish "smoke-test"; exit 1; fi
pass "./install.sh exited 0"
# the CI probe goes first in the enabled list: it must be there before Vitre Dock starts (see probe/.../extension.js)
cp -a "$CI_DIR/probe/$PROBE_ID" "$EXT/$PROBE_ID"
NEW_LIST="$(python3 -I - "$(gsettings get org.gnome.shell enabled-extensions)" "$PROBE_ID" <<'PY'
import ast, sys
s = sys.argv[1].strip()
if s.startswith('@as'):
    s = s[3:].strip()
lst = list(ast.literal_eval(s)) if s else []
print(repr([sys.argv[2]] + [u for u in lst if u != sys.argv[2]]))
PY
)"
gsettings set org.gnome.shell enabled-extensions "$NEW_LIST"
endgroup

# ---- 2. start the shell -------------------------------------------------------------------------------------------------------------
group "start gnome-shell --headless ($MONITOR)"
env -u WAYLAND_DISPLAY XDG_DATA_DIRS=/usr/local/share:/usr/share XDG_CONFIG_DIRS=/etc/xdg XDG_SESSION_DESKTOP=gnome GSETTINGS_BACKEND=dconf \
    LIBGL_ALWAYS_SOFTWARE=1 \
    gnome-shell --headless --wayland --no-x11 --wayland-display=vitre-ci-wayland --virtual-monitor "$MONITOR" > "$SHELL_LOG" 2>&1 &
SHELL_PID=$!
echo "gnome-shell pid $SHELL_PID, log $SHELL_LOG"

up=0
for _ in $(seq 1 "$TIMEOUT"); do
  shell_alive || break
  if shell_up; then up=1; break; fi
  sleep 1
done
if [ "$up" -eq 1 ]; then
  pass "gnome-shell is up and owns org.gnome.Shell on the session bus"
elif shell_alive; then
  fail "gnome-shell did not appear on the session bus within ${TIMEOUT}s"
else
  shell_died "before it was up"
fi
if [ "$up" -ne 1 ]; then
  if shell_alive; then echo "---- last lines of the shell log"; tail -40 "$SHELL_LOG" | sed 's/^/     /'; fi
  endgroup; stop_shell; finish "smoke-test"; exit 1
fi
endgroup

# ---- 3. wait for every extension to be ACTIVE -----------------------------------------------------------------------------------------
group "wait for the extensions (up to ${TIMEOUT}s)"
STATES="$OUT/extension-states.txt"
all_active=0
t0=$SECONDS
quiet_since=""
while :; do
  shell_alive || { shell_died "while the extensions were loading"; break; }
  ext_states > "$STATES"
  pending=0; broken=0
  for u in "${EXPECTED[@]}" "$PROBE_ID"; do
    s="$(state_of "$u" "$STATES")"
    case "$s" in
      ACTIVE) ;;
      ERROR|"OUT OF DATE") broken=$((broken + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done
  if [ "$pending" -eq 0 ] && [ "$broken" -eq 0 ]; then all_active=1; break; fi
  # GNOME reports ERROR (with no message) for a moment while some extensions are still loading, so an error only counts once nothing is
  # loading any more and it has stayed for 20 s
  if [ "$pending" -eq 0 ]; then
    [ -n "$quiet_since" ] || quiet_since=$SECONDS
    [ $((SECONDS - quiet_since)) -ge 20 ] && break
  else
    quiet_since=""
  fi
  [ $((SECONDS - t0)) -ge "$TIMEOUT" ] && break
  sleep 2
done
echo "extensions settled after $((SECONDS - t0))s"
if ! shell_alive; then
  echo "gnome-shell is gone: nothing else can be checked, here is what its log says"
  scan_shell_log
  endgroup; finish "smoke-test"; exit 1
fi

if [ "$all_active" -eq 1 ] && shell_alive; then
  note "all active; watching for ${SETTLE}s more"
  sleep "$SETTLE"
  shell_alive || shell_died "during the ${SETTLE}s after the extensions loaded"
  ext_states > "$STATES"
fi

# one line per extension, and one check each
{
  printf '%-58s %s\n' "extension" "state"
  for u in "${EXPECTED[@]}" "$PROBE_ID"; do printf '%-58s %s\n' "$u" "$(state_of "$u" "$STATES")"; done
} > "$OUT/extension-states.table"
cat "$OUT/extension-states.table"
n_ok=0
for u in "${EXPECTED[@]}"; do
  s="$(state_of "$u" "$STATES")"
  if [ "$s" = "ACTIVE" ]; then
    n_ok=$((n_ok + 1))
  else
    fail "$u is ${s:-unknown}, not ACTIVE"
    probe_err="$($SHELL_EXT org.gnome.Shell.Extensions.GetExtensionErrors "$u" 2>&1 | head -c 600)"
    note "errors reported by the shell: $probe_err"
  fi
done
[ "$n_ok" -eq "${#EXPECTED[@]}" ] && pass "all ${#EXPECTED[@]} extensions are ACTIVE" || note "$n_ok of ${#EXPECTED[@]} are ACTIVE"
[ "$(state_of "$PROBE_ID" "$STATES")" = "ACTIVE" ] && pass "the CI probe is ACTIVE" || fail "the CI probe is not ACTIVE; no screenshot is possible"
endgroup

# ---- 4. what the shell reports, vitre-info, screenshot -------------------------------------------------------------------------------
group "shell state, vitre-info.sh, screenshot"
if shell_alive; then
  INFO_RAW="$(probe Info)"
  INFO="$(python3 -I -c 'import ast,sys; print(ast.literal_eval(sys.stdin.read().strip())[0])' <<< "$INFO_RAW" 2>/dev/null)"
  if [ -n "$INFO" ]; then
    echo "$INFO" > "$OUT/shell-info.json"
    read -r MONS SW SH SHIM WINS MODE < <(python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["monitors"], d["stage"][0], d["stage"][1], str(d["trash_shim"]).lower(), d["windows"], d["session_mode"])' <<< "$INFO")
    echo "shell reports: session mode $MODE, $MONS monitor(s), stage ${SW}x${SH}, $WINS window(s), trash shim in use: $SHIM"
    expect_eq "session mode is user (extensions load)" "user" "$MODE"
    expect_eq "the stage has the virtual monitor's size" "${MONITOR%@*}" "${SW}x${SH}"
    if [ "$SHIM" = "true" ]; then
      note "NOTE: gvfs's trash backend was not available here, so the CI probe mapped trash:/// to an empty folder (see ci/probe)."
      summary_line "- smoke-test: gvfs trash backend unavailable; the CI probe stood in for it"
      if [ -n "$IN_GH" ]; then echo "::notice title=Vitre CI::gvfs trash backend not available in this image; the CI probe shimmed trash:///"; fi
    fi
  else
    fail "the CI probe did not answer Info: $INFO_RAW"
  fi

  bash "$REPO/vitre-info.sh" > "$OUT/vitre-info.log" 2>&1
  expect_eq "./vitre-info.sh exits 0 with the shell running" "0" "$?"
  # vitre-info.sh and `gnome-extensions` go through GNOME's Extensions D-Bus service (a separate process the bus starts on demand)
  if gnome-extensions list 2>/dev/null | grep -q .; then
    n_info="$(grep -c -E '^  vitre-.* ACTIVE' "$OUT/vitre-info.log")"
    n_vitre="$(printf '%s\n' "${EXPECTED[@]}" "$PROBE_ID" | grep -c '^vitre-')"   # the probe's id starts with vitre- too
    expect_eq "./vitre-info.sh lists every vitre-* extension as ACTIVE" "$n_vitre" "$n_info"
  else
    # the state check above does not depend on that service, so this is a warning: vitre-info.sh could not be exercised here
    note "warning: gnome-extensions cannot reach the shell (GNOME's Extensions D-Bus service did not start), so vitre-info.sh's extension list was not checked"
    summary_line "- smoke-test: gnome-extensions could not reach the shell; vitre-info.sh's extension list was not checked"
    if [ -n "$IN_GH" ]; then echo "::warning title=Vitre CI::gnome-extensions cannot reach the shell in this container; vitre-info.sh extension list not checked"; fi
  fi

  sleep 2   # let the last frame land
  SHOT_RAW="$(probe Screenshot "$OUT/screenshot.png")"
  if grep -q '^(true' <<< "$SHOT_RAW" && [ -s "$OUT/screenshot.png" ]; then
    pass "screenshot taken"
    python3 -I "$CI_DIR/smoke-helpers.py" png "$OUT/screenshot.png" | tee "$OUT/screenshot.txt"
    if grep -q 'verdict=flat' "$OUT/screenshot.txt"; then
      note "warning: the screenshot is one flat colour; open it in the artifact to see what the shell drew"
      if [ -n "$IN_GH" ]; then echo "::warning title=Vitre CI::the screenshot is a single flat colour"; fi
    fi
  else
    fail "no screenshot: $SHOT_RAW"
  fi
else
  fail "gnome-shell is not running any more; no state, vitre-info or screenshot"
fi
endgroup

# ---- 5. stop and read the log ---------------------------------------------------------------------------------------------------------
group "stop the shell, read its log"
SHELL_ALIVE_AT_END=0; shell_alive && SHELL_ALIVE_AT_END=1
stop_shell
expect_eq "gnome-shell was still running at the end of the test" "1" "$SHELL_ALIVE_AT_END"
scan_shell_log
endgroup

{
  summary_line ""
  summary_line "smoke-test, $(uname -m), $(gnome-shell --version): $n_ok of ${#EXPECTED[@]} extensions ACTIVE"
  summary_line ""
  summary_line '```'
  while IFS= read -r l; do summary_line "$l"; done < "$OUT/extension-states.table"
  summary_line '```'
}
finish "smoke-test"

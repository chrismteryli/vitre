#!/usr/bin/env bash
# Install test: runs ./install.sh --check, a real install, ./uninstall.sh and checks that everything is back, all in a throwaway HOME and a
# private session bus with the real dconf (nothing outside the throwaway folder is touched; refuses to run otherwise).
#
#   scenario 1  a user who already has a Dhruva/Ubuntu Dock setup and their own gtk.css: --check changes nothing; install puts every file
#               in place, enables exactly the right extensions, migrates Dhruva's settings; uninstall restores files and settings exactly.
#   scenario 2  installed twice without waiting: backups cannot collide, two uninstalls restore the original state, and a third fails cleanly.
#   scenario 3  post-install Vitre and unrelated GNOME changes survive both an upgrade and ordinary uninstall.
#   scenario 4  --factory-reset deliberately discards later changes to Vitre-owned keys.
#   scenario 5  external XDG data/config roots are recorded, restored and cleaned up safely.
#   scenario 6  an upgrade over a Vitre 0.2.0 install (a backup in the old format) keeps the user's Vitre choices, adds only new defaults,
#               and both uninstalls restore Vitre's own settings without touching a setting that Vitre does not own.
#   scenario 7  installed files keep the user's umask; only the backup is private.
#   scenario 8  the base icon theme download is checked against the pinned SHA-256 (a wrong archive is never unpacked or run; the pinned
#               archive installs; the same content compressed differently installs too).
#
# Needs (Ubuntu 26.10): gnome-shell, dbus-daemon (dbus-run-session), dconf-cli, dconf-service, dconf-gsettings-backend, libglib2.0-bin,
# python3, and for the icon theme either network or VITRE_ICONS_SRC=<checkout of MacTahoe-icon-theme>.
# Usage: ci/install-test.sh           (VITRE_REPO, VITRE_CI_OUT, VITRE_ICONS_SRC are read from the environment)
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "${1:-}" != "--inner" ]; then
  command -v dbus-run-session >/dev/null || die "dbus-run-session is missing (Ubuntu package: dbus-daemon)"
  [ "$(id -u)" -ne 0 ] || die "run as a normal user: install.sh refuses root"
  make_throwaway_env vitre-install-test
  dbus-run-session -- bash "$SELF" --inner
  rc=$?
  rm -rf "$VITRE_CI_WORK"
  exit "$rc"
fi

# ---- inside the private session bus -------------------------------------------------------------------------------------------------
require_throwaway_home
DATA="$HOME/.local/share"
CONF="$HOME/.config"
EXT="$DATA/gnome-shell/extensions"
ICONS="$DATA/icons"
W="$VITRE_CI_WORK"
INSTALL="$REPO/install.sh"
UNINSTALL="$REPO/uninstall.sh"
OURS=()
while IFS= read -r u; do OURS+=("$u"); done < <(vitre_extension_ids)

# Value of a dconf key as text ('' when unset).
dc() { dconf read "$1" 2>/dev/null; }

# sha256 and path of every file, plus every symlink with its target, in HOME. Left out: Vitre's own backups, caches and the settings database
# (the settings are compared through `dconf dump`).
snap_files() {
  (
    cd "$HOME" || exit 1
    find . \( -path ./.local/share/vitre-backup -o -path ./.cache -o -path ./.config/dconf \) -prune -o \( -type f -o -type l \) -print0 |
      sort -z |
      while IFS= read -r -d '' f; do
        if [ -L "$f" ]; then printf 'L %s -> %s\n' "$f" "$(readlink "$f")"; else printf 'F %s %s\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"; fi
      done
  )
}
snap_settings() { dconf dump /; }

# run NAME CMD...  runs a command, keeps its output in $OUT/NAME.log, sets RC and LAST_LOG
run() {
  local name="$1"; shift
  LAST_LOG="$OUT/$name.log"
  "$@" > "$LAST_LOG" 2>&1
  RC=$?
}

# Compares two snapshot files; prints the first differences on failure.
same() {
  local what="$1" a="$2" b="$3"
  if diff -q "$a" "$b" >/dev/null; then pass "$what"; else fail "$what"; diff "$a" "$b" | head -12 | sed 's/^/       /'; fi
}

# ---- seed: a user who already has a Dock setup --------------------------------------------------------------------------------------
seed_user() {
  dconf write /org/gnome/shell/enabled-extensions "['ubuntu-dock@ubuntu.com', 'dhruva@narkagni', 'ding@rastersoft.com']"
  dconf write /org/gnome/shell/disabled-extensions "['old-thing@example.com']"
  dconf write /org/gnome/shell/disable-user-extensions true
  dconf write /org/gnome/desktop/interface/color-scheme "'default'"
  dconf write /org/gnome/desktop/interface/gtk-theme "'Yaru'"
  dconf write /org/gnome/mutter/edge-tiling true
  dconf write /org/gnome/desktop/wm/keybindings/switch-input-source "['<Super>space']"
  local d=/org/gnome/shell/extensions/dhruva
  dconf write $d/icon-size 64
  dconf write $d/big-preview-size 120
  dconf write $d/dock-position "'LEFT'"
  dconf write $d/not-a-key 1
  dconf write $d/sub/deeper 2
  mkdir -p "$CONF/gtk-4.0" "$HOME/.themes/Vitre-Glass" "$EXT/vitre-stage@vitre-desktop"
  echo "/* the user's own gtk.css */" > "$CONF/gtk-4.0/gtk.css"
  echo "an older Vitre-Glass" > "$HOME/.themes/Vitre-Glass/old-marker"
  echo "a development copy of Stage" > "$EXT/vitre-stage@vitre-desktop/dev-marker"
  mkdir -p "$DATA/applications"; echo "[Desktop Entry]" > "$DATA/applications/untouched.desktop"
}

# ---- what a finished install must look like -----------------------------------------------------------------------------------------
assert_installed() {
  local tag="$1" bad="" u d n
  for d in "$REPO"/extensions/*/; do
    u="$(basename "$d")"
    if [ ! -f "$EXT/$u/metadata.json" ]; then bad="$bad $u(missing)"; continue; fi
    diff -rq --exclude=gschemas.compiled "$d" "$EXT/$u" >/dev/null 2>&1 || bad="$bad $u(differs)"
    if ls "$d"/schemas/*.gschema.xml >/dev/null 2>&1; then
      [ -s "$EXT/$u/schemas/gschemas.compiled" ] || bad="$bad $u(schemas-not-compiled)"
    fi
  done
  n="$(find "$REPO/extensions" -mindepth 1 -maxdepth 1 -type d | wc -l)"
  if [ -z "$bad" ]; then pass "$tag: $n extension folders installed, identical to the package, schemas compiled"; else fail "$tag: extensions:$bad"; fi

  # every schema the extensions declare loads with this system's GLib
  bad=""
  for d in "$EXT"/*/; do
    local id; id="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("settings-schema",""))' "$d/metadata.json" 2>/dev/null)"
    [ -n "$id" ] || continue
    GSETTINGS_BACKEND=memory gsettings --schemadir "$d/schemas" list-keys "$id" >/dev/null 2>&1 || bad="$bad $id"
  done
  [ -z "$bad" ] && pass "$tag: every extension schema loads" || fail "$tag: schemas that do not load:$bad"

  bad=""
  for n in icons/Vitre-Icons:"$ICONS/Vitre-Icons" icons/Vitre-Cursor:"$ICONS/Vitre-Cursor" backgrounds/vitre:"$DATA/backgrounds/vitre"; do
    diff -rq --exclude=icon-theme.cache "$REPO/${n%%:*}" "${n#*:}" >/dev/null 2>&1 || bad="$bad ${n%%:*}"
  done
  # Vitre-Glass and every accent colour variant next to it
  local nthemes=0 t
  for t in "$REPO"/themes/*/; do
    t="${t%/}"; nthemes=$((nthemes + 1))
    diff -rq "$t" "$HOME/.themes/$(basename "$t")" >/dev/null 2>&1 || bad="$bad themes/$(basename "$t")"
  done
  [ "$nthemes" -gt 1 ] || bad="$bad themes(no-accent-variants)"
  for f in "$REPO"/icons/hicolor/scalable/apps/*.svg; do
    cmp -s "$f" "$ICONS/hicolor/scalable/apps/$(basename "$f")" || bad="$bad hicolor/$(basename "$f")"
  done
  for v in gtk-4.0 gtk-3.0; do
    for f in "$REPO/gtk/$v"/*; do diff -rq "$f" "$CONF/$v/$(basename "$f")" >/dev/null 2>&1 || bad="$bad $v/$(basename "$f")"; done
  done
  [ -z "$bad" ] && pass "$tag: $nthemes themes, icons, cursor, wallpapers and GTK files in place" || fail "$tag: not in place or different:$bad"

  # Vitre Settings: the app folder, a menu entry that launches the installed copy, the icons and the version file its About page reads
  bad=""
  diff -rq "$REPO/apps/vitre-settings" "$DATA/vitre-settings" >/dev/null 2>&1 || bad="$bad app-folder"
  [ -x "$DATA/vitre-settings/org.vitre.Settings" ] || bad="$bad launcher-not-executable"
  local entry="$DATA/applications/org.vitre.Settings.desktop"
  [ "$(sed -n 's/^Exec=//p' "$entry" 2>/dev/null | head -1)" = "$DATA/vitre-settings/org.vitre.Settings" ] || bad="$bad menu-entry-Exec"
  ! grep -q '@LAUNCHER@' "$entry" 2>/dev/null || bad="$bad menu-entry-placeholder"
  if command -v desktop-file-validate >/dev/null; then desktop-file-validate "$entry" >/dev/null 2>&1 || bad="$bad desktop-file-validate"; fi
  cmp -s "$REPO/icons/hicolor/symbolic/apps/org.vitre.Settings-symbolic.svg" "$ICONS/hicolor/symbolic/apps/org.vitre.Settings-symbolic.svg" || bad="$bad symbolic-icon"
  cmp -s "$REPO/VERSION" "$DATA/vitre/VERSION" || bad="$bad version-file"
  [ -z "$bad" ] && pass "$tag: Vitre Settings app, menu entry, icons and version file in place" || fail "$tag: Vitre Settings:$bad"

  bad=""
  for n in VitreBase VitreBase-dark VitreBase-light; do
    [ -d "$ICONS/$n" ] || { bad="$bad $n(missing)"; continue; }
    [ ! -e "$ICONS/$n/apps" ] && [ ! -e "$ICONS/$n/apps@2x" ] || bad="$bad $n(has-app-icons)"
    [ -z "$(find "$ICONS/$n" -xtype l -print -quit)" ] || bad="$bad $n(broken-links)"
  done
  [ -s "$ICONS/Vitre-Cursor/index.theme" ] && [ -d "$ICONS/Vitre-Cursor/cursors" ] || bad="$bad cursor-theme"
  [ -z "$bad" ] && pass "$tag: base icon theme without app icons, no broken links, cursor theme" || fail "$tag: icon base:$bad"
}

# Reads the three lists out of dconf and checks them against install.sh's documented behaviour.
assert_extension_lists() {
  local tag="$1" before_en="$2" before_dis="$3" now_en now_dis res
  now_en="$(gsettings get org.gnome.shell enabled-extensions)"
  now_dis="$(gsettings get org.gnome.shell disabled-extensions)"
  res="$(python3 -I - "$before_en" "$before_dis" "$now_en" "$now_dis" "$REPO/settings/extensions.txt" "$REPO/settings/conflicts.txt" <<'PY'
import ast, sys
def parse(s):
    s = s.strip()
    if s.startswith('@as'):
        s = s[3:].strip()
    return list(ast.literal_eval(s)) if s else []
be, bd, ne, nd = (parse(x) for x in sys.argv[1:5])
ours = [l.strip() for l in open(sys.argv[5]) if l.strip()]
conflicts = [l.strip() for l in open(sys.argv[6]) if l.strip()]
problems = []
missing = [u for u in ours if u not in ne]
if missing: problems.append('not enabled: %s' % missing)
if len(set(ne)) != len(ne): problems.append('enabled list has duplicates')
still = [u for u in conflicts if u in ne]
if still: problems.append('conflicting extensions still enabled: %s' % still)
lost = [u for u in be if u not in conflicts and u not in ne]
if lost: problems.append("the user's own extensions were dropped: %s" % lost)
notoff = [u for u in conflicts if u not in nd]
if notoff: problems.append('conflicts not in disabled-extensions: %s' % notoff)
gone = [u for u in bd if u not in ours and u not in nd]
if gone: problems.append("the user's disabled extensions were dropped: %s" % gone)
print('; '.join(problems) if problems else 'OK')
PY
)"
  if [ "$res" = "OK" ]; then pass "$tag: enabled/disabled extension lists are right"; else fail "$tag: extension lists: $res"; fi
  expect_eq "$tag: disable-user-extensions is false" "false" "$(gsettings get org.gnome.shell disable-user-extensions)"
}

# Every key in settings/vitre.ini is set in dconf after the install.
assert_ini_loaded() {
  local tag="$1" n=0 missing=0 sec key val
  while IFS=$'\t' read -r sec key val; do
    n=$((n + 1))
    [ -n "$(dc "/org/gnome/$sec/$key")" ] || { missing=$((missing + 1)); note "not set: /org/gnome/$sec/$key"; }
  done < <(python3 -I - "$REPO/settings/vitre.ini" <<'PY'
import sys
sec = None
for line in open(sys.argv[1]):
    line = line.rstrip('\n')
    if line.startswith('[') and line.endswith(']'):
        sec = line[1:-1]
    elif '=' in line and sec and not line.startswith('#'):
        k, v = line.split('=', 1)
        print('%s\t%s\t%s' % (sec, k, v))
PY
)
  if [ "$n" -gt 0 ] && [ "$missing" -eq 0 ]; then pass "$tag: all $n settings from settings/vitre.ini are in dconf"; else fail "$tag: $missing of $n vitre.ini settings are missing"; fi
}

# The Dhruva settings seeded by seed_user: only keys that Vitre Dock's schema has are copied, and a value Vitre's own ini sets wins.
assert_dock_migration() {
  local tag="$1" log="$2" schema_keys expect_n=0 k seeded want got ini_val
  schema_keys="$(GSETTINGS_BACKEND=memory gsettings --schemadir "$EXT/vitre-dock@vitre-desktop/schemas" list-keys org.gnome.shell.extensions.vitre-dock)"
  for k in icon-size big-preview-size dock-position not-a-key; do
    grep -qxF -- "$k" <<< "$schema_keys" && expect_n=$((expect_n + 1))
  done
  if grep -q "^Dhruva settings found: $expect_n copied to Vitre Dock" "$log"; then
    pass "$tag: Dhruva settings found, $expect_n copied to Vitre Dock (keys the schema has)"
  else
    fail "$tag: expected 'Dhruva settings found: $expect_n copied' in the install output"
  fi
  for k in icon-size big-preview-size dock-position; do
    case "$k" in icon-size) seeded=64 ;; big-preview-size) seeded=120 ;; dock-position) seeded="'LEFT'" ;; *) seeded="" ;; esac
    ini_val="$(awk -v k="$k" '/^\[/{s=($0=="[shell/extensions/vitre-dock]")} s && index($0,k"=")==1 {print substr($0,length(k)+2)}' "$REPO/settings/vitre.ini")"
    want="${ini_val:-$seeded}"
    got="$(dc "/org/gnome/shell/extensions/vitre-dock/$k")"
    expect_eq "$tag: vitre-dock $k ($([ -n "$ini_val" ] && echo "Vitre's ini wins" || echo 'copied from Dhruva'))" "$want" "$got"
  done
  expect_eq "$tag: a key the Dock schema does not have is not copied" "" "$(dc /org/gnome/shell/extensions/vitre-dock/not-a-key)"
  expect_eq "$tag: a sub-folder of Dhruva's settings is not copied" "" "$(dc /org/gnome/shell/extensions/vitre-dock/sub/deeper)"
  expect_eq "$tag: Dhruva's own settings stay where they were" "64" "$(dc /org/gnome/shell/extensions/dhruva/icon-size)"
}

# ---- 0. the environment ---------------------------------------------------------------------------------------------------------------
group "environment"
echo "$(gnome-shell --version), $(uname -m), $(. /etc/os-release && echo "${PRETTY_NAME:-unknown}")"
echo "tree: $REPO (Vitre $(cat "$REPO/VERSION"))"
expect_eq "GNOME Shell major version" "51" "$(gnome-shell --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
# the test is only worth anything with the real dconf behind gsettings (a missing backend silently falls back to a memory store)
dconf write /org/gnome/shell/disable-user-extensions true
expect_eq "gsettings reads what dconf wrote (real dconf backend)" "true" "$(gsettings get org.gnome.shell disable-user-extensions)"
dconf reset /org/gnome/shell/disable-user-extensions
endgroup

# ---- scenario 1 -----------------------------------------------------------------------------------------------------------------------
group "scenario 1: install over an existing Dock setup, then uninstall"
seed_user
BEFORE_EN="$(gsettings get org.gnome.shell enabled-extensions)"
BEFORE_DIS="$(gsettings get org.gnome.shell disabled-extensions)"
snap_files > "$W/before.files"; snap_settings > "$W/before.dconf"
note "state before: $(wc -l < "$W/before.files") files, $(grep -c '=' "$W/before.dconf") settings"

run install-check bash "$INSTALL" --check
expect_eq "./install.sh --check exits 0" "0" "$RC"
grep -q 'supported' "$LAST_LOG" && pass "--check says the system is supported" || fail "--check output has no 'supported' line: $(head -3 "$LAST_LOG" | tr '\n' '|')"
grep -q 'check only: nothing changed' "$LAST_LOG" && pass "--check says it changed nothing" || fail "--check did not print 'check only: nothing changed'"
snap_files > "$W/check.files"; snap_settings > "$W/check.dconf"
same "--check left every file as it was" "$W/before.files" "$W/check.files"
same "--check left every setting as it was" "$W/before.dconf" "$W/check.dconf"
[ ! -e "$DATA/vitre-backup" ] && pass "--check made no backup folder" || fail "--check created $DATA/vitre-backup"

run install-1 bash "$INSTALL"
expect_eq "./install.sh exits 0" "0" "$RC"
if [ "$RC" -ne 0 ]; then tail -15 "$LAST_LOG" | sed 's/^/       /'; fi
INSTALL_LOG="$LAST_LOG"
grep -q 'Vitre is installed' "$INSTALL_LOG" && pass "install printed 'Vitre is installed.'" || fail "install did not finish ('Vitre is installed.' missing)"
assert_installed "install"
assert_extension_lists "install" "$BEFORE_EN" "$BEFORE_DIS"
assert_ini_loaded "install"
assert_dock_migration "install" "$INSTALL_LOG"

B1="$(ls -dt "$DATA"/vitre-backup/[0-9]*-??????/ 2>/dev/null | head -1)"; B1="${B1%/}"
if [ -n "$B1" ] && [ -s "$B1/installed.txt" ] && [ -s "$B1/roots.txt" ] && [ -s "$B1/settings/paths.txt" ]; then
  pass "backup folder has file manifests, canonical roots and owned-key values"
else
  fail "backup folder is incomplete: ${B1:-none}"
fi
expect_eq "backup directory is private" "700" "$(stat -c %a "$B1")"
expect_eq "backup settings manifest is private" "600" "$(stat -c %a "$B1/settings/paths.txt")"
expect_eq "install moved the user's own gtk.css, Vitre-Glass and Stage folder into the backup" "3" "$(wc -l < "${B1:-/dev/null}/moved.txt" 2>/dev/null | tr -d ' ')"
# vitre-info.sh: exits 0, prints the version, changes nothing
run vitre-info bash "$REPO/vitre-info.sh"
expect_eq "./vitre-info.sh exits 0" "0" "$RC"
expect_eq "./vitre-info.sh prints the version" "Vitre:      $(cat "$REPO/VERSION")" "$(sed -n 1p "$LAST_LOG")"

run uninstall-1 bash "$UNINSTALL"
expect_eq "./uninstall.sh exits 0" "0" "$RC"
if [ "$RC" -ne 0 ]; then tail -15 "$LAST_LOG" | sed 's/^/       /'; fi
snap_files > "$W/after1.files"; snap_settings > "$W/after1.dconf"
same "uninstall: every file is back as it was (incl. the user's gtk.css, Vitre-Glass and Stage folder)" "$W/before.files" "$W/after1.files"
same "uninstall: every setting is back as it was" "$W/before.dconf" "$W/after1.dconf"
expect_eq "uninstall: the user's gtk.css has its own text again" "/* the user's own gtk.css */" "$(cat "$CONF/gtk-4.0/gtk.css" 2>/dev/null)"
[ -z "$(ls -d "$DATA"/vitre-backup/[0-9]*-??????/ 2>/dev/null)" ] && pass "uninstall renamed its backup to .undone" || fail "an un-undone backup is left"
endgroup

# ---- scenario 2 -----------------------------------------------------------------------------------------------------------------------
group "scenario 2: collision-safe repeated install and complete undo"
run install-2a bash "$INSTALL"; expect_eq "first install exits 0" "0" "$RC"
B2A="$(ls -dt "$DATA"/vitre-backup/[0-9]*-??????/ | head -1)"
run install-2b bash "$INSTALL"; expect_eq "second install (over the first) exits 0" "0" "$RC"
B2B="$(ls -dt "$DATA"/vitre-backup/[0-9]*-??????/ | head -1)"
[ "$B2A" != "$B2B" ] && pass "same-second installs get distinct backup directories" || fail "two installs shared $B2A"
assert_installed "second install"
assert_extension_lists "second install" "$BEFORE_EN" "$BEFORE_DIS"
run uninstall-2a bash "$UNINSTALL"; expect_eq "first uninstall exits 0" "0" "$RC"
run uninstall-2b bash "$UNINSTALL"; expect_eq "second uninstall exits 0" "0" "$RC"
snap_files > "$W/after2.files"; snap_settings > "$W/after2.dconf"
same "two installs and two uninstalls: every file is back as it was" "$W/before.files" "$W/after2.files"
same "two installs and two uninstalls: every setting is back as it was" "$W/before.dconf" "$W/after2.dconf"
run uninstall-3 bash "$UNINSTALL"
if [ "$RC" -ne 0 ] && grep -q 'no install backup found' "$LAST_LOG"; then
  pass "a third uninstall (nothing to undo) exits $RC and says 'no install backup found'"
else
  fail "a third uninstall did not fail cleanly"
fi
snap_files > "$W/after3.files"; snap_settings > "$W/after3.dconf"
same "...and changes no file" "$W/before.files" "$W/after3.files"
same "...and changes no setting" "$W/before.dconf" "$W/after3.dconf"
endgroup

# ---- scenario 3 -----------------------------------------------------------------------------------------------------------------------
group "scenario 3: upgrades and ordinary uninstall preserve later choices"
run install-4a bash "$INSTALL"; expect_eq "install before upgrade exits 0" "0" "$RC"
dconf write /org/gnome/desktop/interface/gtk-theme "'UserCustom'"
dconf write /org/gnome/desktop/wm/keybindings/switch-input-source "['<Super>space', '<Super>z']"
run install-4b bash "$INSTALL"; expect_eq "upgrade exits 0" "0" "$RC"
expect_eq "upgrade preserves a changed Vitre-owned setting" "'UserCustom'" "$(dc /org/gnome/desktop/interface/gtk-theme)"
expect_eq "upgrade preserves an unrelated setting" "['<Super>space', '<Super>z']" "$(dc /org/gnome/desktop/wm/keybindings/switch-input-source)"
run uninstall-4a bash "$UNINSTALL"; expect_eq "uninstall of upgrade exits 0" "0" "$RC"
expect_eq "ordinary uninstall keeps the changed Vitre-owned setting" "'UserCustom'" "$(dc /org/gnome/desktop/interface/gtk-theme)"
expect_eq "ordinary uninstall keeps the unrelated setting" "['<Super>space', '<Super>z']" "$(dc /org/gnome/desktop/wm/keybindings/switch-input-source)"
run uninstall-4b bash "$UNINSTALL"; expect_eq "uninstall of original install exits 0" "0" "$RC"
expect_eq "older transaction also preserves the changed Vitre-owned setting" "'UserCustom'" "$(dc /org/gnome/desktop/interface/gtk-theme)"
expect_eq "older transaction also preserves the unrelated setting" "['<Super>space', '<Super>z']" "$(dc /org/gnome/desktop/wm/keybindings/switch-input-source)"
endgroup

# ---- scenario 4 -----------------------------------------------------------------------------------------------------------------------
group "scenario 4: explicit factory reset"
snap_settings > "$W/before-factory.dconf"
run install-5 bash "$INSTALL"; expect_eq "install before factory reset exits 0" "0" "$RC"
dconf write /org/gnome/desktop/interface/gtk-theme "'DiscardMe'"
dconf write /org/gnome/desktop/wm/keybindings/switch-input-source "['<Super>x']"
run uninstall-factory bash "$UNINSTALL" --factory-reset
expect_eq "factory reset exits 0" "0" "$RC"
snap_settings > "$W/after-factory.dconf"
same "factory reset restores all owned keys to their pre-install values" "$W/before-factory.dconf" "$W/after-factory.dconf"
endgroup

# ---- scenario 5 -----------------------------------------------------------------------------------------------------------------------
group "scenario 5: external XDG roots"
export XDG_DATA_HOME="$W/external-data" XDG_CONFIG_HOME="$W/external-config"
DATA="$XDG_DATA_HOME"; CONF="$XDG_CONFIG_HOME"; EXT="$DATA/gnome-shell/extensions"; ICONS="$DATA/icons"
mkdir -p "$CONF/gtk-4.0"
echo "/* external user gtk.css */" > "$CONF/gtk-4.0/gtk.css"
run install-external bash "$INSTALL"; expect_eq "install with external XDG roots exits 0" "0" "$RC"
[ -f "$EXT/vitre-stage@vitre-desktop/metadata.json" ] && pass "install used external XDG_DATA_HOME" || fail "extension missing from external data root"
run uninstall-external bash "$UNINSTALL"; expect_eq "uninstall with external XDG roots exits 0" "0" "$RC"
expect_eq "external user file is restored" "/* external user gtk.css */" "$(cat "$CONF/gtk-4.0/gtk.css" 2>/dev/null)"
[ ! -e "$EXT/vitre-stage@vitre-desktop" ] && pass "installed files are removed outside HOME" || fail "external extension was left behind"
endgroup

# ---- scenario 6 -----------------------------------------------------------------------------------------------------------------------
group "scenario 6: upgrade over a 0.2.0 install, then undo both"
unset XDG_DATA_HOME XDG_CONFIG_HOME
DATA="$HOME/.local/share"; CONF="$HOME/.config"; EXT="$DATA/gnome-shell/extensions"; ICONS="$DATA/icons"
dconf reset -f /org/gnome/ >/dev/null 2>&1
dconf write /org/gnome/desktop/interface/gtk-theme "'Yaru'"
dconf write /org/gnome/desktop/interface/clock-format "'12h'"
dconf write /org/gnome/shell/enabled-extensions "['ding@rastersoft.com']"
snap_files > "$W/before6.files"
# what Vitre 0.2.0 left: a backup folder in the old format (all of /org/gnome/ in dconf.ini, no per-key files), and its settings in dconf
OLD="$DATA/vitre-backup/20261022-120000"
mkdir -p "$OLD/files"
dconf dump /org/gnome/ > "$OLD/dconf.ini"; : > "$OLD/installed.txt"; : > "$OLD/moved.txt"; echo "$HOME" > "$OLD/home.txt"
dconf write /org/gnome/desktop/interface/gtk-theme "'Vitre-Glass'"
dconf write /org/gnome/shell/extensions/vitre-dock/icon-size 72          # the user's own choice, made after installing 0.2.0
dconf write /org/gnome/shell/extensions/vitre-dock/dock-position "'LEFT'"
dconf reset /org/gnome/shell/extensions/vitre-dock/show-stack            # a key 0.3 introduced: not set yet
run install-6 bash "$INSTALL"; expect_eq "upgrade over a 0.2.0 install exits 0" "0" "$RC"
expect_eq "upgrade keeps the user's Vitre choice (Dock icon size)" "72" "$(dc /org/gnome/shell/extensions/vitre-dock/icon-size)"
expect_eq "upgrade keeps the user's Vitre choice (Dock position)" "'LEFT'" "$(dc /org/gnome/shell/extensions/vitre-dock/dock-position)"
expect_eq "upgrade adds a setting that is new (Downloads stack)" "true" "$(dc /org/gnome/shell/extensions/vitre-dock/show-stack)"
assert_extension_lists "upgrade over 0.2.0" "['ding@rastersoft.com']" "[]"
dconf write /org/gnome/desktop/interface/clock-format "'24h'"             # an unrelated change after the install
run uninstall-6a bash "$UNINSTALL"; expect_eq "first uninstall (the upgrade) exits 0" "0" "$RC"
expect_eq "the Vitre choice is still the user's after the first uninstall" "72" "$(dc /org/gnome/shell/extensions/vitre-dock/icon-size)"
run uninstall-6b bash "$UNINSTALL"; expect_eq "second uninstall (the 0.2.0 backup) exits 0" "0" "$RC"
grep -q 'Vitre is removed' "$LAST_LOG" && pass "the old-format backup was undone" || fail "the old-format backup was not undone: $(tail -2 "$LAST_LOG" | tr '\n' '|')"
expect_eq "Vitre-owned setting is back (gtk-theme)" "'Yaru'" "$(dc /org/gnome/desktop/interface/gtk-theme)"
expect_eq "Vitre Dock's settings are gone again (icon size)" "" "$(dc /org/gnome/shell/extensions/vitre-dock/icon-size)"
expect_eq "a setting Vitre does not own keeps the later change (clock format)" "'24h'" "$(dc /org/gnome/desktop/interface/clock-format)"
snap_files > "$W/after6.files"
same "after both uninstalls every file is as before" "$W/before6.files" "$W/after6.files"
[ -z "$(ls -d "$DATA"/vitre-backup/[0-9]*-??????/ 2>/dev/null)" ] && pass "no un-undone backup is left" || fail "an un-undone backup is left"
endgroup

# ---- scenario 7 -----------------------------------------------------------------------------------------------------------------------
group "scenario 7: installed files keep the user's umask, the backup is private"
OLDMASK="$(umask)"; umask 022
run install-7 bash "$INSTALL"; expect_eq "install under umask 022 exits 0" "0" "$RC"
B7="$(ls -dt "$DATA"/vitre-backup/[0-9]*-??????-??????/ | head -1)"; B7="${B7%/}"
expect_eq "backup directory is 700" "700" "$(stat -c %a "$B7")"
expect_eq "backup file list is 600" "600" "$(stat -c %a "$B7/installed.txt")"
# cp -a keeps the modes the package has, so these are compared with the package, not with a fixed number
expect_eq "an installed extension file has the package's mode" "$(stat -c %a "$REPO/extensions/vitre-stage@vitre-desktop/metadata.json")" "$(stat -c %a "$EXT/vitre-stage@vitre-desktop/metadata.json")"
expect_eq "an installed extension folder has the package's mode" "$(stat -c %a "$REPO/extensions/vitre-stage@vitre-desktop")" "$(stat -c %a "$EXT/vitre-stage@vitre-desktop")"
case "$(stat -c %a "$EXT/vitre-stage@vitre-desktop/schemas/gschemas.compiled")" in *[4-7]) pass "the compiled schemas are readable by others" ;; *) fail "the compiled schemas are private (umask leaked into the installer)" ;; esac
expect_eq "the base icon theme index is 644" "644" "$(stat -c %a "$ICONS/VitreBase-dark/index.theme")"
expect_eq "the Settings menu entry is 644" "644" "$(stat -c %a "$DATA/applications/org.vitre.Settings.desktop")"
run uninstall-7 bash "$UNINSTALL"; expect_eq "uninstall exits 0" "0" "$RC"
umask "$OLDMASK"
endgroup

# ---- scenario 8 -----------------------------------------------------------------------------------------------------------------------
group "scenario 8: the base icon theme download is checked against the pinned SHA-256"
PIN="$(sed -n 's/^MACTAHOE_ICONS_SHA256="\([0-9a-f]*\)".*/\1/p' "$INSTALL")"
TARPIN="$(sed -n 's/^MACTAHOE_ICONS_TAR_SHA256="\([0-9a-f]*\)".*/\1/p' "$INSTALL")"
REF="$(sed -n 's/^MACTAHOE_ICONS_REF="\([0-9a-f]*\)".*/\1/p' "$INSTALL")"
[ "${#PIN}" -eq 64 ] && [ "${#TARPIN}" -eq 64 ] && pass "install.sh pins a SHA-256 for the archive and one for its content" || fail "install.sh has no pinned SHA-256"
mkdir -p "$W/stub"
cat > "$W/stub/curl" <<'EOS'
#!/bin/sh
# stands in for curl: copies $STUB_ARCHIVE to the -o file; the real network is never used
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; esac; shift; done
[ -n "$out" ] && cp "$STUB_ARCHIVE" "$out"
EOS
chmod +x "$W/stub/curl"
snap_files > "$W/before8.files"; snap_settings > "$W/before8.dconf"
# (a) a wrong archive that holds an install.sh which leaves a canary: it must be refused before it is unpacked or run
mkdir -p "$W/bad/MacTahoe-icon-theme-bad"
printf '#!/bin/sh\ntouch "%s"\n' "$W/CANARY" > "$W/bad/MacTahoe-icon-theme-bad/install.sh"; chmod +x "$W/bad/MacTahoe-icon-theme-bad/install.sh"
tar -czf "$W/bad.tar.gz" -C "$W/bad" MacTahoe-icon-theme-bad
run install-8bad env -u VITRE_ICONS_SRC PATH="$W/stub:$PATH" STUB_ARCHIVE="$W/bad.tar.gz" bash "$INSTALL"
[ "$RC" -ne 0 ] && pass "a wrong archive stops the install (exit $RC)" || fail "a wrong archive did not stop the install"
grep -q 'checksum did not match; refusing to execute it' "$LAST_LOG" && pass "...and says why" || fail "no checksum message: $(tail -2 "$LAST_LOG" | tr '\n' '|')"
[ ! -e "$W/CANARY" ] && pass "...and the archive's install.sh never ran" || fail "the wrong archive's install.sh ran"
[ ! -e "$ICONS/VitreBase-dark" ] && pass "...and no base icon theme was installed" || fail "a base icon theme was installed from a wrong archive"
run uninstall-8bad bash "$UNINSTALL"; expect_eq "the stopped install can be undone" "0" "$RC"
snap_files > "$W/after8bad.files"; snap_settings > "$W/after8bad.dconf"
same "...and everything is back as before" "$W/before8.files" "$W/after8bad.files"
same "...settings too" "$W/before8.dconf" "$W/after8bad.dconf"
# (b) the pinned archive, rebuilt from a checkout (git archive | gzip -n -6 is how GitHub makes it), and (c) the same content compressed differently
GOOD="${VITRE_ICONS_ARCHIVE:-}"
if [ -z "$GOOD" ] && [ -n "${VITRE_ICONS_SRC:-}" ] && [ "$(git -C "$VITRE_ICONS_SRC" rev-parse HEAD 2>/dev/null)" = "$REF" ]; then
  git -C "$VITRE_ICONS_SRC" archive --prefix="MacTahoe-icon-theme-$REF/" "$REF" | gzip -n -6 > "$W/good.tar.gz" && GOOD="$W/good.tar.gz"
fi
if [ -n "$GOOD" ]; then
  expect_eq "the archive for the pinned ref matches the pinned SHA-256" "$PIN" "$(sha256sum "$GOOD" | cut -d' ' -f1)"
  run install-8good env -u VITRE_ICONS_SRC PATH="$W/stub:$PATH" STUB_ARCHIVE="$GOOD" bash "$INSTALL"
  expect_eq "the pinned archive installs" "0" "$RC"
  [ -d "$ICONS/VitreBase-dark" ] && pass "...and the base icon theme is in place" || fail "...but the base icon theme is missing"
  run uninstall-8good bash "$UNINSTALL"; expect_eq "uninstall exits 0" "0" "$RC"
  gzip -dc "$GOOD" | gzip -n -9 > "$W/good9.tar.gz"
  expect_eq "the decompressed content matches the second pin" "$TARPIN" "$(gzip -dc "$W/good9.tar.gz" | sha256sum | cut -d' ' -f1)"
  run install-8gz env -u VITRE_ICONS_SRC PATH="$W/stub:$PATH" STUB_ARCHIVE="$W/good9.tar.gz" bash "$INSTALL"
  expect_eq "the same content compressed differently installs" "0" "$RC"
  run uninstall-8gz bash "$UNINSTALL"; expect_eq "uninstall exits 0" "0" "$RC"
  snap_files > "$W/after8.files"; same "everything is back as before" "$W/before8.files" "$W/after8.files"
else
  note "skipped (b) and (c): no archive for the pinned ref (set VITRE_ICONS_ARCHIVE, or VITRE_ICONS_SRC to a git checkout at $REF)"
  summary_line "- install-test: the pinned-archive install was not run here (no archive or checkout at the pinned ref)"
fi
endgroup

finish "install-test"

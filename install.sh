#!/usr/bin/env bash
# Vitre installer: installs the Vitre desktop for the current user (no root, no system files).
#   ./install.sh            install or upgrade (takes a private backup of what it replaces and of the settings it owns first)
#   ./install.sh --check    only check this system, change nothing
# An upgrade (an earlier Vitre install is still on record) keeps every Vitre setting you already have and only adds the ones that are new.
# Supported: GNOME Shell 51 (tested on Ubuntu 26.10), Wayland, x86_64 or arm64.
set -euo pipefail
# The backup is private (umask 077). What is installed keeps your normal umask, so the files in your home look as they always did.
USER_UMASK="$(umask)"
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$(realpath -m -- "${XDG_DATA_HOME:-$HOME/.local/share}")"
CONF="$(realpath -m -- "${XDG_CONFIG_HOME:-$HOME/.config}")"
EXT_DIR="$DATA/gnome-shell/extensions"
ICONS="$DATA/icons"
BACKUP_ROOT="$DATA/vitre-backup"
CHECK_ONLY=0
FORCE=0
# The base icon theme (MacTahoe-icon-theme, GPL-3.0, vinceliuice) is fetched from its own project at this exact version
# instead of being copied into Vitre.
MACTAHOE_ICONS_REF="839848b9a8a38a92a6936e30c4abe35cc6f2546d"   # tag 2026-09-10
MACTAHOE_ICONS_URL="https://github.com/vinceliuice/MacTahoe-icon-theme/archive/$MACTAHOE_ICONS_REF.tar.gz"
# SHA-256 of the exact GitHub archive at MACTAHOE_ICONS_URL; verified before extraction or execution. GitHub makes the archive with
# `git archive | gzip -n -6`, so both numbers can be rebuilt from a checkout at that ref:
#   git archive --prefix=MacTahoe-icon-theme-<ref>/ <ref> | gzip -n -6 | sha256sum     -> MACTAHOE_ICONS_SHA256
#   git archive --prefix=MacTahoe-icon-theme-<ref>/ <ref> | sha256sum                  -> MACTAHOE_ICONS_TAR_SHA256
# The second one is the same archive without the compression: if GitHub ever changes how it compresses, the content check still holds.
MACTAHOE_ICONS_SHA256="00cb36a3883e40687ade9f57a0c1dd3e14fda84b73efc69aa86e2be67f32ab0a"
MACTAHOE_ICONS_TAR_SHA256="3c54833f2306d3c668b024f7df8d36a803852082fbcf688750e282aa2852d479"

for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n 2,6p "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'vitre: %s\n' "$*" >&2; exit 1; }

# ---- 1. is this a system Vitre runs on? -------------------------------------------------------------------------------
[ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not root (Vitre installs into your home folder only)"
command -v gnome-shell >/dev/null || fail "GNOME Shell is not installed"
SHELL_MAJOR="$(gnome-shell --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
if [ "$SHELL_MAJOR" != "51" ] && [ "$FORCE" -ne 1 ]; then
  fail "Vitre is built and tested for GNOME Shell 51; this system has GNOME Shell $SHELL_MAJOR (--force to try anyway)"
fi
for c in gsettings dconf glib-compile-schemas; do command -v "$c" >/dev/null || fail "missing command: $c"; done
if [ "${XDG_SESSION_TYPE:-wayland}" != "wayland" ]; then
  echo "note: this session is ${XDG_SESSION_TYPE}; Vitre is tested on Wayland only"
fi
MISSING_FONTS=()
FAMILIES="$(fc-list : family 2>/dev/null || true)"
grep -qE '^Inter(,|$)' <<< "$FAMILIES" || MISSING_FONTS+=("Inter")
grep -q 'JetBrains Mono' <<< "$FAMILIES" || MISSING_FONTS+=("JetBrains Mono")
say "GNOME Shell $SHELL_MAJOR, $(uname -m): supported"
if [ ${#MISSING_FONTS[@]} -gt 0 ]; then
  echo "fonts not installed: ${MISSING_FONTS[*]} (Vitre falls back to the default font until they are)."
  if command -v apt >/dev/null; then echo "  install them with: sudo apt install fonts-inter fonts-jetbrains-mono"
  elif command -v dnf >/dev/null; then echo "  install them with: sudo dnf install rsms-inter-fonts jetbrains-mono-fonts"; fi
fi
# Vitre Settings is a GTK 4 app written in GJS: it needs gjs and libadwaita's typelib, which a GNOME 51 desktop has. Only the app depends on them.
if ! command -v gjs >/dev/null || ! gjs -c "imports.gi.versions.Adw = '1'; imports.gi.Adw" >/dev/null 2>&1; then
  echo "note: Vitre Settings needs gjs and libadwaita for GJS (Ubuntu: sudo apt install gjs gir1.2-adw-1). The rest of Vitre does not."
fi
[ "$CHECK_ONLY" -eq 1 ] && { echo "check only: nothing changed"; exit 0; }

# ---- 2. backup -------------------------------------------------------------------------------------------------------
UPGRADE=0
for old in "$BACKUP_ROOT"/[0-9]*; do
  [ -d "$old" ] && [[ "$old" != *.undone ]] && UPGRADE=1
done
mkdir -p "$BACKUP_ROOT"
BACKUP="$(mktemp -d "$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-XXXXXX")"
mkdir -p "$BACKUP/files" "$BACKUP/settings/before" "$BACKUP/settings/after"
: > "$BACKUP/installed.txt"     # every path this install created (uninstall removes them)
: > "$BACKUP/moved.txt"         # every path that existed and was moved into the backup (uninstall moves it back)
: > "$BACKUP/settings/paths.txt"
printf 'DATA\t%s\nCONF\t%s\nTHEMES\t%s\n' "$DATA" "$CONF" "$HOME/.themes" > "$BACKUP/roots.txt"
MOVED_COUNT=0

record_key() {  # remember the old value once; after the install, remember the value Vitre left behind
  local path="$1" n
  grep -qxF -- "$path" "$BACKUP/settings/paths.txt" && return
  echo "$path" >> "$BACKUP/settings/paths.txt"
  n="$(wc -l < "$BACKUP/settings/paths.txt")"
  dconf read "$path" > "$BACKUP/settings/before/$n" 2>/dev/null || :
}

place() {   # place SRC DST: put a copy of SRC at DST, moving whatever was at DST into the backup first
  local src="$1" dst="$2"
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    MOVED_COUNT=$((MOVED_COUNT + 1))
    local keep="$BACKUP/files/$MOVED_COUNT"
    mv "$dst" "$keep"
    printf '%s\t%s\n' "$dst" "$keep" >> "$BACKUP/moved.txt"
  fi
  ( umask "$USER_UMASK"; mkdir -p "$(dirname "$dst")"; cp -a "$src" "$dst" )
  echo "$dst" >> "$BACKUP/installed.txt"
}

# one scratch folder for everything that is generated on the way (the menu entry, the base icon theme); removed on exit
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

say "installing (backup in $BACKUP)"

# ---- 3. files --------------------------------------------------------------------------------------------------------
for e in "$HERE"/extensions/*/; do
  e="${e%/}"; place "$e" "$EXT_DIR/$(basename "$e")"
done
# Compile each extension's settings schemas here, with this system's own GLib, instead of trusting the compiled files in the package.
for e in "$HERE"/extensions/*/; do
  d="$EXT_DIR/$(basename "${e%/}")/schemas"
  if ls "$d"/*.gschema.xml >/dev/null 2>&1; then
    ( umask "$USER_UMASK"; glib-compile-schemas "$d" ) || echo "note: could not compile the settings schemas in $d (the packaged ones stay)"
  fi
done
# Vitre-Glass and its accent colour variants (Vitre-Glass-Green, Vitre-Glass-Green-Light, ...): GTK 3 apps cannot read the accent or the
# style, so Vitre Appearance switches between these by name
for t in "$HERE"/themes/*/; do
  t="${t%/}"; place "$t" "$HOME/.themes/$(basename "$t")"
done
place "$HERE/icons/Vitre-Icons" "$ICONS/Vitre-Icons"
place "$HERE/icons/Vitre-Cursor" "$ICONS/Vitre-Cursor"
for f in "$HERE"/icons/hicolor/scalable/apps/*.svg; do place "$f" "$ICONS/hicolor/scalable/apps/$(basename "$f")"; done
place "$HERE/backgrounds/vitre" "$DATA/backgrounds/vitre"
for v in gtk-4.0 gtk-3.0; do
  for f in "$HERE/gtk/$v"/*; do place "$f" "$CONF/$v/$(basename "$f")"; done
done

# Vitre Settings: the app, its menu entry (the launcher's path is filled in here) and its icons. The version file is what its About page
# reads (the system packages keep it in /usr/share/vitre); $DATA/vitre is listed first so that uninstall removes the folder too.
place "$HERE/apps/vitre-settings" "$DATA/vitre-settings"
LAUNCHER="$DATA/vitre-settings/org.vitre.Settings"
case "$LAUNCHER" in *[[:space:]]*) LAUNCHER="\"$LAUNCHER\"" ;; esac     # an Exec line needs quotes around a path with spaces
ENTRY="$(<"$HERE/apps/org.vitre.Settings.desktop.in")"
printf '%s\n' "${ENTRY//@LAUNCHER@/$LAUNCHER}" > "$STAGE/org.vitre.Settings.desktop"
place "$STAGE/org.vitre.Settings.desktop" "$DATA/applications/org.vitre.Settings.desktop"
chmod 644 "$DATA/applications/org.vitre.Settings.desktop"
place "$HERE/icons/hicolor/symbolic/apps/org.vitre.Settings-symbolic.svg" "$ICONS/hicolor/symbolic/apps/org.vitre.Settings-symbolic.svg"
[ -e "$DATA/vitre" ] || echo "$DATA/vitre" >> "$BACKUP/installed.txt"
place "$HERE/VERSION" "$DATA/vitre/VERSION"

# The base of Vitre-Icons: the glyphs, folders and file types of the MacTahoe icon theme, installed as its own copy named VitreBase
# WITHOUT MacTahoe's app icons (some of them are drawn after other companies' apps). An app without original Vitre art then keeps its own
# icon. It is fetched from its own project at a fixed version. VITRE_ICONS_SRC=<a checkout of MacTahoe-icon-theme> uses a local copy.
if [ ! -d "$ICONS/VitreBase-dark" ]; then
  T="$STAGE/base"
  mkdir -p "$T"
  if [ -n "${VITRE_ICONS_SRC:-}" ]; then
    [ -x "$VITRE_ICONS_SRC/install.sh" ] || fail "VITRE_ICONS_SRC must be a checkout of MacTahoe-icon-theme (a folder with install.sh)"
    SRC="$VITRE_ICONS_SRC"
  else
    [[ "$MACTAHOE_ICONS_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "MACTAHOE_ICONS_SHA256 must contain the verified SHA-256 for $MACTAHOE_ICONS_URL (or set VITRE_ICONS_SRC to a local checkout)"
    say "fetching the base icon theme from github.com/vinceliuice/MacTahoe-icon-theme"
    command -v curl >/dev/null || fail "curl is needed to fetch the icon theme"
    ARCHIVE="$STAGE/MacTahoe-icon-theme.tar.gz"
    curl -fsSL "$MACTAHOE_ICONS_URL" -o "$ARCHIVE"
    # nothing of the download is unpacked or run before it matches a pinned digest: the file as served, else its decompressed content
    got="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
    if [ "$got" != "$MACTAHOE_ICONS_SHA256" ]; then
      got_tar="$(gzip -dc "$ARCHIVE" 2>/dev/null | sha256sum | cut -d' ' -f1)"
      [ "$got_tar" = "$MACTAHOE_ICONS_TAR_SHA256" ] || fail "the MacTahoe archive checksum did not match; refusing to execute it"
    fi
    tar -xzf "$ARCHIVE" -C "$T" --no-same-owner
    SRC="$(echo "$T"/MacTahoe-icon-theme-*)"
  fi
  mkdir -p "$T/out"
  (umask "$USER_UMASK"; cd "$SRC" && ./install.sh -d "$T/out" -n VitreBase -t default >/dev/null)
  for n in VitreBase VitreBase-dark VitreBase-light; do
    [ -d "$T/out/$n" ] || fail "the base icon theme did not install ($n is missing)"
    rm -rf "$T/out/$n/apps" "$T/out/$n/apps@2x"
    find "$T/out/$n" -xtype l -delete
    command -v gtk-update-icon-cache >/dev/null && ( umask "$USER_UMASK"; gtk-update-icon-cache -f -t -q "$T/out/$n" ) 2>/dev/null || true
    place "$T/out/$n" "$ICONS/$n"
  done
fi
command -v gtk-update-icon-cache >/dev/null && for n in Vitre-Icons Vitre-Cursor; do ( umask "$USER_UMASK"; gtk-update-icon-cache -f -t -q "$ICONS/$n" ) 2>/dev/null || true; done

# ---- 4. settings -----------------------------------------------------------------------------------------------------
# Vitre Dock is a fork of Dhruva with its own settings path. On a first install, copy only keys its schema has; Vitre's defaults then win.
# An upgrade leaves every existing Vitre choice alone and adds only newly introduced defaults.
OLD_DOCK=/org/gnome/shell/extensions/dhruva/
NEW_DOCK=/org/gnome/shell/extensions/vitre-dock/
DOCK_SCHEMAS="$EXT_DIR/vitre-dock@vitre-desktop/schemas"
OLD_KEYS="$(dconf list "$OLD_DOCK" 2>/dev/null || true)"
if [ -n "$OLD_KEYS" ] && [ -d "$DOCK_SCHEMAS" ]; then
  NEW_KEYS="$(gsettings --schemadir "$DOCK_SCHEMAS" list-keys org.gnome.shell.extensions.vitre-dock 2>/dev/null || true)"
  copied=0
  while IFS= read -r k; do
    case "$k" in ''|*/) continue ;; esac
    grep -qxF -- "$k" <<< "$NEW_KEYS" || continue
    v="$(dconf read "$OLD_DOCK$k" 2>/dev/null || true)"
    [ -n "$v" ] || continue
    record_key "$NEW_DOCK$k"
    if [ "$UPGRADE" -eq 0 ] || [ -z "$(dconf read "$NEW_DOCK$k" 2>/dev/null || true)" ]; then
      dconf write "$NEW_DOCK$k" "$v" && copied=$((copied + 1))
    fi
  done <<< "$OLD_KEYS"
  echo "Dhruva settings found: $copied copied to Vitre Dock"
fi
while IFS=$'\t' read -r path value; do
  [ -n "$path" ] || continue
  record_key "$path"
  if [ "$UPGRADE" -eq 0 ] || [ -z "$(dconf read "$path" 2>/dev/null || true)" ]; then
    dconf write "$path" "${value//@HOME@/$HOME}"
  fi
done < <(python3 - "$HERE/settings/vitre.ini" <<'EOF'
import sys
section = None
for line in open(sys.argv[1]):
    line = line.rstrip('\n')
    if line.startswith('[') and line.endswith(']'):
        section = line[1:-1]
    elif '=' in line and section and not line.startswith('#'):
        key, value = line.split('=', 1)
        print(f'/org/gnome/{section}/{key}\t{value}')
EOF
)

enabled="$(gsettings get org.gnome.shell enabled-extensions)"
disabled="$(gsettings get org.gnome.shell disabled-extensions)"
python3 - "$enabled" "$disabled" "$HERE/settings/extensions.txt" "$HERE/settings/conflicts.txt" > "$BACKUP/new-lists.txt" <<'EOF'
import ast, sys
def parse(s):
    s = s.strip()
    if s.startswith('@as'):
        s = s[3:].strip()
    return list(ast.literal_eval(s)) if s else []
enabled, disabled = parse(sys.argv[1]), parse(sys.argv[2])
ours = [l.strip() for l in open(sys.argv[3]) if l.strip()]
conflicts = [l.strip() for l in open(sys.argv[4]) if l.strip()]
keep = [u for u in enabled if u not in ours and u not in conflicts]
new_enabled = keep + ours
new_disabled = [u for u in disabled if u not in ours] + [u for u in conflicts if u not in disabled]
print(repr(new_enabled))
print(repr(new_disabled))
EOF
for key in enabled-extensions disabled-extensions disable-user-extensions; do record_key "/org/gnome/shell/$key"; done
gsettings set org.gnome.shell enabled-extensions "$(sed -n 1p "$BACKUP/new-lists.txt")"
gsettings set org.gnome.shell disabled-extensions "$(sed -n 2p "$BACKUP/new-lists.txt")"
gsettings set org.gnome.shell disable-user-extensions false

n=0
while IFS= read -r path; do
  n=$((n + 1))
  dconf read "$path" > "$BACKUP/settings/after/$n" 2>/dev/null || :
done < "$BACKUP/settings/paths.txt"

say "Vitre is installed."
echo "Sign out and back in to start it (GNOME loads extensions at sign-in)."
echo "To undo everything: $HERE/uninstall.sh"

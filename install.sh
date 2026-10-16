#!/usr/bin/env bash
# Vitre installer: installs the Vitre desktop for the current user (no root, no system files).
#   ./install.sh            install (takes a backup first; ./uninstall.sh puts everything back)
#   ./install.sh --check    only check this system, change nothing
# Supported: GNOME Shell 51 (tested on Ubuntu 26.10), Wayland, x86_64 or arm64.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
EXT_DIR="$DATA/gnome-shell/extensions"
ICONS="$DATA/icons"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$DATA/vitre-backup/$STAMP"
CHECK_ONLY=0
FORCE=0
# The base icon theme (MacTahoe-icon-theme, GPL-3.0, vinceliuice) is fetched from its own project at this exact version
# instead of being copied into Vitre.
MACTAHOE_ICONS_REF="839848b9a8a38a92a6936e30c4abe35cc6f2546d"   # tag 2026-09-10
MACTAHOE_ICONS_URL="https://github.com/vinceliuice/MacTahoe-icon-theme/archive/$MACTAHOE_ICONS_REF.tar.gz"

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
[ "$CHECK_ONLY" -eq 1 ] && { echo "check only: nothing changed"; exit 0; }

# ---- 2. backup -------------------------------------------------------------------------------------------------------
mkdir -p "$BACKUP/files"
dconf dump /org/gnome/ > "$BACKUP/dconf.ini"
: > "$BACKUP/installed.txt"     # every path this install created (uninstall removes them)
: > "$BACKUP/moved.txt"         # every path that existed and was moved into the backup (uninstall moves it back)
echo "$HOME" > "$BACKUP/home.txt"

place() {   # place SRC DST: put a copy of SRC at DST, moving whatever was at DST into the backup first
  local src="$1" dst="$2"
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    local keep="$BACKUP/files/$(echo "$dst" | sed "s|^$HOME/||; s|/|__|g")"
    mv "$dst" "$keep"
    printf '%s\t%s\n' "$dst" "$keep" >> "$BACKUP/moved.txt"
  fi
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
  echo "$dst" >> "$BACKUP/installed.txt"
}

say "installing (backup in $BACKUP)"

# ---- 3. files --------------------------------------------------------------------------------------------------------
for e in "$HERE"/extensions/*/; do
  e="${e%/}"; place "$e" "$EXT_DIR/$(basename "$e")"
done
place "$HERE/themes/Vitre-Glass" "$HOME/.themes/Vitre-Glass"
place "$HERE/icons/Vitre-Icons" "$ICONS/Vitre-Icons"
place "$HERE/icons/Vitre-Cursor" "$ICONS/Vitre-Cursor"
for f in "$HERE"/icons/hicolor/scalable/apps/*.svg; do place "$f" "$ICONS/hicolor/scalable/apps/$(basename "$f")"; done
place "$HERE/backgrounds/vitre" "$DATA/backgrounds/vitre"
for v in gtk-4.0 gtk-3.0; do
  for f in "$HERE/gtk/$v"/*; do place "$f" "$CONF/$v/$(basename "$f")"; done
done

# The base of Vitre-Icons: the glyphs, folders and file types of the MacTahoe icon theme, installed as its own copy named VitreBase
# WITHOUT MacTahoe's app icons (some of them are drawn after other companies' apps). An app without original Vitre art then keeps its own
# icon. It is fetched from its own project at a fixed version. VITRE_ICONS_SRC=<a checkout of MacTahoe-icon-theme> uses a local copy.
if [ ! -d "$ICONS/VitreBase-dark" ]; then
  T="$(mktemp -d)"
  trap 'rm -rf "$T"' EXIT
  if [ -n "${VITRE_ICONS_SRC:-}" ]; then
    [ -x "$VITRE_ICONS_SRC/install.sh" ] || fail "VITRE_ICONS_SRC must be a checkout of MacTahoe-icon-theme (a folder with install.sh)"
    SRC="$VITRE_ICONS_SRC"
  else
    say "fetching the base icon theme from github.com/vinceliuice/MacTahoe-icon-theme"
    command -v curl >/dev/null || fail "curl is needed to fetch the icon theme"
    curl -fsSL "$MACTAHOE_ICONS_URL" | tar -xz -C "$T"
    SRC="$(echo "$T"/MacTahoe-icon-theme-*)"
  fi
  mkdir -p "$T/out"
  (cd "$SRC" && ./install.sh -d "$T/out" -n VitreBase -t default >/dev/null)
  for n in VitreBase VitreBase-dark VitreBase-light; do
    [ -d "$T/out/$n" ] || fail "the base icon theme did not install ($n is missing)"
    rm -rf "$T/out/$n/apps" "$T/out/$n/apps@2x"
    find "$T/out/$n" -xtype l -delete
    command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t -q "$T/out/$n" 2>/dev/null || true
    place "$T/out/$n" "$ICONS/$n"
  done
fi
command -v gtk-update-icon-cache >/dev/null && for n in Vitre-Icons Vitre-Cursor; do gtk-update-icon-cache -f -t -q "$ICONS/$n" 2>/dev/null || true; done

# ---- 4. settings -----------------------------------------------------------------------------------------------------
sed "s|@HOME@|$HOME|g" "$HERE/settings/vitre.ini" | dconf load /org/gnome/

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
gsettings set org.gnome.shell enabled-extensions "$(sed -n 1p "$BACKUP/new-lists.txt")"
gsettings set org.gnome.shell disabled-extensions "$(sed -n 2p "$BACKUP/new-lists.txt")"
gsettings set org.gnome.shell disable-user-extensions false

say "Vitre is installed."
echo "Sign out and back in to start it (GNOME loads extensions at sign-in)."
echo "To undo everything: $HERE/uninstall.sh"

#!/bin/bash
# vitre-stage.sh STAGE_DIR
# Lays out the files of the ten Vitre binary packages under STAGE_DIR/<package>/ (usr/..., etc/...). The Fedora spec (%install) and the
# Arch PKGBUILD (build/package) both call this, so the two packagings ship the same tree. It is the counterpart of release/native/tools/
# stage.sh, which does the same for the .debs; the differences are listed in distro/README.md.
#
# Inputs (environment):
#   VITRE_SRC       the Vitre source tree (the tag archive of github.com/chrismteryli/vitre, or release/vitre)
#   MACTAHOE_SRC    MacTahoe-icon-theme at the ref install.sh pins (839848b9a8a38a92a6936e30c4abe35cc6f2546d)
#   VITRE_COMMON    folder with the session files (default: the folder of this script)
#   SOURCE_DATE_EPOCH  mtime of every staged file (default 1792627200, same as the .debs)
# No network, no root. Needs: bash, python3, glib-compile-schemas (glib2), find, cp, sed, touch.
#   vitre-shell         every vitre-*@vitre-desktop extension except the Dock
#   vitre-shell-extras  the third-party extensions and Vitre Dock (a fork of Dhruva, kept with them and their licences)
#   not shipped         user-theme (the distribution's gnome-shell-extension-user-theme provides it; a copy would clash with it)
set -euo pipefail
: "${VITRE_SRC:?set VITRE_SRC to the Vitre source tree}"
: "${MACTAHOE_SRC:?set MACTAHOE_SRC to the MacTahoe-icon-theme source tree}"
C="${VITRE_COMMON:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PKG="$(cd "$VITRE_SRC" && pwd)"
ICONS_SRC="$(cd "$MACTAHOE_SRC" && pwd)"
S="$(realpath -m "$1")"
EPOCH="${SOURCE_DATE_EPOCH:-1792627200}"
export SOURCE_DATE_EPOCH="$EPOCH"
say() { printf '== %s\n' "$*"; }
USER_THEME=user-theme@gnome-shell-extensions.gcampax.github.com
PACKAGES=(vitre-desktop vitre-session vitre-shell vitre-shell-extras vitre-theme vitre-icons vitre-icons-base vitre-cursor vitre-backgrounds vitre-system)

[ -f "$PKG/VERSION" ] && [ -d "$PKG/extensions" ] && [ -d "$PKG/themes/Vitre-Glass" ] || { echo "vitre-stage.sh: $PKG is not a Vitre source tree" >&2; exit 1; }
[ -x "$ICONS_SRC/install.sh" ] || { echo "vitre-stage.sh: $ICONS_SRC is not a MacTahoe-icon-theme tree" >&2; exit 1; }
for f in vitre-session vitre.session vitre.desktop vitre.session.conf vitre-user-setup vitre-user-setup.service vitre-mode.json.in \
         dconf-profile-vitre vitre-backgrounds.xml make-defaults.py make-parity.py 10-ubuntu-parity sanitize-staged.py make-mode.py session-extensions.txt README.vitre-session; do
  [ -f "$C/$f" ] || { echo "vitre-stage.sh: missing session file $C/$f" >&2; exit 1; }
done

OWN=(); EXTRAS=()
while IFS= read -r u; do
  case "$u" in
    "$USER_THEME") ;;
    vitre-dock@vitre-desktop) EXTRAS+=("$u") ;;
    vitre-*@vitre-desktop) OWN+=("$u") ;;
    *) EXTRAS+=("$u") ;;
  esac
done < <(cd "$PKG/extensions" && ls -1 | LC_ALL=C sort)
# every extension that install.sh enables must be in one of the two packages (or be user-theme, which the distribution provides)
while IFS= read -r u; do
  if [ -z "$u" ] || [ "$u" = "$USER_THEME" ]; then continue; fi
  printf '%s\n' "${OWN[@]}" "${EXTRAS[@]}" | grep -qxF "$u" || { echo "vitre-stage.sh: $u is in settings/extensions.txt but not in the extensions folder" >&2; exit 1; }
done < "$PKG/settings/extensions.txt"

rm -rf "$S"; mkdir -p "$S"
for p in "${PACKAGES[@]}"; do mkdir -p "$S/$p"; done

put_ext() {   # put_ext PACKAGE UUID: the extension, its settings schemas compiled with this machine's glib, its licence file under licenses/
  local dst="$S/$1/usr/share/gnome-shell/extensions/$2"
  mkdir -p "$(dirname "$dst")"
  cp -a "$PKG/extensions/$2" "$dst"
  find "$dst" \( -name 'gschemas.compiled' -o -name '*.orig' -o -name '*.rej' -o -name '__pycache__' \) -prune -exec rm -rf {} +
  if ls "$dst"/schemas/*.gschema.xml >/dev/null 2>&1; then glib-compile-schemas --strict "$dst/schemas"; fi
  local l
  for l in LICENSE COPYING NOTICE.txt; do
    if [ -f "$dst/$l" ]; then
      mkdir -p "$S/$1/usr/share/licenses/$1"
      cp "$dst/$l" "$S/$1/usr/share/licenses/$1/$2.$l"
    fi
  done
}

say "vitre-shell (${#OWN[@]} extensions)"
for e in "${OWN[@]}"; do put_ext vitre-shell "$e"; done
say "vitre-shell-extras (${#EXTRAS[@]} extensions: ${EXTRAS[*]})"
for e in "${EXTRAS[@]}"; do put_ext vitre-shell-extras "$e"; done

say "vitre-session"
D="$S/vitre-session"
mkdir -p "$D/usr/bin" "$D/usr/lib/vitre" "$D/usr/lib/systemd/user/gnome-session@vitre.target.d" "$D/usr/share/gnome-session/sessions" \
         "$D/usr/share/wayland-sessions" "$D/usr/share/gnome-shell/modes" "$D/etc/dconf/profile" "$D/etc/dconf/db/vitre.d" "$D/usr/share/doc/vitre-session"
install -m 0755 "$C/vitre-session" "$D/usr/bin/vitre-session"
install -m 0755 "$C/vitre-user-setup" "$D/usr/lib/vitre/vitre-user-setup"
# the unit's Documentation= line names the Debian README in the .debs; here the README has no .Debian suffix
sed 's|/usr/share/doc/vitre-session/README.Debian|/usr/share/doc/vitre-session/README|' "$C/vitre-user-setup.service" > "$D/usr/lib/systemd/user/vitre-user-setup.service"
install -m 0644 "$C/vitre.session.conf" "$D/usr/lib/systemd/user/gnome-session@vitre.target.d/vitre.session.conf"
install -m 0644 "$C/vitre.session" "$D/usr/share/gnome-session/sessions/vitre.session"
install -m 0644 "$C/vitre.desktop" "$D/usr/share/wayland-sessions/vitre.desktop"
install -m 0644 "$C/dconf-profile-vitre" "$D/etc/dconf/profile/vitre"
install -m 0644 "$C/README.vitre-session" "$D/usr/share/doc/vitre-session/README"
# the system defaults: the same keys as the per-user install (settings/vitre.ini), system paths instead of $HOME
VITRE_PKG_SRC="$PKG" python3 -I "$C/make-defaults.py" "$D/etc/dconf/db/vitre.d/00-vitre" >/dev/null
# part 2: the values Ubuntu's per-desktop overrides give the Ubuntu session (hot corners off, start in the desktop, tap to click, Alt+Tab ...),
# repeated so the Vitre session behaves the same here; the Ubuntu-only parts are dropped (see make-parity.py)
python3 -I "$C/make-parity.py" "$C/10-ubuntu-parity" "$D/etc/dconf/db/vitre.d/10-gnome-parity"
python3 -I "$C/make-mode.py" "$C/vitre-mode.json.in" "$PKG/settings/extensions.txt" "$C/session-extensions.txt" "$D/usr/share/gnome-shell/modes/vitre.json"

say "vitre-theme"
D="$S/vitre-theme"
mkdir -p "$D/usr/share/themes" "$D/usr/share/vitre"
cp -a "$PKG/themes/Vitre-Glass" "$D/usr/share/themes/Vitre-Glass"
cp -a "$PKG/gtk/gtk-3.0" "$D/usr/share/vitre/gtk-3.0"
cp -a "$PKG/gtk/gtk-4.0" "$D/usr/share/vitre/gtk-4.0"
cp "$PKG/VERSION" "$D/usr/share/vitre/VERSION"
mkdir -p "$D/usr/share/licenses/vitre-theme"
cp "$PKG/themes/Vitre-Glass/COPYING" "$D/usr/share/licenses/vitre-theme/Vitre-Glass.COPYING"
cp "$PKG/themes/Vitre-Glass/NOTICE.txt" "$D/usr/share/licenses/vitre-theme/Vitre-Glass.NOTICE.txt"

say "vitre-icons"
D="$S/vitre-icons"
mkdir -p "$D/usr/share/icons"
cp -a "$PKG/icons/Vitre-Icons" "$D/usr/share/icons/Vitre-Icons"
rm -f "$D/usr/share/icons/Vitre-Icons/icon-theme.cache"    # rebuilt by the package scripts on the installed system
cp -a "$PKG/icons/hicolor" "$D/usr/share/icons/hicolor"

say "vitre-icons-base (VitreBase from MacTahoe-icon-theme)"
D="$S/vitre-icons-base"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
(cd "$ICONS_SRC" && ./install.sh -d "$T" -n VitreBase -t default >/dev/null 2>&1)
mkdir -p "$D/usr/share/icons"
for n in VitreBase VitreBase-dark VitreBase-light; do
  [ -d "$T/$n" ] || { echo "the base icon theme did not build ($n)" >&2; exit 1; }
  rm -rf "$T/$n/apps" "$T/$n/apps@2x"          # MacTahoe's app icons are left out on purpose (see CREDITS.md)
  find "$T/$n" -xtype l -delete
  rm -f "$T/$n/icon-theme.cache"
  # two folder icons are named after a vendor; a few svg files carry the export path of the artist's computer. None of that ships.
  find "$T/$n" -name '*folder-apple*' -delete
  find "$T/$n" -xtype l -delete
  sed -i -e "s|^Name=.*|Name=$n|" -e 's|^Comment=.*|Comment=Vitre base icon theme: the glyphs, folders and file types of MacTahoe-icon-theme by Vince Liuice (GPL-3.0), without its app icons.|' "$T/$n/index.theme"
  { grep -rlE 'inkscape:export-filename="/home/' "$T/$n" || true; } | while read -r f; do sed -i -E 's| inkscape:export-filename="/home/[^"]*"||' "$f"; done
  cp -a "$T/$n" "$D/usr/share/icons/$n"
done
mkdir -p "$D/usr/share/licenses/vitre-icons-base"
cp "$ICONS_SRC/COPYING" "$D/usr/share/licenses/vitre-icons-base/MacTahoe-icon-theme.COPYING"
[ ! -f "$ICONS_SRC/AUTHORS" ] || cp "$ICONS_SRC/AUTHORS" "$D/usr/share/licenses/vitre-icons-base/MacTahoe-icon-theme.AUTHORS"

say "vitre-cursor"
D="$S/vitre-cursor"
mkdir -p "$D/usr/share/icons" "$D/usr/share/licenses/vitre-cursor"
cp -a "$PKG/icons/Vitre-Cursor" "$D/usr/share/icons/Vitre-Cursor"
cp "$PKG/icons/Vitre-Cursor/LICENSE" "$D/usr/share/licenses/vitre-cursor/Vitre-Cursor.LICENSE"

say "vitre-backgrounds"
D="$S/vitre-backgrounds"
mkdir -p "$D/usr/share/backgrounds" "$D/usr/share/gnome-background-properties"
cp -a "$PKG/backgrounds/vitre" "$D/usr/share/backgrounds/vitre"
install -m 0644 "$C/vitre-backgrounds.xml" "$D/usr/share/gnome-background-properties/vitre.xml"

say "vitre-system (boot splash only: Fedora and Arch have no gdm-theme.gresource alternative, see distro/README.md)"
D="$S/vitre-system"
mkdir -p "$D/usr/share/plymouth/themes"
cp -a "$PKG/system/assets/plymouth/vitre" "$D/usr/share/plymouth/themes/vitre"

say "documents and licence text"
for p in "${PACKAGES[@]}"; do
  mkdir -p "$S/$p/usr/share/licenses/$p"
  cp "$PKG/LICENSE" "$S/$p/usr/share/licenses/$p/LICENSE"
done
mkdir -p "$S/vitre-desktop/usr/share/doc/vitre-desktop"
cp "$PKG/CREDITS.md" "$PKG/CHANGELOG.md" "$S/vitre-desktop/usr/share/doc/vitre-desktop/"

say "removing names, quoted feedback and internal ticket tags from comments of the files Vitre wrote (same pass as the .debs)"
python3 -I "$C/sanitize-staged.py" "$S"

say "normalising modes and mtimes"
for p in "$S"/*/; do
  find "$p" -type d -exec chmod 0755 {} +
  find "$p" -type f \( -perm -u+x \) -exec chmod 0755 {} +
  find "$p" -type f ! -perm -u+x -exec chmod 0644 {} +
  find "$p" -exec touch -h -d "@$EPOCH" {} +
done
echo "staged in $S"

#!/bin/bash
# Vitre login screen and boot splash. Optional: this is the only part of Vitre that needs root.
#   ./system/install-system.sh --check      look at your system, change nothing (no root needed)
#   sudo ./system/install-system.sh         install (asks you to type yes first; --yes skips the question)
# It registers both themes with update-alternatives at a higher priority than Ubuntu's, so the undo is one command:
#   sudo ./system/uninstall-system.sh       (works from a text console too: Ctrl+Alt+F3)
# If any step fails, the install puts everything back by itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GDM_SRC="$HERE/assets/gdm/vitre-gdm-theme.gresource"
PLY_SRC="$HERE/assets/plymouth/vitre"
GDM_DIR=/usr/share/gnome-shell/theme/Vitre
GDM_DST="$GDM_DIR/gnome-shell-theme.gresource"
GDM_LINK=/usr/share/gnome-shell/gdm-theme.gresource
PLY_DST=/usr/share/plymouth/themes/vitre
PLY_LINK=/usr/share/plymouth/themes/default.plymouth

CHECK_ONLY=0; YES=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    --yes) YES=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'vitre: %s\n' "$*" >&2; exit 1; }

# ---- 1. check -------------------------------------------------------------------------------------------------------
test -s "$GDM_SRC" || fail "missing $GDM_SRC (run this from the vitre folder you downloaded)"
test -s "$PLY_SRC/vitre.plymouth" && test -s "$PLY_SRC/vitre.script" || fail "missing the splash files in $PLY_SRC"
command -v update-alternatives >/dev/null || fail "update-alternatives not found: this installer supports Ubuntu and Debian based systems"
command -v update-initramfs >/dev/null || fail "update-initramfs not found: this installer supports Ubuntu and Debian based systems"
update-alternatives --query gdm-theme.gresource >/dev/null 2>&1 || fail "this system has no gdm-theme.gresource alternative (Ubuntu's login screen); nothing to replace"
test -d /usr/share/plymouth/themes || fail "Plymouth is not installed (no /usr/share/plymouth/themes)"
SHELL_MAJOR="$(gnome-shell --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/' || true)"
if [ "$SHELL_MAJOR" != "51" ] && [ "$FORCE" -ne 1 ]; then
  fail "the login theme is built for GNOME Shell 51; this system has '${SHELL_MAJOR:-none}'. A theme for another version can break the login screen. (--force to try anyway)"
fi
echo "== check"
echo "   GNOME Shell     : $SHELL_MAJOR"
echo "   login theme now : $(readlink -f "$GDM_LINK")"
echo "   splash now      : $(readlink -f "$PLY_LINK")"
echo "   will install    : login theme ($(stat -c %s "$GDM_SRC") bytes) and boot splash ($(ls "$PLY_SRC" | wc -l) files)"
[ "$CHECK_ONLY" -eq 1 ] && { echo "== check only: nothing changed"; exit 0; }

# ---- 2. ask ---------------------------------------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || fail "run this with sudo (or use --check, which needs no root)"
if [ "$YES" -ne 1 ]; then
  echo
  echo "This changes the login screen and the boot splash for every user of this computer and rebuilds the initramfs (takes a minute)."
  echo "The undo is: sudo $HERE/uninstall-system.sh   (also works from a text console, Ctrl+Alt+F3)"
  read -r -p "Type yes to continue: " ans
  [ "$ans" = "yes" ] || fail "cancelled, nothing changed"
fi

# ---- 3. backup and install, with rollback ----------------------------------------------------------------------------
B=/var/backups/vitre-system-$(date +%Y%m%d-%H%M%S)
mkdir -p "$B"
{ update-alternatives --query gdm-theme.gresource; echo; update-alternatives --query default.plymouth; } > "$B/alternatives-before.txt" 2>&1 || true
{ echo "login: $(readlink -f "$GDM_LINK")"; echo "splash: $(readlink -f "$PLY_LINK")"; } > "$B/previous.txt"

ROLLBACK=1
rollback() {
  [ "$ROLLBACK" -eq 1 ] || return 0
  echo "vitre: a step failed, putting everything back" >&2
  update-alternatives --remove gdm-theme.gresource "$GDM_DST" >/dev/null 2>&1 || true
  update-alternatives --auto gdm-theme.gresource >/dev/null 2>&1 || true
  update-alternatives --remove default.plymouth "$PLY_DST/vitre.plymouth" >/dev/null 2>&1 || true
  update-alternatives --auto default.plymouth >/dev/null 2>&1 || true
  rm -rf "$GDM_DIR" "$PLY_DST"
  update-initramfs -u >/dev/null 2>&1 || true
  echo "vitre: restored. login: $(readlink -f "$GDM_LINK")  splash: $(readlink -f "$PLY_LINK")" >&2
}
trap rollback EXIT

say "login screen"
install -D -m 0644 "$GDM_SRC" "$GDM_DST"
update-alternatives --install "$GDM_LINK" gdm-theme.gresource "$GDM_DST" 20
update-alternatives --set gdm-theme.gresource "$GDM_DST"
echo "   login theme: $(readlink -f "$GDM_LINK")"

say "boot splash"
install -d -m 0755 "$PLY_DST"
install -m 0644 "$PLY_SRC"/* "$PLY_DST"/
update-alternatives --install "$PLY_LINK" default.plymouth "$PLY_DST/vitre.plymouth" 200
update-alternatives --set default.plymouth "$PLY_DST/vitre.plymouth"
echo "   splash: $(readlink -f "$PLY_LINK")"

say "rebuilding the initramfs (the splash lives there; takes a minute)"
update-initramfs -u

ROLLBACK=0
trap - EXIT
say "done"
echo "The login screen shows the next time you sign out; the splash at the next boot."
echo "A copy of what was set before is in $B"
echo "Undo: sudo $HERE/uninstall-system.sh"

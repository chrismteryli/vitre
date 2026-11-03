#!/bin/bash
# sync-common.sh [--check|--copy]
# The session files of the Fedora and Arch packages are the same files the .debs use (release/native in the author's workspace, read only;
# the repository does not carry it). This copies them, under flat names, into common/, which both vitre.spec and the PKGBUILD list as local
# sources (the PKGBUILD cannot reach outside its own folder on the AUR, so fedora/ and arch/ each get a copy of common/ with  ./sync-common.sh --copy).
#   ./sync-common.sh            refresh common/ from release/native (needs it: VITRE_NATIVE=<path to release/native> if it is not found)
#   ./sync-common.sh --check    exit 1 when common/ is out of date with release/native, or fedora/ and arch/ differ from common/
#                               (without release/native only the second part runs, and it says so)
#   ./sync-common.sh --copy     refresh common/ when release/native is there, then copy the whole common/ set into fedora/ and arch/
# Files written for these packagings (not copied from native): vitre-stage.sh, make-mode.py, make-parity.py, session-extensions.txt, README.vitre-session.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C="$HERE/common"
MODE="${1:-sync}"
# release/native: from VITRE_NATIVE, else beside release/distro, release/vitre/packaging or release/src/repo/packaging
N="${VITRE_NATIVE:-}"
if [ -z "$N" ]; then
  for c in "$HERE/../native" "$HERE/../../native" "$HERE/../../../native"; do
    [ -f "$c/session/usr/bin/vitre-session" ] && { N="$(cd "$c" && pwd)"; break; }
  done
fi
[ -z "$N" ] || [ -f "$N/session/usr/bin/vitre-session" ] || { echo "VITRE_NATIVE ($N) is not release/native (session/usr/bin/vitre-session missing)" >&2; exit 2; }
# destination name : source in release/native
MAP=(
  "vitre-session:session/usr/bin/vitre-session"
  "vitre.session:session/usr/share/gnome-session/sessions/vitre.session"
  "vitre.desktop:session/usr/share/wayland-sessions/vitre.desktop"
  "vitre.session.conf:session/usr/lib/systemd/user/gnome-session@vitre.target.d/vitre.session.conf"
  "vitre-user-setup:session/vitre-user-setup"
  "vitre-user-setup.service:session/vitre-user-setup.service"
  "vitre-mode.json.in:session/vitre-mode.json.in"
  "dconf-profile-vitre:defaults/etc/dconf/profile/vitre"
  "vitre-backgrounds.xml:backgrounds/usr/share/gnome-background-properties/vitre.xml"
  "make-defaults.py:tools/make-defaults.py"
  "sanitize-staged.py:tools/sanitize-staged.py"
  "10-ubuntu-parity:defaults/etc/dconf/db/vitre.d/10-ubuntu-parity"
)
AUTHORED=(vitre-stage.sh make-mode.py make-parity.py session-extensions.txt README.vitre-session)
rc=0
case "$MODE" in
  sync|--copy)
    if [ -n "$N" ]; then
      mkdir -p "$C"
      for m in "${MAP[@]}"; do cp -p "$N/${m#*:}" "$C/${m%%:*}"; done
    elif [ "$MODE" = sync ]; then
      echo "release/native was not found, so there is nothing to refresh common/ from (set VITRE_NATIVE, or use --copy to only copy common/ into fedora/ and arch/)" >&2
      exit 2
    else
      echo "release/native not found: common/ is copied as it is"
    fi ;;
  --check)
    if [ -n "$N" ]; then
      for m in "${MAP[@]}"; do
        cmp -s "$N/${m#*:}" "$C/${m%%:*}" || { echo "out of date: common/${m%%:*} (release/native/${m#*:})"; rc=1; }
      done
    else
      echo "release/native not found: common/ is not compared with it (only fedora/ and arch/ against common/)"
    fi ;;
  *) echo "usage: $0 [--check|--copy]" >&2; exit 2 ;;
esac
FILES=(); for m in "${MAP[@]}"; do FILES+=("${m%%:*}"); done; FILES+=("${AUTHORED[@]}")
for f in "${FILES[@]}"; do [ -f "$C/$f" ] || { echo "missing: common/$f"; rc=1; }; done
for d in fedora arch; do
  case "$MODE" in
    --copy) for f in "${FILES[@]}"; do cp -p "$C/$f" "$HERE/$d/$f"; done ;;
    --check) for f in "${FILES[@]}"; do cmp -s "$C/$f" "$HERE/$d/$f" || { echo "differs: $d/$f"; rc=1; }; done ;;
  esac
done
[ "$rc" -eq 0 ] && echo "ok" || exit "$rc"

#!/usr/bin/env bash
# Prints what a bug report needs: GNOME version, distro, CPU, session, Vitre's extensions and their last log lines.
# Changes nothing. Usage: ./vitre-info.sh
set -u
echo "Vitre:      $(cat "$(dirname "${BASH_SOURCE[0]}")/VERSION" 2>/dev/null || echo unknown)"
echo "GNOME:      $(gnome-shell --version 2>/dev/null || echo 'gnome-shell not found')"
echo "Distro:     $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
echo "Kernel:     $(uname -sr)  $(uname -m)"
echo "Session:    ${XDG_SESSION_TYPE:-unknown}"
echo "Animations: enable-animations=$(gsettings get org.gnome.desktop.interface enable-animations 2>/dev/null)"
echo
echo "Vitre extensions:"
for u in $(gnome-extensions list 2>/dev/null | grep -E '^vitre-'); do
  printf '  %-45s %s\n' "$u" "$(gnome-extensions info "$u" 2>/dev/null | sed -n 's/^ *State: //p' | head -1)"
done
echo
echo "Last Vitre lines from this session's log:"
journalctl --user -b -o cat 2>/dev/null | grep -iE 'vitre|JS ERROR' | tail -30 || true

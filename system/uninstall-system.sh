#!/bin/bash
# Puts Ubuntu's login screen and boot splash back. Run with sudo. Works from a text console (Ctrl+Alt+F3) too.
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "vitre: run this with sudo" >&2; exit 1; }
GDM_DST=/usr/share/gnome-shell/theme/Vitre/gnome-shell-theme.gresource
PLY_DST=/usr/share/plymouth/themes/vitre
update-alternatives --remove gdm-theme.gresource "$GDM_DST" || true
update-alternatives --auto gdm-theme.gresource || true
update-alternatives --remove default.plymouth "$PLY_DST/vitre.plymouth" || true
update-alternatives --auto default.plymouth || true
rm -rf /usr/share/gnome-shell/theme/Vitre "$PLY_DST"
update-initramfs -u -k all
echo "login theme: $(readlink -f /usr/share/gnome-shell/gdm-theme.gresource)"
echo "splash: $(readlink -f /usr/share/plymouth/themes/default.plymouth)"
echo "Done. Sign out for the login screen, reboot for the splash."

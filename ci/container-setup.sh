#!/usr/bin/env bash
# Runs as root INSIDE the ubuntu:26.10 container (ci/in-container.sh runs it): installs GNOME Shell 51 and the tools the install and smoke
# tests need, creates the normal user the tests run as (install.sh refuses root), and fetches the base icon theme install.sh needs.
#
# Why each package group is there (Ubuntu 26.10 package names; apt installs with --no-install-recommends):
#   gnome-shell gjs                       the shell under test (pulls mutter 51, gnome-extensions, gsettings-desktop-schemas, ...)
#   mesa-libgallium libgl1-mesa-dri libegl-mesa0 librsvg2-common adwaita-icon-theme
#                                         software rendering (llvmpipe) for the shell on a runner without a GPU; SVG icons
#   dbus-daemon dbus-bin                  dbus-run-session (a private session bus) and dbus-send tools
#   dconf-cli dconf-service dconf-gsettings-backend libglib2.0-bin
#                                         the real dconf behind gsettings (the installer reads and writes settings); glib-compile-schemas, gdbus
#   gvfs gvfs-daemons                     the trash backend: Vitre Dock watches trash:/// while it starts
#   python3 curl ca-certificates tar gzip fontconfig fonts-inter fonts-jetbrains-mono gtk-update-icon-cache
#                                         what install.sh itself uses, and the fonts it looks for
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
SRC="${VITRE_REPO:-/src}"

retry() {   # retry COMMAND...  (the Ubuntu mirrors fail now and then)
  local n
  for n in 1 2 3; do
    "$@" && return 0
    echo "setup: '$*' failed (attempt $n of 3)" >&2
    sleep $((n * 10))
  done
  return 1
}

echo "== $(. /etc/os-release && echo "$PRETTY_NAME"), $(uname -m)"
retry apt-get update -qq
retry apt-get install -y -qq --no-install-recommends \
  gnome-shell gjs \
  mesa-libgallium libgl1-mesa-dri libegl-mesa0 librsvg2-common adwaita-icon-theme \
  dbus-daemon dbus-bin \
  dconf-cli dconf-service dconf-gsettings-backend libglib2.0-bin \
  gvfs gvfs-daemons \
  python3 curl ca-certificates tar gzip fontconfig fonts-inter fonts-jetbrains-mono gtk-update-icon-cache \
  > /tmp/apt-install.log 2>&1 || { tail -30 /tmp/apt-install.log; exit 1; }
tail -2 /tmp/apt-install.log

for c in gnome-shell gnome-extensions dbus-run-session dconf gsettings gdbus glib-compile-schemas python3 curl fc-list; do
  command -v "$c" >/dev/null || { echo "setup: $c is missing after the install" >&2; exit 1; }
done
echo "== $(gnome-shell --version), mutter $(dpkg-query -W -f='${Version}' libmutter-51-0 2>/dev/null || echo '?'), mesa $(dpkg-query -W -f='${Version}' mesa-libgallium)"

# the user the tests run as
id vitre >/dev/null 2>&1 || useradd --create-home --shell /bin/bash vitre
mkdir -p /out && chmod 777 /out

# The base icon theme install.sh downloads (MacTahoe-icon-theme at a pinned commit). It is fetched here, with retries, so a hiccup on
# github.com does not fail the install test; install.sh then uses it through VITRE_ICONS_SRC. The pin is read from install.sh itself.
REF="$(sed -n 's/^MACTAHOE_ICONS_REF="\([0-9a-f]\{7,40\}\)".*/\1/p' "$SRC/install.sh" | head -1)"
URL="$(sed -n 's/^MACTAHOE_ICONS_URL="\(.*\)"/\1/p' "$SRC/install.sh" | head -1 | sed "s|\$MACTAHOE_ICONS_REF|$REF|")"
rm -rf /opt/mactahoe; mkdir -p /opt/mactahoe
if [ -n "$REF" ] && [ -n "$URL" ]; then
  echo "== icon theme: $URL"
  retry sh -c "curl -fsSL --connect-timeout 20 '$URL' | tar -xz -C /opt/mactahoe"
  ln -s /opt/mactahoe/MacTahoe-icon-theme-"$REF" /opt/mactahoe/src
  chown -R vitre:vitre /opt/mactahoe
  [ -x /opt/mactahoe/src/install.sh ] || { echo "setup: the icon theme download has no install.sh" >&2; exit 1; }
else
  echo "setup: could not read MACTAHOE_ICONS_REF/URL from install.sh; the tests will let install.sh download the icon theme itself" >&2
fi
echo "== setup done"

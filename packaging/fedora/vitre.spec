# Vitre 0.2.0 for Fedora (COPR). Written 2026-10-22; NOT built on Fedora yet (see README.md, "Not tested").
#
# One source package, ten binary packages: the same split as the .debs.
#   vitre-desktop         meta package: everything below except vitre-system (recommended)
#   vitre-session         the "Vitre" entry at the login screen: shell session mode, Wayland session, gnome-session definition,
#                         dconf defaults that only that session reads, per-user GTK step
#   vitre-shell           the vitre-* GNOME Shell extensions
#   vitre-shell-extras    Vitre Dock and the third-party extensions Vitre uses
#   vitre-theme           Vitre-Glass (GTK 3, GTK 4, window frame, shell) and the GTK stylesheets of the per-user step
#   vitre-icons           the Vitre icon theme
#   vitre-icons-base      VitreBase: MacTahoe-icon-theme without its app icons, built from the pinned ref (no download at install)
#   vitre-cursor          the Vitre cursor set
#   vitre-backgrounds     the wallpapers
#   vitre-system          optional: the Vitre boot splash (the login screen theme is not possible here, see README.md)
#
# All files are laid out by vitre-stage.sh (Source10), which the Arch PKGBUILD runs as well. Nothing is compiled and nothing is
# downloaded at build or install time: Source0 and Source1 are the only network inputs, and COPR/mock fetch them before the build.

%global mactahoe_commit 839848b9a8a38a92a6936e30c4abe35cc6f2546d

# nothing is compiled: no ELF files, no debuginfo
%global debug_package %{nil}

Name:           vitre
Version:        0.2.0
Release:        1%{?dist}
Summary:        Vitre glass desktop for GNOME Shell
# the whole source package; every binary package below carries its own, narrower License tag
License:        GPL-3.0-only AND GPL-3.0-or-later AND GPL-2.0-or-later AND LGPL-2.1-or-later AND MIT
URL:            https://github.com/chrismteryli/vitre
Source0:        %{url}/archive/v%{version}/%{name}-%{version}.tar.gz
# the base icon theme, at the exact ref that install.sh pins (tag 2026-09-10)
Source1:        https://github.com/vinceliuice/MacTahoe-icon-theme/archive/%{mactahoe_commit}/MacTahoe-icon-theme-%{mactahoe_commit}.tar.gz
# session files, copied from the .debs' sources by packaging/sync-common.sh (keep them identical across fedora/ and arch/)
Source10:       vitre-stage.sh
Source11:       make-mode.py
Source12:       make-defaults.py
Source13:       sanitize-staged.py
Source14:       session-extensions.txt
Source15:       vitre-mode.json.in
Source16:       vitre-session
Source17:       vitre.session
Source18:       vitre.desktop
Source19:       vitre.session.conf
Source20:       vitre-user-setup
Source21:       vitre-user-setup.service
Source22:       dconf-profile-vitre
Source23:       vitre-backgrounds.xml
Source24:       README.vitre-session
Source25:       10-ubuntu-parity
Source26:       make-parity.py

BuildArch:      noarch
BuildRequires:  python3
# glib-compile-schemas (compiles the settings schemas of each extension, as install.sh does on the user's machine)
BuildRequires:  glib2

%description
Vitre is a glass desktop for GNOME Shell: GNOME Shell extensions, a theme, icons, a
cursor and wallpapers that work together. Most of the work went into how things
move: menus, windows, swipes and dialogs.

This source package builds the Vitre session for Fedora. Install vitre-desktop,
sign out, click the gear icon on the login screen and pick Vitre.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-desktop
Summary:        Vitre glass desktop for GNOME (meta package)
License:        GPL-3.0-only
Requires:       vitre-session = %{version}-%{release}
Requires:       vitre-shell = %{version}-%{release}
Requires:       vitre-shell-extras = %{version}-%{release}
Requires:       vitre-theme = %{version}-%{release}
Requires:       vitre-icons = %{version}-%{release}
Requires:       vitre-icons-base = %{version}-%{release}
Requires:       vitre-cursor = %{version}-%{release}
Requires:       vitre-backgrounds = %{version}-%{release}
Requires:       gnome-shell >= 51
Requires:       gnome-shell < 52~
Requires:       gnome-session
Requires:       rsms-inter-fonts
Requires:       jetbrains-mono-fonts
Recommends:     vitre-system = %{version}-%{release}

%description -n vitre-desktop
Installs the Vitre session and everything it uses: the shell extensions, the theme,
the icons, the cursor and the wallpapers. After installing, pick "Vitre" in the
session menu on the login screen. Your normal GNOME session stays installed and
stays selectable.

The Vitre boot splash (vitre-system) is recommended but optional: it changes the
boot splash for every user of the machine. dnf installs recommended packages unless
told not to (--setopt=install_weak_deps=False).

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-session
Summary:        Vitre session for GNOME Shell
License:        GPL-3.0-only
Requires:       gnome-shell >= 51
Requires:       gnome-shell < 52~
Requires:       gnome-session
Requires:       gnome-session-wayland-session
Requires:       dconf
Requires:       gnome-shell-extension-user-theme
Requires:       vitre-theme = %{version}-%{release}
Recommends:     vitre-shell = %{version}-%{release}
Recommends:     vitre-shell-extras = %{version}-%{release}
Recommends:     vitre-icons = %{version}-%{release}
Recommends:     vitre-cursor = %{version}-%{release}
Recommends:     vitre-backgrounds = %{version}-%{release}
Recommends:     gnome-shell-extension-appindicator
Suggests:       vitre-desktop = %{version}-%{release}
Suggests:       vitre-system = %{version}-%{release}

%description -n vitre-session
Adds a "Vitre" entry to the login screen: a GNOME Shell session mode (the
extensions to load), a Wayland session, the gnome-session definition, and system
defaults that only the Vitre session reads (a dconf database behind
DCONF_PROFILE=vitre). The mode also keeps the tray icon and tiling extensions of
the distribution where they are installed.

What reaches your normal GNOME session: at the first Vitre login a per-user step
links the Vitre GTK stylesheets into ~/.config/gtk-3.0 and ~/.config/gtk-4.0 (only
where no file of that name exists). GTK applications read those folders in every
session, so from then on GTK 3 and GTK 4 applications show the Vitre style in your
normal session too, until the links are removed with
/usr/lib/vitre/vitre-user-setup --remove. Settings changed while in the Vitre
session are saved in your own account, which both sessions read; the Vitre defaults
themselves never reach the other session.

Without the recommended packages the session starts, but the Vitre extensions,
icons, cursor and wallpapers it names are missing.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-shell
Summary:        Vitre GNOME Shell extensions
License:        GPL-3.0-only
Requires:       gnome-shell >= 51
Requires:       gnome-shell < 52~
Recommends:     vitre-shell-extras = %{version}-%{release}

%description -n vitre-shell
The vitre-* GNOME Shell extensions: Stage, banners, window motion, workspace motion,
menus, controls, notices, search, switcher, swipe gestures, the fullscreen corner,
session dialogs and the rest of the Vitre desktop. They are installed in
/usr/share/gnome-shell/extensions and are switched on by the Vitre session.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-shell-extras
Summary:        Dock and third-party GNOME Shell extensions used by Vitre
License:        GPL-3.0-only AND GPL-3.0-or-later AND GPL-2.0-or-later AND MIT
Requires:       gnome-shell >= 51
Requires:       gnome-shell < 52~

%description -n vitre-shell-extras
Vitre Dock (a fork of Dhruva with Vitre's changes, under its own name), Blur my
Shell, Just Perfection, Rounded Window Corners Reborn, Liquid Glass and Logo Menu,
each with its own licence file. They are installed in
/usr/share/gnome-shell/extensions and are switched on by the Vitre session.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-theme
Summary:        Vitre glass theme (GTK 3, GTK 4, window frame and shell)
License:        MIT AND GPL-3.0-only AND GPL-3.0-or-later AND LGPL-2.1-or-later
Recommends:     gnome-shell >= 51
Recommends:     rsms-inter-fonts

%description -n vitre-theme
The Vitre-Glass theme for GTK 3, GTK 4, the window frame and GNOME Shell, and the
GTK stylesheets that the Vitre session links into the user's config folder.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-icons
Summary:        Vitre icon theme
License:        GPL-3.0-only
Requires:       vitre-icons-base = %{version}-%{release}
Requires:       hicolor-icon-theme

%description -n vitre-icons
Original Vitre app icons. Everything it does not draw comes from the base theme in
vitre-icons-base. Also installs the Vitre glyph and logo used by the Logo Menu.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-icons-base
Summary:        Vitre base icon theme (VitreBase)
License:        GPL-3.0-only

%description -n vitre-icons-base
The glyphs, folders and file types of MacTahoe-icon-theme (GPL-3.0, Vince Liuice),
built from a pinned release as VitreBase, VitreBase-dark and VitreBase-light,
without that theme's app icons.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-cursor
Summary:        Vitre cursor theme
License:        GPL-3.0-only
Recommends:     adwaita-icon-theme

%description -n vitre-cursor
The Vitre glass drop pointer set with the glass ring busy spinner. Cursors it does
not draw come from Adwaita.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-backgrounds
Summary:        Vitre wallpapers
License:        GPL-3.0-only

%description -n vitre-backgrounds
The Vitre wallpapers (Drift, Caustic and Pane, each in a light and a dark version),
listed in the Settings background chooser.

# ---------------------------------------------------------------------------------------------------------------------------------
%package -n vitre-system
Summary:        Vitre boot splash (optional)
License:        GPL-3.0-only
Requires:       plymouth
Requires:       plymouth-scripts
Requires:       plymouth-plugin-script
Requires:       dracut

%description -n vitre-system
The Vitre boot splash. Installing it makes Vitre the default Plymouth theme and
rebuilds the initramfs (dracut) so the splash shows at the next boot; removing it
puts the previous theme back and rebuilds again.

This changes the boot splash for every user of the machine.

The .deb of the same name also carries the Vitre login screen theme. Fedora has no
way to select a login screen theme from a package (the Ubuntu gdm-theme.gresource
alternative does not exist here), so that part is not included.

# =================================================================================================================================
%prep
%autosetup -n %{name}-%{version} -a 1

%build
export VITRE_SRC="$PWD"
export VITRE_COMMON="%{_sourcedir}"
export MACTAHOE_SRC="$PWD/MacTahoe-icon-theme-%{mactahoe_commit}"
bash "%{_sourcedir}/vitre-stage.sh" "$PWD/stage"

%install
mkdir -p %{buildroot}
for p in stage/*/; do
  cp -a "${p}." %{buildroot}/
done
# the extension folders are chosen by vitre-stage.sh from the extensions folder of the source, so the lists of the two extension
# packages are made from what it staged instead of being written out here
for p in vitre-shell vitre-shell-extras; do
  ls -1 "stage/$p/usr/share/gnome-shell/extensions" | sed "s|^|%{_datadir}/gnome-shell/extensions/|" > "$p.files"
done

# ---------------------------------------------------------------------------------------------------------------------------------
%files -n vitre-desktop
%license %{_defaultlicensedir}/vitre-desktop
%{_docdir}/vitre-desktop

%files -n vitre-session
%license %{_defaultlicensedir}/vitre-session
%{_docdir}/vitre-session
%{_bindir}/vitre-session
%{_prefix}/lib/vitre/
%{_prefix}/lib/systemd/user/vitre-user-setup.service
%{_prefix}/lib/systemd/user/gnome-session@vitre.target.d/
%{_datadir}/gnome-session/sessions/vitre.session
%{_datadir}/wayland-sessions/vitre.desktop
%{_datadir}/gnome-shell/modes/vitre.json
%config(noreplace) %{_sysconfdir}/dconf/profile/vitre
%dir %{_sysconfdir}/dconf/db/vitre.d
%config(noreplace) %{_sysconfdir}/dconf/db/vitre.d/00-vitre
%config(noreplace) %{_sysconfdir}/dconf/db/vitre.d/10-gnome-parity
# the compiled database: made by "dconf update" in %%post, removed again with the package
%ghost %{_sysconfdir}/dconf/db/vitre

%files -n vitre-shell -f vitre-shell.files
%license %{_defaultlicensedir}/vitre-shell

%files -n vitre-shell-extras -f vitre-shell-extras.files
%license %{_defaultlicensedir}/vitre-shell-extras

%files -n vitre-theme
%license %{_defaultlicensedir}/vitre-theme
%{_datadir}/themes/Vitre-Glass/
%{_datadir}/vitre/

%files -n vitre-icons
%license %{_defaultlicensedir}/vitre-icons
%{_datadir}/icons/Vitre-Icons/
%ghost %{_datadir}/icons/Vitre-Icons/icon-theme.cache
%{_datadir}/icons/hicolor/scalable/apps/vitre-glyph-symbolic.svg
%{_datadir}/icons/hicolor/scalable/apps/vitre-logo.svg

%files -n vitre-icons-base
%license %{_defaultlicensedir}/vitre-icons-base
%{_datadir}/icons/VitreBase/
%{_datadir}/icons/VitreBase-dark/
%{_datadir}/icons/VitreBase-light/
%ghost %{_datadir}/icons/VitreBase/icon-theme.cache
%ghost %{_datadir}/icons/VitreBase-dark/icon-theme.cache
%ghost %{_datadir}/icons/VitreBase-light/icon-theme.cache

%files -n vitre-cursor
%license %{_defaultlicensedir}/vitre-cursor
%{_datadir}/icons/Vitre-Cursor/

%files -n vitre-backgrounds
%license %{_defaultlicensedir}/vitre-backgrounds
# /usr/share/backgrounds and gnome-background-properties are shared with gnome-backgrounds; owning them twice is harmless
%dir %{_datadir}/backgrounds
%{_datadir}/backgrounds/vitre/
%dir %{_datadir}/gnome-background-properties
%{_datadir}/gnome-background-properties/vitre.xml

%files -n vitre-system
%license %{_defaultlicensedir}/vitre-system
%{_datadir}/plymouth/themes/vitre/

# ---------------------------------------------------------------------------------------------------------------------------------
%post -n vitre-session
# /etc/dconf/profile/vitre reads the machine-wide "local" and "site" databases above the Vitre defaults, so that an administrator's
# settings win over Vitre's. dconf prints a warning in every program of the session when a database named in the profile does not
# exist. Create an empty folder with a note for each one that is missing (the folder AND the database: an existing database of the
# administrator is never touched); "dconf update" below then compiles it into an empty database.
db=/etc/dconf/db
for name in local site; do
  if [ ! -e "$db/$name" ] && [ ! -e "$db/$name.d" ]; then
    mkdir -p "$db/$name.d"
    cat > "$db/$name.d/README.vitre" <<NOTE
# This folder was created empty by the vitre-session package. /etc/dconf/profile/vitre reads the "$name" database above the Vitre
# defaults, so machine-wide settings put here win over Vitre's: add keyfiles to this folder and run "dconf update".
# When vitre-session is removed, this folder is removed again only if this note is still the only thing in it.
NOTE
  fi
done
# compiles /etc/dconf/db/*.d, among them the Vitre defaults (vitre.d) into the database "vitre". Only sessions that start with
# DCONF_PROFILE=vitre (the Vitre session, through /usr/bin/vitre-session) read it.
if command -v dconf >/dev/null 2>&1; then
  dconf update || :
else
  echo "vitre-session: dconf is not installed; run 'dconf update' once it is" >&2
fi
exit 0

%postun -n vitre-session
if [ "$1" -eq 0 ]; then
  rm -f /etc/dconf/db/vitre
  # the empty admin databases the %%post made, only while its note is still the only file in the folder
  for name in local site; do
    d="/etc/dconf/db/$name.d"
    if [ -f "$d/README.vitre" ] && [ "$(ls -A "$d")" = "README.vitre" ]; then
      rm -f "$d/README.vitre"
      rmdir "$d" || :
      rm -f "/etc/dconf/db/$name"
    fi
  done
fi
exit 0

%post -n vitre-icons
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/Vitre-Icons || :
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :
fi
exit 0

%postun -n vitre-icons
if [ "$1" -eq 0 ] && command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :
fi
exit 0

%post -n vitre-icons-base
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  for t in VitreBase VitreBase-dark VitreBase-light; do
    gtk-update-icon-cache -q -t -f "/usr/share/icons/$t" || :
  done
fi
exit 0

%post -n vitre-system
# plymouth-set-default-theme -R runs dracut: the splash lives in the initramfs. Nothing here can fail the transaction.
if command -v plymouth-set-default-theme >/dev/null 2>&1; then
  if [ "$1" -eq 1 ]; then
    # first install: remember the splash that was selected, then make Vitre the default Plymouth theme
    mkdir -p /var/lib/vitre
    plymouth-set-default-theme 2>/dev/null > /var/lib/vitre/plymouth-previous-theme || :
    plymouth-set-default-theme -R vitre || echo "vitre-system: could not select the Vitre splash; run 'plymouth-set-default-theme -R vitre'" >&2
  elif [ "$(plymouth-set-default-theme 2>/dev/null || :)" = "vitre" ]; then
    # upgrade while Vitre is the selected splash: the splash files changed, so rebuild the initramfs
    plymouth-set-default-theme -R vitre || :
  fi
fi
exit 0

%preun -n vitre-system
# Last version going away: select the previous splash again (while the Vitre files still exist) and rebuild the initramfs without it.
if [ "$1" -eq 0 ] && command -v plymouth-set-default-theme >/dev/null 2>&1; then
  prev=""
  [ -f /var/lib/vitre/plymouth-previous-theme ] && prev="$(sed -n 1p /var/lib/vitre/plymouth-previous-theme)"
  current="$(plymouth-set-default-theme 2>/dev/null || :)"
  # only when Vitre is still the selected splash: a choice the administrator made since then is left alone
  if [ "$current" = "vitre" ]; then
    if [ -n "$prev" ] && [ "$prev" != "vitre" ] && [ -d "/usr/share/plymouth/themes/$prev" ]; then
      plymouth-set-default-theme -R "$prev" || :
    else
      plymouth-set-default-theme --reset -R || :
    fi
  fi
  rm -f /var/lib/vitre/plymouth-previous-theme
  rmdir /var/lib/vitre 2>/dev/null || :
fi
exit 0

%changelog
* Thu Oct 22 2026 Vitre <noreply@github.com> - 0.2.0-1
- Fedora packages for Vitre 0.2.0, the same ten-package split as the Debian packages: session, shell extensions, Dock and third-party
  extensions, theme, icons, base icon theme, cursor, wallpapers and the optional boot splash.
- Not built on Fedora yet.

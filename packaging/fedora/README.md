# Vitre for Fedora (COPR)

`vitre.spec` builds ten noarch packages from one source package, the same split as the `.deb`s: `vitre-desktop` (meta), `vitre-session`,
`vitre-shell`, `vitre-shell-extras`, `vitre-theme`, `vitre-icons`, `vitre-icons-base`, `vitre-cursor`, `vitre-backgrounds` and the optional
`vitre-system` (boot splash only). There is no binary package called `vitre`. The overview, the differences from the `.deb`s and the checks
that were run are in `../README.md`. Never built on Fedora yet.

## Which Fedora has GNOME 51

Checked read only on 2026-10-22 (Bodhi, Fedora schedule):

| Fedora | gnome-shell | state |
|---|---|---|
| Rawhide (F46) | 51.1-1 (stable since 2026-10-14) | **builds and installs today** (`fedora-rawhide-*` chroots) |
| **Fedora 45** | 51~beta-4 in stable, 51.1 in updates-testing | **first release with GNOME 51**, not out yet: beta was 2026-09-15, final target **2026-11-03** (fallback 2026-11-10) |
| Fedora 44 | 50.6 | released, GNOME 50: the packages require `gnome-shell >= 51`, so they build but do not install |
| Fedora 43 | 49.10 | same |

So no released Fedora ships GNOME 51 yet. Build for the `fedora-rawhide` chroots now and add `fedora-45` once it is out (x86_64 and
aarch64; the packages are noarch). Do not enable the F44/F43 chroots.

## Build

Sources: `Source0` is the GitHub archive of the tag `v0.2.0` (published),
`Source1` is MacTahoe-icon-theme at ref `839848b9...` (same ref as `install.sh`), `Source10` to `Source26` are the files beside the spec.

    cd packaging/fedora
    spectool -g vitre.spec                         # fetches Source0 and Source1 next to the spec (rpmdevtools)
    mkdir -p out
    rpmbuild -bs --define "_sourcedir $PWD" --define "_srcrpmdir $PWD/out" vitre.spec
    mock -r fedora-rawhide-x86_64 --rebuild out/vitre-0.2.0-1.*.src.rpm       # or fedora-45-x86_64, fedora-rawhide-aarch64 ...

Without mock: `rpmbuild -bb --define "_sourcedir $PWD" vitre.spec` (BuildRequires: `python3`, `glib2`). The result is ten
`vitre-*-0.2.0-1.*.noarch.rpm`. Install the whole desktop with `sudo dnf install ./vitre-*.rpm` (or `vitre-desktop` from the COPR), sign
out, click the gear on the login screen, pick Vitre.

To build from local checkouts instead of GitHub, make the two tarballs from them (the file names are what the spec expects, so `spectool`
has nothing to fetch):

    git -C ../.. archive --prefix=vitre-0.2.0/ -o "$PWD/vitre-0.2.0.tar.gz" v0.2.0
    git -C /path/to/MacTahoe-icon-theme archive --prefix=MacTahoe-icon-theme-839848b9a8a38a92a6936e30c4abe35cc6f2546d/ \
        -o "$PWD/MacTahoe-icon-theme-839848b9a8a38a92a6936e30c4abe35cc6f2546d.tar.gz" 839848b9a8a38a92a6936e30c4abe35cc6f2546d

(Delete them again afterwards; they are not part of the recipe.)

## COPR

Not created. When it is (needs a Fedora account and the author's go-ahead): create the project, enable the chroots above, upload the SRPM
from the step above with `copr-cli build <owner>/<project> out/vitre-0.2.0-1.*.src.rpm`, or in the web form use "Upload" with the same
file. `Recommends:` is used for the optional parts (`vitre-system` from `vitre-desktop`, the extension packages from `vitre-session`), so
`dnf install vitre-desktop` brings the boot splash too; `--setopt=install_weak_deps=False` leaves it out.

## Not tested (needs a real Fedora machine)

Nothing was run through RPM itself. Checked here instead: see `../README.md` ("What was checked here").

* `rpmspec -P`, `rpmbuild`, `mock`, `rpmlint`, a COPR build: never run. Things I am least sure rpm accepts as written: no `%files` for the
  main package (so no `vitre` binary package; this is how the python subpackage-only specs work), absolute paths in `%license` and `%doc`
  lines, `%files -n X -f file` with lists made in `%install`, `Requires: gnome-shell < 52~`.
* `dnf install` and removal on a real system: the scriptlets ran only against stubs in a scratch root.
* `dconf update` at install: Fedora may already own `/etc/dconf/db/local.d`; the scriptlet only creates the two empty folders when
  neither the folder nor the database exists, and it never touches an existing one.
* The session itself: Vitre session starting from GDM on Fedora 45/Rawhide, with `vitre.json` having no Yaru layer (GNOME's own
  stylesheet underneath Vitre-Glass), the extensions loading on Fedora's GNOME Shell 51.1, `org.gnome.Shell@vitre.service`
  (a template unit that gnome-shell ships), `gnome-session@vitre.target.d` and `DCONF_PROFILE=vitre` reaching the whole session.
  The headless rig only ever ran the Ubuntu build.
* `10-gnome-parity` read by a real dconf in a Vitre session (19 keys; a key whose schema is not installed, such as the Files ones without
  Files, is harmless to dconf).
* `vitre-system`: `plymouth-set-default-theme -R vitre` and `--reset`, dracut rebuilding the initramfs, and the splash on a boot.
  There is no login screen theme (see `../README.md`, difference 4).
* The package names in `Requires` were looked up in Rawhide only (`mdapi`, 2026-10-22): `gnome-shell-extension-user-theme`,
  `gnome-shell-extension-appindicator`, `gnome-session-wayland-session`, `rsms-inter-fonts`, `jetbrains-mono-fonts`, `plymouth-scripts`,
  `plymouth-plugin-script`, `dracut`, `hicolor-icon-theme`, `adwaita-icon-theme`. Check they exist in the `fedora-45` repository once it is out.
* The `Source0` archive layout (`vitre-0.2.0/` as top folder) is how GitHub names tag archives; not seen for this repository (nothing was
  downloaded here).

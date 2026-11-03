# Vitre on Fedora (COPR) and Arch (AUR)

Vitre 0.2.0 as RPMs and as an Arch split package, in the same ten-package split as the `.deb`s that the author builds from `release/native`
(a folder of the author's workspace, not part of this repository; `vitre-desktop`, `-session`, `-shell`, `-shell-extras`, `-theme`,
`-icons`, `-icons-base`, `-cursor`, `-backgrounds`, `-system`). Written 2026-10-22. **Nothing is published** (no COPR project, no AUR
repository), and **nothing here has been built on Fedora or Arch yet**: the checks were run on Ubuntu arm64, which has no rpmbuild,
rpmspec, mock, makepkg, pacman or namcap. The recipes build the **v0.2.0 tag**; they do not package the 0.3.0 changes in `CHANGELOG.md`
(the new motion, the accent colour themes, Vitre Appearance, Vitre Tray, Vitre Settings and the Dock stack) until the version, the sources and the checks here are moved on.

| Folder | What |
|---|---|
| `fedora/` | `vitre.spec` + `README.md` (how to build with mock/rpmbuild and for COPR; which Fedora has GNOME 51) + the source files the spec lists |
| `arch/` | `PKGBUILD` (split package), `.SRCINFO`, `vitre-session.install`, `vitre-system.install`, `README.md` + the source files the PKGBUILD lists |
| `common/` | the one copy of the shared source files. `sync-common.sh --copy` puts them into `fedora/` and `arch/` (COPR and the AUR need them beside the recipe) |
| `check-distro.py` | the checks that can run without rpm or pacman (see below) |
| `gen-srcinfo.sh` | stand-in for `makepkg --printsrcinfo`, used to write `arch/.SRCINFO` |

## Running the checks from here

This folder is `packaging/` of the Vitre repository. From the top of a checkout:

    python3 -I packaging/check-distro.py                 # quick: syntax, the spec, the PKGBUILD and .SRCINFO, sync-common.sh --check (a few seconds)
    MACTAHOE_ICON_THEME=~/src/MacTahoe-icon-theme python3 -I packaging/check-distro.py --stage    # also stages the whole tree (about 15 s, 400 MB)

`--stage` needs a checkout of [MacTahoe-icon-theme](https://github.com/vinceliuice/MacTahoe-icon-theme) (any commit), which the spec and the
PKGBUILD fetch themselves at the pinned ref. The Vitre tree it stages is the checkout above `packaging/` (`VITRE_SRC=<folder>` overrides it).
`release/native` belongs to the author's workspace and is optional here. With it (found beside the checkout, or `VITRE_NATIVE=<path>`),
`sync-common.sh` can refresh `common/` and `--stage` compares every file with the `.deb`s; without it `sync-common.sh --check` only compares
`fedora/` and `arch/` with `common/`. After changing a file in `common/`, run `./sync-common.sh --copy`
and then `python3 -I check-distro.py --fix-sums` (it recomputes the checksums of the local sources in `arch/PKGBUILD` and rewrites `arch/.SRCINFO`).

## How both packagings work

Both run the same script, `common/vitre-stage.sh`, which lays out the ten package trees from three inputs: the Vitre source tree (the
GitHub archive of tag `v0.2.0`), MacTahoe-icon-theme at the ref `install.sh` pins (`839848b9a8a38a92a6936e30c4abe35cc6f2546d`, a second
`Source`, so nothing is downloaded at install time), and the session files copied from `release/native` of the author's workspace (`sync-common.sh`, which refuses
to run on stale copies with `--check`). It is the Fedora/Arch counterpart of `release/native/tools/stage.sh`. The spec's `%files` and the
PKGBUILD's `package_*()` only pick up a tree each.

## What differs from the `.deb`s, and why

Everything else is byte for byte the same as the `.deb`s (checked, see below).

1. **No Yaru layer under the shell theme.** The `.deb`s ship a shell theme resource made of Ubuntu's Yaru stylesheets with Vitre-Glass
   appended. `vitre.json` here has no `stylesheetName`, `themeResourceName` or `iconsResourceName`, so (like GNOME's own `classic.json`) it
   inherits GNOME's stylesheet from the `user` mode and Vitre-Glass lies on top through the user-theme extension. That is what a per-user
   install of Vitre does on those distributions. The Yaru-based parity proof of the `.deb`s does not carry over.
2. **Extension list.** Ubuntu's `ubuntu-appindicators`, `ding`, `tiling-assistant@ubuntu.com`, `snapd-search-provider` and
   `web-search-provider` are replaced by `appindicatorsupport@rgcjonas.gmail.com` (packaged on both distributions) and
   `tiling-assistant@leleat-on-github` (in neither repository; skipped when absent, used when the user installs it). `user-theme` comes from
   `gnome-shell-extension-user-theme` (Fedora) and `gnome-shell-extensions` (Arch).
3. **`10-gnome-parity` instead of `10-ubuntu-parity`.** Vitre was tuned in the Ubuntu session, where Ubuntu's per-desktop overrides are in
   force (start in the desktop instead of the Overview, hot corners off, tap to click, Alt+Tab switching windows, `Super+Tab` switching
   applications, the show-desktop keys, a few file-chooser and Files defaults; 19 keys). A session named `Vitre:GNOME` loses those on Ubuntu,
   so the `.deb`s repeat them; Fedora and Arch never had them, so `10-gnome-parity` repeats the same values there (the author's choice,
   2026-10-22). It is made from `release/native`'s `10-ubuntu-parity` by `common/make-parity.py`, which drops only the Ubuntu-only parts:
   `favorite-apps` (names Ubuntu applications), the settings of Ubuntu's `ding` desktop icons extension and its `show-desktop-icons`
   switch. A `%config(noreplace)` / `backup=` file next to `00-vitre`; an administrator overrides a key in `/etc/dconf/db/local.d`.
4. **`vitre-system` is the boot splash only.** The login screen theme is selected on Ubuntu through the `gdm-theme.gresource` alternative;
   neither distribution has one, and `system/install-system.sh` of Vitre itself refuses such systems. A package could only replace
   gnome-shell's own `gnome-shell-theme.gresource`, which belongs to another package.
5. No ubuntu-mimeapps link and file trigger. The unit's `Documentation=` points at `README` instead of `README.Debian`.
6. Licence files go to `/usr/share/licenses/<package>/` (the third-party ones are named `<component>.<file>`).

## What was checked here (`python3 -I check-distro.py --stage`, 157 checks, last run 2026-10-22, all pass)

* `bash -n` / `dash -n` on every shell file and the `.install` scripts, Python parse of the three Python helpers, `sync-common.sh --check`.
* The spec read by a stand-in parser: ten subpackages = the `.deb` names, every one has `%description` and `%files`, no main binary
  package, sources present and numbered, no unescaped `%` in comments, no undefined macro, `sh -n` of every scriptlet, changelog weekday.
* The PKGBUILD: ten `package_*()`, `sha256sums` match the local sources, `.SRCINFO` equals what `gen-srcinfo.sh` writes, spec and PKGBUILD
  take the same local files, epoch-aware `gnome-shell` ranges.
* **The real build logic, run for real:** the spec's `%build` + `%install` and the PKGBUILD's `build()` + ten `package_*()` run on
  the Vitre tree and a local MacTahoe checkout (same ref). The spec's `%files` then cover exactly the staged files of each package:
  none missing, none listed twice, none left over. Spec and PKGBUILD give identical trees.
* **Against the `.deb`s:** all ten packages compared with the unpacked `.deb`s of `release/native/dist`, file for file and byte for byte
  (37,419 files in `vitre-icons-base` alone). The only differences are the ones listed above.
* **The scriptlets:** the spec's `%post/%postun/%preun` and the Arch `.install` functions run in a scratch root with stub `dconf`,
  `gtk-update-icon-cache`, `plymouth-set-default-theme` and `mkinitcpio`: admin databases made and removed, an administrator's own
  database or file is never touched, the previous splash is remembered and put back, a splash the administrator chose later is left alone,
  nothing happens during an upgrade's `%preun`.
* Online, read only (2026-10-22): GNOME versions and package names on both distributions (in the two READMEs).

## What needs a real machine

See "Not tested" in `fedora/README.md` and `arch/README.md`. In short: building at all (rpmbuild/mock/COPR, makepkg/namcap), installing,
the session starting from the login screen with the trimmed `vitre.json`, the shell theme without the Yaru layer, `10-gnome-parity` loaded by a real dconf, and the splash on a real
initramfs.

## Open (needs the author's decision)

* Publishing to COPR and the AUR: a COPR project, an AUR account and repository. (The GitHub tag `v0.2.0` is out; the two remote source
  checksums in `arch/PKGBUILD` were filled in from it and are kept as they are.)
* Fedora 45 (the first Fedora with GNOME 51) is not released yet (final target 2026-11-03); Rawhide has it today.

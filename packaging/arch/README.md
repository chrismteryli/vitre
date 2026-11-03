# Vitre for Arch (AUR)

`PKGBUILD` is one split package (`pkgbase=vitre`) that builds ten packages in one run: `vitre-desktop` (meta), `vitre-session`, `vitre-shell`,
`vitre-shell-extras`, `vitre-theme`, `vitre-icons`, `vitre-icons-base`, `vitre-cursor`, `vitre-backgrounds` and the optional `vitre-system` (boot
splash only). **Split, because** the same ten-way split as the `.deb`s and RPMs lets people install only the session or only the extensions, and
keeps the boot splash (which changes the machine for every user) a separate optional package, without a second build. The overview, the
differences from the `.deb`s and the checks that were run are in `../README.md`. Never built on Arch yet.

## Which GNOME Arch has

Checked read only on 2026-10-22 (archlinux.org package search): **GNOME 51 is current.** `[extra]` has `gnome-shell 1:51.1-1` (updated
2026-10-14), `gnome-session 51.0-1`, `gnome-shell-extensions 51.0-1` (carries the user-theme extension), `gdm 51.1.1-1`, `dconf 51.0-1`,
`plymouth 26.134.222-3`, `gnome-shell-extension-appindicator 66-1`, `inter-font 4.1-1`, `ttf-jetbrains-mono 2.304-2`. Note the **epoch**:
gnome-shell is `1:51.1-1`, so the PKGBUILD says `gnome-shell>=1:51` and `gnome-shell<1:52` (a plain `<52` would never be true).
No package named `vitre*` exists in the AUR (searched 2026-10-22).

## Build

    cd packaging/arch
    makepkg -s            # downloads the two tarballs, builds all ten packages
    sudo pacman -U vitre-*.pkg.tar.zst            # or only the ones you want; vitre-desktop pulls in the rest, vitre-system stays optional

Then sign out, click the gear on the login screen, pick Vitre.

`source` 1 is the GitHub archive of the tag `v0.2.0` and source 2 the MacTahoe ref; their `sha256sums` were filled in after v0.2.0 was
published (`updpkgsums` from pacman-contrib recomputes them if GitHub ever serves different bytes). To try the recipe against local
checkouts instead of GitHub, put two tarballs made from them beside the PKGBUILD (makepkg uses a file of that name instead of
downloading) and run `makepkg --skipchecksums`; delete them again afterwards:

    git -C ../.. archive --prefix=vitre-0.2.0/ -o "$PWD/vitre-0.2.0.tar.gz" v0.2.0
    git -C /path/to/MacTahoe-icon-theme archive --prefix=MacTahoe-icon-theme-839848b9a8a38a92a6936e30c4abe35cc6f2546d/ \
        -o "$PWD/MacTahoe-icon-theme-839848b9a8a38a92a6936e30c4abe35cc6f2546d.tar.gz" 839848b9a8a38a92a6936e30c4abe35cc6f2546d

## Publish to the AUR (not done: needs an AUR account and the author's go-ahead)

    makepkg --printsrcinfo > .SRCINFO     # the file here was written by ../gen-srcinfo.sh; regenerate it and look at the diff
    namcap PKGBUILD && namcap vitre-*.pkg.tar.zst
    git clone ssh://aur@aur.archlinux.org/vitre.git aur-vitre
    cp PKGBUILD .SRCINFO *.install vitre-stage.sh make-mode.py make-defaults.py sanitize-staged.py session-extensions.txt \
       vitre-mode.json.in vitre-session vitre.session vitre.desktop vitre.session.conf vitre-user-setup vitre-user-setup.service \
       dconf-profile-vitre vitre-backgrounds.xml README.vitre-session 10-ubuntu-parity make-parity.py aur-vitre/
    # then git add, commit, push in aur-vitre (one repository, pkgbase vitre; the ten packages appear from it)

`README.md` is not needed in the AUR repository. Pacman has no recommended dependencies, so what the `.deb`s recommend is `optdepends` here
(`vitre-system` from `vitre-desktop`, the extension and icon packages from `vitre-session`).

## vitre-system and mkinitcpio

`post_install` makes Vitre the selected Plymouth theme (`plymouth-set-default-theme vitre`, remembering the previous one) and runs
`mkinitcpio -P` only if the `plymouth` hook is already in `HOOKS`; otherwise it prints what to add. Removing the package puts the previous
theme back (only if Vitre is still the selected one). There is no login screen theme (see `../README.md`, difference 4).

## Not tested (needs a real Arch machine)

Nothing was run through pacman or makepkg. Checked here instead: see `../README.md` ("What was checked here"): `bash -n`, the PKGBUILD's
`build()` and ten `package_*()` run by hand with `srcdir`/`pkgdir` set up like makepkg does (no fakeroot, no bsdtar), the `.install`
functions against stubs, and the staged trees against the `.deb`s.

* `makepkg`, `makepkg --printsrcinfo`, `namcap`, `updpkgsums`: never run. `.SRCINFO` comes from `../gen-srcinfo.sh`, which only reads
  the PKGBUILD the way makepkg does for these simple arrays; compare it with the real output.
* Things I am least sure makepkg/namcap accept as written: SPDX `license=` names (`GPL-3.0-only`, `GPL-3.0-or-later`, ...), `options=(!strip !debug)`,
  `install=` and `backup=` set inside `package_*()`, version-pinned `depends` between the sibling packages, `cp -a --no-preserve=ownership`
  under fakeroot.
* `10-gnome-parity` read by a real dconf in a Vitre session (19 keys; a key whose schema is not installed, such as the Files ones without Files, is harmless to dconf).
* `pacman -U`, upgrade and removal on a real system; the dconf and icon-cache pacman hooks (`dconf-update.hook`, `gtk-update-icon-cache.hook`
  exist in the `dconf` and `gtk-update-icon-cache` packages; their targets were not read). The `.install` calls `dconf update` itself.
* The session itself: Vitre session starting from GDM on Arch with `vitre.json` having no Yaru layer (GNOME's own stylesheet underneath
  Vitre-Glass), extensions loading on GNOME Shell 51.1, `org.gnome.Shell@vitre.service` (a template unit that gnome-shell ships) and
  `gnome-session@vitre.target.d`. The headless rig only ever ran the Ubuntu build.
* `vitre-system` on a real initramfs (mkinitcpio with the plymouth hook, and dracut users, who are not handled).
* The `Source0` archive layout (`vitre-0.2.0/` as top folder) is how GitHub names tag archives; not seen for this repository.

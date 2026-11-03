# Changelog

## 0.3.0 (2026-11-03)

Motion and look

- All motion runs on one spring engine now. Menus, Control Center, Notification Center, banners, Search, the switcher, the lock screen,
  the hot corner, overview windows, snapping and tiling, fullscreen, Stage swaps and the Dock share one set of springs, so an interrupted
  motion turns around without a jump. The glass pours out of what you clicked and drains back into it.
- The Stage strip moved to a band at the bottom, left and right of the Dock, with the most recent window nearest the Dock. Every parked
  window has the same cell, with the picture fitted and centred and the badge in the same corner. `strip-position` in the Stage
  settings brings back the old column on the left.
- One design system for the shell: a type scale, a radius scale, three glass levels and three shadows, applied to every Vitre style
  sheet and the shell theme. The Control Center has no holes in its grid, the Now Playing tile has an idle state, and the toggles share
  one look. The lock screen and the login screen use the same glass card.
- The window buttons are one capsule as tall as the header buttons beside them, the same in GTK 4, libadwaita and GTK 3.
- GTK widgets (switches, check boxes, radio buttons, slider knobs, segmented controls) animate in every accent theme.
- Pick an accent colour. The nine GNOME accents (from Vitre Settings, Look, or from GNOME Settings) now colour the switches, checks,
  sliders, selection, links and default buttons of GTK 4 and GTK 3 apps, and the Control Center, the selected row in Search and the plate
  under the app in the switcher. GTK 3 cannot read the accent, so Vitre ships one small Vitre-Glass theme for each accent and style
  (Vitre-Glass-Green, Vitre-Glass-Green-Light and so on) and switches between them. Blue is now GNOME's own blue.
- The Vitre-Glass theme now has a light style for GTK 3 and GTK 4 apps. Before, both followed the dark one.
- Light and dark on a schedule. A new extension, Vitre Appearance, turns the style dark from sunset to sunrise, or at the times you pick,
  and the wallpaper changes to its dark or light picture with it. It is off until you choose Auto in Vitre Settings, Look, so the style
  stays as it is. A style you set by hand is kept until the next scheduled switch.
- Vitre icons for 50 more apps (browsers, chat, media, graphics, office, games and tools), under 434 icon names, so fewer apps
  fall back to their own icon.

Apps and Dock

- Vitre Settings is a new app for the choices Vitre has: motion, Dock, windows, glass and look. Open it from the app grid. A change
  applies at once, without signing out. It needs gjs and libadwaita, which a GNOME 51 desktop has. A row only shows when the extension
  it changes is installed and on.
- The Dock has a Downloads stack just before the Trash: a pile of your newest downloads that opens as a fan of up to ten files, or as a
  scrolling grid when there are more. Click a file to open it, or drag it onto the Trash or onto an app in the Dock. Folders you add to
  the Dock open the same way. Vitre Settings, Dock, turns the stack off or changes how it opens.
- The Trash works. Drop files on it from Files or any app, or from a stack, and they move to the trash. It shows empty or full, and
  Empty Trash asks first. Dropping on it did nothing before.
- Dragging over the Dock: icons make room around the pointer, the drop target swells, and a drop is swallowed by its target.
- A tray item that is gone before its icon loads (an app's second launch that quits at once) no longer flashes a loading glyph in the
  top bar or fills the log. A new Vitre Tray extension holds the button back until its icon has loaded.
- Files: the tab bar no longer logs "AdwTabBox reported min width -6".
- Blur my Shell is version 77 (76 in 0.2.0), the one running on the author's desktop.

Install and uninstall

- Uninstall gives back only what Vitre owns. It removes the files the install created, puts back the files it replaced, and restores a
  setting to its old value only when Vitre's value is still in place. A setting you changed since, and every setting Vitre never
  touched, stay as they are. 0.2.0 reloaded a dump of all of `/org/gnome/`, which also undid later changes to unrelated settings.
  `./uninstall.sh --factory-reset` is the explicit full restore: every setting Vitre owns goes back to its pre-install value.
- An upgrade keeps your Vitre settings and writes only the settings that are new. Installing over 0.2.0 works that way, and
  `./uninstall.sh` also undoes a backup made by 0.2.0 (restoring only the settings Vitre owns).
- Backups are private (a 0700 folder) and each install gets its own folder, so two installs in the same second cannot share one. The
  files Vitre installs keep your normal umask.
- The base icon theme is downloaded to a file and checked against a pinned SHA-256 before anything is unpacked or run. A wrong archive
  stops the install.
- The uninstaller finds files under an `XDG_DATA_HOME` or `XDG_CONFIG_HOME` outside your home folder.
- `uninstall.sh` says so when there is nothing to undo instead of stopping silently.

Privacy

- Vitre Appearance asks GNOME's location service for your position only in Auto (sunset) mode with Location Services on. Manual and
  custom schedules use your time zone and never start it.

Testing and packaging

- Every push is tested on x86_64 and arm64 in GitHub Actions: static checks, install and uninstall in a throwaway home (upgrade over
  0.2.0, later changes, factory reset, external XDG roots, private backups, the pinned download), a unit test for the location
  privacy, and a headless GNOME Shell 51 that has to load every Vitre extension without an error.
- The optional login screen (`system/`) has the new glass card.
- Fedora and Arch recipes in `packaging/`: an RPM spec for COPR and a PKGBUILD for the AUR, in the same ten-package split as the `.deb`s.
  They still build the v0.2.0 tag, so they do not have anything from this list yet. They are checked on Ubuntu only and are not
  published or built on those systems.
- The apt packages stay at 0.2.0 for now. Use `./install.sh` for 0.3.0.

## 0.2.0

- The Dock now ships as Vitre Dock, a fork of Dhruva with its own name (`vitre-dock@vitre-desktop`). Once a day GNOME replaces the
  extensions in your home folder with the versions on extensions.gnome.org. That swapped Vitre's patched Dhruva for the original
  within a day and brought back the Dock's own Genie animation. GNOME does not know Vitre Dock, so it no longer replaces it.
  The installer turns Dhruva off if you have it and copies its settings to Vitre Dock.
- Stage swaps no longer get a second animation from the Dock.
- Clicking the Dock icon of the app on the stage keeps it there.
- Fullscreen enter and exit is one motion. Leaving fullscreen plays the same motion backwards.
- Window snapping, tiling and maximize move in one motion.
- A new workspace switch. The workspace you leave steps back and dims while the next one slides in, and a swipe follows your fingers.
  Scrolling between workspaces in the overview rides the same spring.
- Fast Stage swaps during a workspace switch no longer log warnings.
- In fullscreen, move the pointer into the top right corner and a small glass capsule shows the time and the battery, with a button
  that opens the Control Center. The battery turns green with a bolt while charging, shows a plug when it is held at a charge
  limit, and turns red when low.
- Search and the switcher stay readable over bright windows.
- New window buttons.
- An original cursor set. The glass drop pointer, hand, text beam, resize arrows and the rest are new art, and the glass ring busy
  spinner stays. The WhiteSur based arrow set is gone.
- Vitre can also be installed as its own session at the login screen, from a signed apt repository (optional, needs sudo). Ubuntu
  stays in the session menu as the way back.
- An optional login screen and boot splash in `system/`. It is the only part of the zip install that needs root, so `install.sh` leaves it alone.
  `sudo ./system/install-system.sh` asks first, puts everything back by itself if a step fails, and
  `sudo ./system/uninstall-system.sh` undoes it.
- A landing page for GitHub Pages (`docs/index.html`) and a refreshed README. The demo video plays everywhere now: it is re-encoded
  so it also plays in Safari and on phones.
- The installer compiles each extension's settings schemas on your own machine instead of trusting the packaged files.

## 0.1.1

- The base icon theme no longer brings MacTahoe's app icons. The installer fetches MacTahoe's glyphs, folders and file types as its own
  copy named VitreBase and removes the app icons from it. An app that Vitre-Icons has no original art for keeps its own icon.
- Screenshots, motion clips and a 27 second demo video in `docs/`.
- `vitre-info.sh` prints what a bug report needs. A contributing guide, an issue template and a security note.

## 0.1.0 (first release)

Everything. The first public version.

- Glass menus, Control Center, Notification Center, the volume bar, app menus, Dock menus, dialogs and the lock screen
  use one motion: the glass stretches out of what you clicked and lands as the real surface.
- Windows slide into and out of their Dock icons when minimized and restored. New windows grow in, closing windows shrink
  away, and the Dock icon hops while an app launches.
- Stage, the three finger swipe up, drag and drop between the overview and the strip.
- Search (Super+Space), the Super+Tab switcher, notification banners, show desktop (Super+F3).
- The Vitre-Glass theme, icons, cursor and wallpapers. Red, yellow and green window buttons drawn crisp at every scale.
- Dock window previews stay open while you move onto them.
- `install.sh` (with `--check`) and `uninstall.sh`, with a backup of everything they touch.

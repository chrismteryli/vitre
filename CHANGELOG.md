# Changelog

## Unreleased

- Every push is tested on x86_64 and arm64 in GitHub Actions: static checks, install and uninstall in a throwaway home, and a
  headless GNOME Shell 51 that has to load every Vitre extension without an error.
- `uninstall.sh` says so when there is nothing to undo instead of stopping silently.
- Vitre icons for 50 more apps (browsers, chat, media, graphics, office, games and tools), under 434 icon names, so fewer apps
  fall back to their own icon.

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

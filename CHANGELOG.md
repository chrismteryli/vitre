# Changelog

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

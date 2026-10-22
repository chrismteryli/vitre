# Credits

Vitre is built on the work of these projects. Each keeps its own licence; their licence files ship inside their folders.

## GNOME Shell extensions shipped with Vitre

| Extension | Folder | Licence | Source |
|---|---|---|---|
| Vitre Dock, a fork of Dhruva by NarkAgni with Vitre's changes | `extensions/vitre-dock@vitre-desktop` | GPL-3.0 | https://github.com/narkagni/dhruva |
| Blur my Shell | `extensions/blur-my-shell@aunetx` | GPL-3.0 | https://github.com/aunetx/blur-my-shell |
| Just Perfection | `extensions/just-perfection-desktop@just-perfection` | GPL-3.0 | https://github.com/jrahmatzadeh/just-perfection |
| Liquid Glass | `extensions/liquid-glass@thinkingcoding1231.gmail.com` | MIT | https://github.com/ryohsuke1231/liquid-glass |
| Logo Menu | `extensions/logomenu@aryan_k` | GPL-2.0 or later | https://github.com/Aryan20/Logomenu |
| Rounded Window Corners Reborn | `extensions/rounded-window-corners@fxgn` | GPL-3.0 | https://github.com/flexagoon/rounded-window-corners |
| User Themes | `extensions/user-theme@gnome-shell-extensions.gcampax.github.com` | GPL-2.0 or later | https://gitlab.gnome.org/GNOME/gnome-shell-extensions |

Vitre Dock is a fork of Dhruva (version 4.7, copyright NarkAgni). It has its own name, uuid and settings schema so that GNOME's
automatic extension updates do not replace it with the original. Vitre's changes are marked "Vitre" in
`src/ui/effects/WindowEffects.js`, `src/ui/dock/DockItemBuilder.js` and `src/ui/dock/DockRenderer.js` and listed in the folder's
`VITRE-PATCHES.txt`. The folder also has Dhruva's GPL-3.0 licence (`LICENSE`) and a `NOTICE.txt` that credits the original project.

## Look

- **Vitre-Glass** (GTK 3, GTK 4, shell and window-frame theme) is a renamed copy of the MacTahoe GTK theme by
  Vince Liuice and contributors (MIT), https://github.com/vinceliuice/MacTahoe-gtk-theme , with Vitre art in place of the
  vendor art. See `themes/Vitre-Glass/NOTICE.txt` and `themes/Vitre-Glass/COPYING`.
- **GTK 4 window look** (`gtk/gtk-4.0`): the MacTahoe libadwaita stylesheet (MIT) with the Vitre window layer on top
  (`a18-chrome.css`).
- **Vitre-Icons** is original Vitre art for the common apps. Everything it does not draw comes from a base copy of the MacTahoe icon
  theme by Vince Liuice (GPL-3.0), https://github.com/vinceliuice/MacTahoe-icon-theme . The installer fetches that theme from its own
  project at a fixed version and installs it under the name VitreBase, without MacTahoe's app icons, so every app that Vitre-Icons has
  no art for keeps its own icon.
- **Vitre-Cursor** is original Vitre art: the glass drop pointer set and the glass ring busy spinner. It is released under
  the GPL-3.0 like the rest of Vitre (see `icons/Vitre-Cursor/LICENSE`).
- Fonts (installed from your distribution): Inter by Rasmus Andersson (OFL-1.1), JetBrains Mono (OFL-1.1).
  The brand wordmark uses Outfit (OFL-1.1), drawn as outlines.

## Login screen and boot splash (optional, `system/`)

- The login screen theme is a modified copy of Ubuntu's login theme: the Yaru shell theme by the Ubuntu community (GPL-3.0 and
  CC-BY-SA-4.0), https://github.com/ubuntu/yaru , and GNOME Shell's own default theme files (GPL-2.0 or later), with Vitre's
  login stylesheet and background.
- The boot splash (`system/assets/plymouth/vitre`) is original Vitre work.

## Everything else

The Vitre extensions (`extensions/vitre-*`), the wallpapers, the logo and brand art, the installer and the settings are
original work, released under the GPL-3.0 (see `LICENSE`).

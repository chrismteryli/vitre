# Credits

Vitre is built on the work of these projects. Each keeps its own licence; their licence files ship inside their folders.

## GNOME Shell extensions shipped with Vitre

| Extension | Folder | Licence | Source |
|---|---|---|---|
| Dhruva (dock), with Vitre patches to its window effects | `extensions/dhruva@narkagni` | GPL-3.0 | https://github.com/narkagni/dhruva |
| Blur my Shell | `extensions/blur-my-shell@aunetx` | GPL-3.0 | https://github.com/aunetx/blur-my-shell |
| Just Perfection | `extensions/just-perfection-desktop@just-perfection` | GPL-3.0 | https://github.com/jrahmatzadeh/just-perfection |
| Liquid Glass | `extensions/liquid-glass@thinkingcoding1231.gmail.com` | MIT | https://github.com/ryohsuke1231/liquid-glass |
| Logo Menu | `extensions/logomenu@aryan_k` | GPL-2.0 or later | https://github.com/Aryan20/Logomenu |
| Rounded Window Corners Reborn | `extensions/rounded-window-corners@fxgn` | GPL-3.0 | https://github.com/flexagoon/rounded-window-corners |
| User Themes | `extensions/user-theme@gnome-shell-extensions.gcampax.github.com` | GPL-2.0 or later | https://gitlab.gnome.org/GNOME/gnome-shell-extensions |

The Dhruva patches (Dock launches without the minimize effect, and no double completion of minimize, unminimize and map)
are in `src/ui/effects/WindowEffects.js` and are marked "Vitre".

## Look

- **Vitre-Glass** (GTK 3, GTK 4, shell and window-frame theme) is a renamed copy of the MacTahoe GTK theme by
  Vince Liuice and contributors (MIT), https://github.com/vinceliuice/MacTahoe-gtk-theme , with Vitre art in place of the
  vendor art. See `themes/Vitre-Glass/NOTICE.txt` and `themes/Vitre-Glass/COPYING`.
- **GTK 4 window look** (`gtk/gtk-4.0`): the MacTahoe libadwaita stylesheet (MIT) with the Vitre window layer on top
  (`a18-chrome.css`).
- **Vitre-Icons** is original Vitre art drawn over the MacTahoe icon theme by Vince Liuice (GPL-3.0),
  https://github.com/vinceliuice/MacTahoe-icon-theme . The installer fetches that theme from its own project.
- **Vitre-Cursor** is the WhiteSur cursor theme by Vince Liuice (GPL-3.0), https://github.com/vinceliuice/WhiteSur-cursors ,
  with a Vitre busy spinner.
- Fonts (installed from your distribution): Inter by Rasmus Andersson (OFL-1.1), JetBrains Mono (OFL-1.1).
  The brand wordmark uses Outfit (OFL-1.1), drawn as outlines.

## Everything else

The Vitre extensions (`extensions/vitre-*`), the wallpapers, the logo and brand art, the installer and the settings are
original work, released under the GPL-3.0 (see `LICENSE`).

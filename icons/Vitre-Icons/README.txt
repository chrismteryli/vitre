Vitre-Icons (staged 2026-10-12, not installed)
An icon theme that sits on top of MacTahoe-dark (Inherits=MacTahoe-dark) and replaces, with original Vitre glass art:
  - every file of MacTahoe-dark that draws a vendor logo (start-here*,*, and the drive icon family that carries it), and
  - the app icons that MacTahoe copies from a vendor's own apps.
Every other icon name falls through to MacTahoe-dark, so nothing else changes.
The art is generated: identity/branding/icons/gen/art.py (drawing), families.py (which names each icon takes over), build_theme.py (writes this folder).
Names MacTahoe-dark also uses for small action/status/place/mime icons are not replaced (so toolbar and menu glyphs stay glyphs), except the two forced
because installed apps use them as app icons: system-software-update, multimedia-volume-control. ALIASES.txt lists every name, family by family.
Install (later, by the package): copy this folder to ~/.local/share/icons/Vitre-Icons, run gtk4-update-icon-cache -f -t on it, then set
org.gnome.desktop.interface icon-theme to 'Vitre-Icons' (wallpapers/dconf style: icons/dconf/vitre-icons.dconf; undo file next to it).
Light mode: this theme inherits the dark MacTahoe set, which is what is set today. A light twin would inherit MacTahoe-light; not built.

#!/usr/bin/env python3
"""make-mode.py TEMPLATE VITRE_EXTENSIONS_TXT DISTRO_EXTENSIONS_TXT OUT
Writes the GNOME Shell session mode /usr/share/gnome-shell/modes/vitre.json for Fedora and Arch.

TEMPLATE is release/native/session/vitre-mode.json.in, the file the .debs use. Two differences from the .debs:
  * the extension list is the distribution's list (DISTRO_EXTENSIONS_TXT) followed by settings/extensions.txt of the Vitre source;
  * the three theme keys (stylesheetName, themeResourceName, iconsResourceName) are dropped. The .debs point them at a Vitre shell theme
    resource built on Yaru's stylesheets (Ubuntu's). Arch does not package Yaru and Fedora's copy is a separate optional package, so
    the session does not depend on it. A mode that leaves those keys out inherits them from its parent mode `user` (GNOME's own classic.json does the same), so GNOME's own stylesheet is
    the base and Vitre-Glass is laid on top of it by the user-theme extension, which is exactly what a per-user install does there.
"""
import json, sys

tpl, vitre_list, distro_list, out = sys.argv[1:5]
mode = json.load(open(tpl))
read = lambda p: [l.strip() for l in open(p) if l.strip() and not l.startswith('#')]
exts = read(distro_list) + read(vitre_list)
assert len(exts) == len(set(exts)), 'an extension is listed twice'
for never in ('ubuntu-dock@ubuntu.com', 'dhruva@narkagni', 'dash-to-dock@micxgx.gmail.com'):
    assert never not in exts, never + ' must not be in the Vitre mode (the Vitre Dock is the only dock)'
assert 'vitre-dock@vitre-desktop' in exts and 'user-theme@gnome-shell-extensions.gcampax.github.com' in exts
assert mode['enabledExtensions'] == '@ENABLED_EXTENSIONS@'
mode['enabledExtensions'] = exts
for key in ('stylesheetName', 'themeResourceName', 'iconsResourceName'):
    assert key in mode, key + ' is not in the template any more: check make-mode.py'
    del mode[key]
assert mode['parentMode'] == 'user'
with open(out, 'w') as f:
    f.write(json.dumps(mode, indent=4) + '\n')

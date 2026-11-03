#!/usr/bin/env python3
"""make-defaults.py OUT_KEYFILE
Turns release/vitre/settings/vitre.ini (a keyfile for `dconf load /org/gnome/`, with @HOME@) into the system defaults keyfile
/etc/dconf/db/vitre.d/00-vitre: full dconf paths, system locations instead of @HOME@, no enabled/disabled-extensions keys
(the session mode owns the extension list). The user-theme name stays: the session mode enables the user-theme extension and this key
tells it to lay Vitre-Glass on top of the session's shell stylesheet, the same way a per-user install does."""
import os, re, sys

here = os.path.dirname(os.path.abspath(__file__))
src = os.environ.get('VITRE_PKG_SRC', os.path.join(here, '..', '..', 'vitre'))
out = sys.argv[1]
text = '\n'.join(l for l in open(os.path.join(src, 'settings', 'vitre.ini')).read().splitlines() if not l.startswith('#')) + '\n'

text = text.replace("file://@HOME@/.local/share/backgrounds/vitre/", "file:///usr/share/backgrounds/vitre/")
text = text.replace("@HOME@/.local/share/icons/hicolor/scalable/apps/", "/usr/share/icons/hicolor/scalable/apps/")
assert '@HOME@' not in text and '.local' not in text, 'a per-user path is left in the defaults'

groups, cur = [], None
for line in text.splitlines():
    m = re.match(r'^\[(.+)\]$', line)
    if m:
        cur = [m.group(1), []]
        groups.append(cur)
    elif cur is not None and line.strip():
        cur[1].append(line)
    elif cur is None and line.strip() and not line.startswith('#'):
        raise SystemExit('key outside a group: ' + line)

lines = [
    '# Vitre system defaults (dconf database "vitre", compiled by `dconf update`).',
    '# They apply only inside the Vitre session (DCONF_PROFILE=vitre, set by /usr/bin/vitre-session); the Ubuntu session does not read them.',
    '# Anything a user has already set in their own account wins over these values (`dconf reset <key>` gives the default back).',
    '# The list of extensions is not here: the session mode /usr/share/gnome-shell/modes/vitre.json owns it.',
    '',
]
seen = set()
for g, kv in groups:
    path = 'org/gnome/' + g
    assert path not in seen, path
    seen.add(path)
    keep = [k for k in kv if not k.split('=', 1)[0] in ('enabled-extensions', 'disabled-extensions')]
    if not keep:
        continue
    lines.append('[%s]' % path)
    lines.extend(keep)
    lines.append('')
open(out, 'w').write('\n'.join(lines))
print('wrote', out, len(seen), 'groups')

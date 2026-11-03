#!/usr/bin/env python3
"""make-parity.py IN_UBUNTU_PARITY OUT_GNOME_PARITY
Writes /etc/dconf/db/vitre.d/10-gnome-parity for Fedora and Arch from release/native's 10-ubuntu-parity (the file the .debs ship).

Vitre was built and tuned in the Ubuntu session, where Ubuntu's per-desktop overrides (the `:ubuntu` groups of its gschema override
file) are in force: start in the desktop instead of the Overview, hot corners off, tap to click, Alt+Tab switching windows, and so on.
A session named Vitre:GNOME does not get those overrides on Ubuntu, so the .debs repeat them. Fedora and Arch never had them, so the
Vitre session there would fall back to plain GNOME for these keys; this file repeats the same values so that the Vitre session
behaves the same on every distribution (the author's choice, 2026-10-22).

Dropped, because they only mean something on Ubuntu:
  [org/gnome/shell] favorite-apps                  Ubuntu's list of Ubuntu applications (the Vitre Dock is not driven by it anyway)
  [org/gnome/shell/extensions/ding]                the settings of Ubuntu's desktop icons extension, which these distributions do not have
  [org/gnome/desktop/background] show-desktop-icons  the same extension's switch
Everything else is kept as it is. A rule that no longer finds its target stops the build, so a changed native file is noticed.
"""
import re, sys

src, out = sys.argv[1:3]
DROP_GROUPS = {'org/gnome/shell/extensions/ding', 'org/gnome/desktop/background'}
DROP_KEYS = {('org/gnome/shell', 'favorite-apps')}

groups, cur = [], None
for line in open(src, encoding='utf-8').read().splitlines():
    m = re.match(r'^\[(.+)\]$', line)
    if m:
        cur = [m.group(1), []]
        groups.append(cur)
    elif cur is not None and line.strip():
        cur[1].append(line)

seen_groups, seen_keys, kept = set(), set(), []
for name, lines in groups:
    if name in DROP_GROUPS:
        seen_groups.add(name)
        continue
    keep = []
    for l in lines:
        if (name, l.split('=', 1)[0]) in DROP_KEYS:
            seen_keys.add((name, l.split('=', 1)[0]))
            continue
        keep.append(l)
    if keep:
        kept.append((name, keep))
assert seen_groups == DROP_GROUPS, 'the native file no longer has: %s' % sorted(DROP_GROUPS - seen_groups)
assert seen_keys == DROP_KEYS, 'the native file no longer has: %s' % sorted(DROP_KEYS - seen_keys)
body = '\n'.join(l for _, ls in kept for l in ls)
assert 'ubuntu' not in body.lower(), 'an Ubuntu-only value is left in the kept keys'

header = '''# Vitre system defaults, part 2 (Fedora and Arch): the same values the Ubuntu session gets from Ubuntu's per-desktop overrides.
#
# Vitre was built and tuned in the Ubuntu session, where start-in-overview is off, hot corners are off, tap to click is on, Alt+Tab
# switches windows and so on. Fedora and Arch do not set those, so a Vitre session there would fall back to plain GNOME for them. This
# file repeats the values so that the Vitre session behaves the same on every distribution. It is the counterpart of 10-ubuntu-parity in
# the Ubuntu packages, without the Ubuntu-only parts (favorite-apps, which names Ubuntu applications, and the settings of Ubuntu's
# desktop icons extension).
#
# Only keys that 00-vitre does not already set. Same rules as 00-vitre: only inside the Vitre session (DCONF_PROFILE=vitre), a value you
# set yourself wins, `dconf reset <key>` gives the default back. To get plain GNOME behaviour back machine-wide for a key, put the
# value you want in /etc/dconf/db/local.d (the profile reads it above the Vitre defaults) and run `dconf update`.

'''
with open(out, 'w', encoding='utf-8') as f:
    f.write(header)
    f.write('\n\n'.join('[%s]\n%s' % (n, '\n'.join(ls)) for n, ls in kept) + '\n')
print('wrote %s: %d groups, %d keys' % (out, len(kept), sum(len(ls) for _, ls in kept)))

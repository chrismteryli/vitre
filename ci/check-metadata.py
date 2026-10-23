#!/usr/bin/env python3
"""JSON and metadata checks for the Vitre tree (part of the static CI job). Changes nothing.

    python3 ci/check-metadata.py [REPO]

What it checks:
  - every .json file in the tree parses (tsconfig.json / jsconfig.json may contain comments, they are parsed as JSONC);
  - every extension folder has a metadata.json with uuid (equal to the folder name), name, description and a shell-version list that
    contains the shell major Vitre targets (51), an extension.js, and, when it names a settings-schema, a schema file that declares it;
  - settings/extensions.txt (what install.sh enables) and extensions/ list exactly the same uuids, no duplicates;
  - settings/conflicts.txt shares nothing with extensions.txt;
  - VERSION is a plain version number and CHANGELOG.md mentions it.
Exit status 1 when any check fails.
"""
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

REPO = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
TARGET_SHELL = '51'
IN_GH = bool(os.environ.get('GITHUB_ACTIONS'))
checks = 0
fails = 0


def ok(msg):
    global checks
    checks += 1
    print(f'  ok   {msg}')


def bad(msg):
    global checks, fails
    checks += 1
    fails += 1
    print(f'  FAIL {msg}')
    if IN_GH:
        print(f'::error title=Vitre CI::{msg}')


def jsonc_loads(text):
    """Parses JSON with // and /* */ comments and trailing commas (tsconfig.json style)."""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(text[i + 1]); i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True; out.append(c)
        elif text.startswith('//', i):
            while i < n and text[i] != '\n':
                i += 1
            continue
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        else:
            out.append(c)
        i += 1
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', ''.join(out)))


def walk_json():
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules')]
        for f in files:
            if f.endswith('.json'):
                yield os.path.join(root, f)


# ---- 1. every .json file parses ----------------------------------------------------------------------------------------------------
n_json = 0
for p in sorted(walk_json()):
    rel = os.path.relpath(p, REPO)
    n_json += 1
    try:
        with open(p, encoding='utf-8') as fh:
            text = fh.read()
        try:
            json.loads(text)
        except ValueError:
            if re.match(r'(ts|js)config.*\.json$', os.path.basename(p)):
                jsonc_loads(text)
            else:
                raise
    except Exception as e:  # noqa: BLE001 (report every kind of failure)
        bad(f'{rel} is not valid JSON: {e}')
if n_json and fails == 0:
    ok(f'{n_json} .json files parsed')

# ---- 2. extension metadata -----------------------------------------------------------------------------------------------------------
ext_root = os.path.join(REPO, 'extensions')
dirs = sorted(d for d in os.listdir(ext_root) if os.path.isdir(os.path.join(ext_root, d))) if os.path.isdir(ext_root) else []
if not dirs:
    bad('extensions/ has no extension folders')
for d in dirs:
    base = os.path.join(ext_root, d)
    mp = os.path.join(base, 'metadata.json')
    if not os.path.isfile(mp):
        bad(f'{d}: metadata.json is missing')
        continue
    try:
        with open(mp, encoding='utf-8') as fh:
            m = json.load(fh)
    except Exception as e:  # noqa: BLE001
        bad(f'{d}: metadata.json does not parse: {e}')
        continue
    problems = []
    for key in ('uuid', 'name', 'description', 'shell-version'):
        if not m.get(key):
            problems.append(f'"{key}" is missing or empty')
    if m.get('uuid') and m['uuid'] != d:
        problems.append(f'uuid "{m["uuid"]}" differs from the folder name')
    sv = m.get('shell-version')
    if sv is not None:
        if not isinstance(sv, list) or not all(isinstance(x, str) for x in sv):
            problems.append('"shell-version" must be a list of strings')
        elif not any(x == TARGET_SHELL or x.startswith(TARGET_SHELL + '.') for x in sv):
            problems.append(f'"shell-version" {sv} does not include {TARGET_SHELL}: GNOME Shell {TARGET_SHELL} would refuse to load it')
    if not os.path.isfile(os.path.join(base, 'extension.js')):
        problems.append('extension.js is missing')
    sid = m.get('settings-schema')
    if sid:
        found = False
        sdir = os.path.join(base, 'schemas')
        for f in (os.listdir(sdir) if os.path.isdir(sdir) else []):
            if f.endswith('.gschema.xml'):
                try:
                    for s in ET.parse(os.path.join(sdir, f)).getroot().iter('schema'):
                        if s.get('id') == sid:
                            found = True
                except ET.ParseError as e:
                    problems.append(f'schemas/{f} is not valid XML: {e}')
        if not found:
            problems.append(f'settings-schema "{sid}" is not declared in schemas/*.gschema.xml')
    modes = m.get('session-modes')
    if modes is not None and not (isinstance(modes, list) and all(x in ('user', 'unlock-dialog', 'gdm') for x in modes)):
        problems.append(f'unknown session-modes {modes}')
    if problems:
        for pr in problems:
            bad(f'{d}: {pr}')
    else:
        ok(f'{d}: metadata.json')


# ---- 3. the lists install.sh reads -----------------------------------------------------------------------------------------------------
def read_list(name):
    p = os.path.join(REPO, 'settings', name)
    if not os.path.isfile(p):
        bad(f'settings/{name} is missing')
        return []
    with open(p, encoding='utf-8') as fh:
        return [ln.strip() for ln in fh if ln.strip()]


enabled = read_list('extensions.txt')
conflicts = read_list('conflicts.txt')
if enabled:
    dupes = sorted({u for u in enabled if enabled.count(u) > 1})
    if dupes:
        bad(f'settings/extensions.txt lists {dupes} more than once')
    missing = sorted(set(enabled) - set(dirs))
    extra = sorted(set(dirs) - set(enabled))
    if missing:
        bad(f'settings/extensions.txt names extensions that are not in extensions/: {missing}')
    if extra:
        bad(f'extensions/ has folders that settings/extensions.txt never enables: {extra}')
    if not dupes and not missing and not extra:
        ok(f'settings/extensions.txt and extensions/ list the same {len(enabled)} extensions')
if conflicts:
    both = sorted(set(conflicts) & set(enabled))
    if both:
        bad(f'settings/conflicts.txt and extensions.txt both list {both}')
    else:
        ok(f'settings/conflicts.txt: {len(conflicts)} extensions that Vitre turns off, none of them enabled by Vitre')

# ---- 4. version ----------------------------------------------------------------------------------------------------------------------
vp = os.path.join(REPO, 'VERSION')
if os.path.isfile(vp):
    version = open(vp, encoding='utf-8').read().strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+([-+.][0-9A-Za-z.]+)?', version):
        bad(f'VERSION "{version}" is not a version number')
    else:
        cp = os.path.join(REPO, 'CHANGELOG.md')
        if os.path.isfile(cp) and re.search(r'^#+\s*' + re.escape(version) + r'\b', open(cp, encoding='utf-8').read(), re.M):
            ok(f'VERSION {version} has a CHANGELOG.md entry')
        else:
            bad(f'CHANGELOG.md has no heading for VERSION {version}')
else:
    bad('VERSION is missing')

print(f'check-metadata: {checks} checks, {fails} failed')
sys.exit(1 if fails else 0)

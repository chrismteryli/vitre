#!/usr/bin/env python3
"""check-distro.py [--stage] [--fix-sums]

The checks that can run on a Debian or Ubuntu machine, where there is no rpmbuild, rpmspec, makepkg or pacman. Run it as
    python3 -I check-distro.py            quick checks (a few seconds, no big copies)
    python3 -I check-distro.py --stage    also stage the real tree (about 15 s, about 400 MB of scratch space under $TMPDIR or /tmp),
                                          simulate the spec's %build/%install and the PKGBUILD's build()/package_*(), and check the
                                          %files lists against what was staged. With the .debs of the author's workspace (release/native/dist)
                                          at hand it also compares every file with them.
    python3 -I check-distro.py --fix-sums rewrite the sha256sums of the LOCAL sources in arch/PKGBUILD and regenerate arch/.SRCINFO

Where it finds things (all can be set in the environment):
    VITRE_SRC           the Vitre tree to stage. Default: the folder above this one when this folder sits in a Vitre checkout (packaging/),
                        else ../vitre (the author's release workspace, where this folder is release/distro).
    VITRE_NATIVE        release/native of the author's workspace (the .debs' sources and the origin of common/). Optional: without it the
                        comparison with the .debs and the refresh of common/ are skipped.
    MACTAHOE_ICON_THEME a checkout of MacTahoe-icon-theme (any commit; --stage only). Default: a folder of that name beside or above this tree.

What it does NOT do (needs a real Fedora or Arch machine, see the READMEs): run rpm's own spec parser or macro engine, rpmlint, mock,
makepkg, namcap, or install anything. It writes nothing into the Vitre tree it stages.
"""
import hashlib, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
SPEC = os.path.join(HERE, 'fedora', 'vitre.spec')
PKGBUILD = os.path.join(HERE, 'arch', 'PKGBUILD')


def find_up(name, marker, start, levels=5):
    """The folder `name` (holding `marker`) beside `start` or one of its parents, else None."""
    d = start
    for _ in range(levels):
        c = os.path.join(d, name)
        if os.path.exists(os.path.join(c, marker)):
            return c
        d = os.path.dirname(d)
    return None


def is_vitre_tree(d):
    return os.path.isfile(os.path.join(d, 'install.sh')) and os.path.isdir(os.path.join(d, 'extensions'))


# the Vitre tree: the checkout this folder lives in (packaging/ is next to install.sh), else release/vitre beside release/distro
VITRE_SRC = os.environ.get('VITRE_SRC') or (PARENT if is_vitre_tree(PARENT) else os.path.join(PARENT, 'vitre'))
NATIVE = os.environ.get('VITRE_NATIVE') or find_up('native', 'session/usr/bin/vitre-session', PARENT)      # None in a plain checkout
MACTAHOE = os.environ.get('MACTAHOE_ICON_THEME') or find_up('MacTahoe-icon-theme', 'install.sh', PARENT)   # None: --stage cannot run
PACKAGES = ['vitre-desktop', 'vitre-session', 'vitre-shell', 'vitre-shell-extras', 'vitre-theme', 'vitre-icons', 'vitre-icons-base',
            'vitre-cursor', 'vitre-backgrounds', 'vitre-system']

fails = 0
def ok(msg): print('  ok   ' + msg)
def bad(msg):
    global fails
    fails += 1
    print('  FAIL ' + msg)
def check(cond, msg):
    (ok if cond else bad)(msg)
def run(cmd, **kw):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **kw)
def sha256(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()
def text(p):
    return open(p, encoding='utf-8').read()

# ------------------------------------------------------------------------------------------------------------------------------
def syntax_checks():
    print('shell and python syntax')
    shells = [os.path.join(HERE, p) for p in ('sync-common.sh', 'gen-srcinfo.sh', 'common/vitre-stage.sh', 'common/vitre-session',
                                              'common/vitre-user-setup', 'arch/PKGBUILD', 'arch/vitre-session.install',
                                              'arch/vitre-system.install')]
    for p in shells:
        r = run(['bash', '-n', p])
        check(r.returncode == 0, 'bash -n ' + os.path.relpath(p, HERE) + ('' if r.returncode == 0 else '\n' + r.stdout))
    for p in ('common/vitre-session', 'common/vitre-user-setup'):
        if os.path.exists('/bin/dash') or os.path.exists('/usr/bin/dash'):
            r = run(['dash', '-n', os.path.join(HERE, p)])
            check(r.returncode == 0, 'dash -n ' + p + ' (POSIX sh, what the shebang says)')
    for p in ('make-mode.py', 'make-parity.py', 'make-defaults.py', 'sanitize-staged.py'):
        try:
            compile(text(os.path.join(HERE, 'common', p)), p, 'exec')
            ok('python parses common/' + p)
        except SyntaxError as e:
            bad('python syntax common/' + p + ': ' + str(e))
    r = run(['bash', os.path.join(HERE, 'sync-common.sh'), '--check'], env=dict(os.environ, VITRE_NATIVE=NATIVE or ''))
    check(r.returncode == 0, 'sync-common.sh --check (' + ('common/ = release/native; ' if NATIVE else '') + 'fedora/ and arch/ = common/)' + ('' if r.returncode == 0 else '\n' + r.stdout))

# ------------------------------------------------------------------------------------------------------------------------------
def parse_spec():
    s = text(SPEC)
    macros = {'name': 'vitre', 'version': re.search(r'^Version:\s*(\S+)', s, re.M).group(1), 'release': '1', 'dist': '',
              '_datadir': '/usr/share', '_bindir': '/usr/bin', '_prefix': '/usr', '_sysconfdir': '/etc', '_docdir': '/usr/share/doc',
              '_defaultlicensedir': '/usr/share/licenses', 'nil': '', '_sourcedir': '@SOURCEDIR@', 'buildroot': '@BUILDROOT@'}
    for m in re.finditer(r'^%global\s+(\w+)\s+(\S+)', s, re.M):
        macros[m.group(1)] = m.group(2)
    macros['url'] = re.search(r'^URL:\s*(\S+)', s, re.M).group(1)
    return s, macros

def expand(t, macros):
    t = re.sub(r'%\{\?(\w+)\}', lambda m: macros.get(m.group(1), ''), t)
    t = re.sub(r'%\{(\w+)\}', lambda m: macros[m.group(1)] if m.group(1) in macros else m.group(0), t)
    return t.replace('%%', '%')

SECTION = re.compile(r'^%(package|description|prep|build|install|check|files|pre|post|preun|postun|trigger\w*|changelog)\b(.*)$')

def sections(spec):
    """-> list of (kind, argument string, body lines). Lines before the first section belong to ('preamble', '', ...)."""
    out, cur = [], ['preamble', '', []]
    for line in spec.splitlines():
        m = SECTION.match(line)
        if m:
            out.append(cur)
            cur = [m.group(1), m.group(2).strip(), []]
        else:
            cur[2].append(line)
    out.append(cur)
    return out

def spec_checks():
    print('fedora/vitre.spec (static; rpmspec is not available here)')
    spec, macros = parse_spec()
    secs = sections(spec)
    pk = [s[1].split()[-1] for s in secs if s[0] == 'package']
    check(pk == PACKAGES, 'subpackages in the spec = the ten .deb names, in the same order')
    for kind in ('description', 'files'):
        names = [re.sub(r'^-n\s+', '', s[1]).split()[0] for s in secs if s[0] == kind and s[1].startswith('-n')]
        check(sorted(names) == sorted(PACKAGES), '%' + kind + ' -n exists for every subpackage and nothing else')
    check(not any(s[0] == 'files' and not s[1].startswith('-n') for s in secs), 'no %files for the main package (no binary "vitre" package)')
    for s in secs:
        if s[0] in ('pre', 'post', 'preun', 'postun'):
            check(s[1].split()[-1] in PACKAGES, '%' + s[0] + ' ' + s[1] + ' names a subpackage')
    # sources
    srcs = re.findall(r'^Source(\d+):\s*(\S+)', spec, re.M)
    local = [v for k, v in srcs if '://' not in v and not v.startswith('%{url}')]
    for v in local:
        check(os.path.isfile(os.path.join(HERE, 'fedora', v)), 'Source file present next to the spec: ' + v)
    others = sorted(set(os.listdir(os.path.join(HERE, 'fedora'))) - set(local) - {'vitre.spec', 'README.md'})
    check(not others, 'every file in fedora/ is a Source or the spec/README' + (' (extra: %s)' % others if others else ''))
    nums = [int(k) for k, v in srcs]
    check(len(nums) == len(set(nums)), 'Source numbers are unique')
    # macros: anything left after expansion that is not a known rpm builtin
    known = {'autosetup', 'license', 'dir', 'ghost', 'config', 'doc', 'global', 'description', 'package', 'prep', 'build', 'install', 'files',
             'post', 'postun', 'preun', 'changelog', 'defattr'}
    leftover = set()
    for s in secs:
        if s[0] == 'preamble' and False:
            continue
        for line in s[2]:
            if line.lstrip().startswith('#'):
                # a comment line is still macro-expanded by rpm: only %% is safe
                if re.search(r'(?<!%)%(?!%)[\w{(?]', re.sub(r'%%', '', line)):
                    bad('unescaped % in a comment (rpm expands it): ' + line.strip()[:90])
                continue
            for m in re.finditer(r'%\{\??(\w+)\}', line):
                if m.group(1) not in macros and m.group(1) not in ('?dist',):
                    leftover.add(m.group(1))
    check(not leftover, 'every %{macro} used is defined here or is a plain rpm macro' + (' (unknown: %s)' % sorted(leftover) if leftover else ''))
    # dependency sanity: Requires on vitre-* packages are subpackages
    for m in re.finditer(r'^(?:Requires|Recommends|Suggests):\s*(vitre-[\w-]+)', spec, re.M):
        if m.group(1) not in PACKAGES:
            bad('dependency on a vitre package that this spec does not build: ' + m.group(1))
    ok('all vitre-* dependencies are subpackages of this spec')
    # scriptlets: POSIX sh syntax
    for s in secs:
        if s[0] in ('pre', 'post', 'preun', 'postun'):
            body = expand('\n'.join(s[2]), macros)
            r = run(['sh', '-n'], input=body) if False else subprocess.run(['sh', '-n'], input=body, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            check(r.returncode == 0, 'sh -n on %' + s[0] + ' ' + s[1] + ('' if r.returncode == 0 else '\n' + r.stdout))
    for k in ('Name', 'Version', 'Release', 'Summary', 'License', 'URL', 'BuildArch'):
        check(re.search(r'^' + k + r':', spec, re.M) is not None, 'preamble has ' + k)
    m = re.search(r'\* (\w{3}) (\w{3}) (\d+) (\d{4})', spec)
    import datetime
    d = datetime.datetime.strptime(' '.join(m.groups()[1:]), '%b %d %Y')
    check(d.strftime('%a') == m.group(1), 'changelog weekday matches the date (%s)' % m.group(0))
    return spec, macros, secs

def arch_checks():
    print('arch/PKGBUILD (static; makepkg and namcap are not available here)')
    pb = text(PKGBUILD)
    r = run(['bash', '-c', 'source "$1"; printf "%s\\n" "${pkgname[@]}"', 'x', PKGBUILD])
    names = r.stdout.split()
    check(names == PACKAGES, 'pkgname = the ten .deb names, same order as the spec')
    for n in PACKAGES:
        check(re.search(r'^package_' + re.escape(n) + r'\(\) \{', pb, re.M) is not None, 'package_' + n + '() exists')
    r = run(['bash', '-c', 'source "$1"; printf "%s\\n" "${source[@]}"', 'x', PKGBUILD])
    srcs = r.stdout.split()
    local = [s for s in srcs if '://' not in s]
    r = run(['bash', '-c', 'source "$1"; printf "%s\\n" "${sha256sums[@]}"', 'x', PKGBUILD])
    sums = r.stdout.split()
    check(len(sums) == len(srcs), 'sha256sums has one entry per source (%d)' % len(srcs))
    for s, c in zip(srcs, sums):
        if '://' in s:
            continue
        p = os.path.join(HERE, 'arch', s)
        check(os.path.isfile(p) and sha256(p) == c, 'sha256 of local source ' + s)
    others = sorted(set(os.listdir(os.path.join(HERE, 'arch'))) - set(local) - {'PKGBUILD', '.SRCINFO', 'README.md', 'vitre-session.install',
                                                                                  'vitre-system.install'})
    check(not others, 'every file in arch/ is a source, an .install, PKGBUILD, .SRCINFO or README' + (' (extra: %s)' % others if others else ''))
    for inst in re.findall(r'^\s*install=(\S+)', pb, re.M):
        check(os.path.isfile(os.path.join(HERE, 'arch', inst)), 'install script present: ' + inst)
    # the two packagings must take the same local files
    spec_local = [v for k, v in re.findall(r'^Source(\d+):\s*(\S+)', text(SPEC), re.M) if '://' not in v and not v.startswith('%{url}')]
    check(sorted(spec_local) == sorted(local), 'spec and PKGBUILD use the same local source files')
    check("'gnome-shell>=1:51'" in pb and "'gnome-shell<1:52'" in pb and 'gnome-shell>=51' not in pb, 'gnome-shell ranges carry the Arch epoch (1:)')
    r = run(['bash', os.path.join(HERE, 'gen-srcinfo.sh'), PKGBUILD])
    cur = text(os.path.join(HERE, 'arch', '.SRCINFO')) if os.path.exists(os.path.join(HERE, 'arch', '.SRCINFO')) else ''
    check(r.returncode == 0 and r.stdout == cur, 'arch/.SRCINFO matches gen-srcinfo.sh output (makepkg --printsrcinfo is not available)')

def fix_sums():
    """Local sources get their sha256 recomputed; the sums of remote sources (the GitHub tag archive, MacTahoe) are kept as they are."""
    pb = text(PKGBUILD)
    r = run(['bash', '-c', 'source "$1"; printf "%s\\n" "${source[@]}"', 'x', PKGBUILD])
    srcs = r.stdout.split()
    r = run(['bash', '-c', 'source "$1"; printf "%s\\n" "${sha256sums[@]}"', 'x', PKGBUILD])
    old = r.stdout.split()
    new = []
    for i, s in enumerate(srcs):
        if '://' in s:
            new.append(old[i] if i < len(old) else 'SKIP')
        else:
            new.append(sha256(os.path.join(HERE, 'arch', s)))
    block = "sha256sums=(" + "\n            ".join("'%s'" % c for c in new) + ")"
    pb2 = re.sub(r"sha256sums=\(.*?\)\n", block + "\n", pb, count=1, flags=re.S)
    open(PKGBUILD, 'w').write(pb2)
    out = run(['bash', os.path.join(HERE, 'gen-srcinfo.sh'), PKGBUILD]).stdout
    open(os.path.join(HERE, 'arch', '.SRCINFO'), 'w').write(out)
    print('rewrote the sha256sums of the local sources (remote ones kept) and arch/.SRCINFO')

# ------------------------------------------------------------------------------------------------------------------------------
def tree_files(root):
    out = set()
    for d, dirs, files in os.walk(root):
        for f in files + [x for x in dirs if os.path.islink(os.path.join(d, x))]:
            out.add('/' + os.path.relpath(os.path.join(d, f), root))
    return out

def files_covered(secs, macros, buildroot, lists):
    """%files entries -> {package: (covered file set, missing entries)} against a merged buildroot."""
    allfiles = tree_files(buildroot)
    res = {}
    for kind, arg, body in secs:
        if kind != 'files':
            continue
        pkg = re.sub(r'^-n\s+', '', arg).split()[0]
        entries = []
        m = re.search(r'-f\s+(\S+)', arg)
        if m:
            entries += [l.strip() for l in open(lists[os.path.basename(expand(m.group(1), macros))]) if l.strip()]
        for line in body:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            ghost = line.startswith('%ghost')
            line = re.sub(r'^%(license|doc|dir|ghost|config(\([^)]*\))?)\s+', '', line)
            entries.append(('GHOST:' if ghost else '') + expand(line, macros))
        covered, missing = set(), []
        for e in entries:
            if e.startswith('GHOST:'):
                continue
            p = e.rstrip('/')
            hit = {f for f in allfiles if f == p or f.startswith(p + '/')}
            isdir = os.path.isdir(buildroot + p)
            if not hit and not isdir:
                missing.append(e)
            covered |= hit
        res[pkg] = (covered, missing)
    return res

def keyfile(path):
    """-> {(group, key): value} of a dconf keyfile"""
    out, grp = {}, None
    for line in text(path).splitlines():
        m = re.match(r'^\[(.+)\]$', line)
        if m:
            grp = m.group(1)
        elif grp and '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            out[(grp, k)] = v
    return out

def parity_checks(stagetree):
    print('10-gnome-parity (the counterpart of 10-ubuntu-parity)')
    d = os.path.join(stagetree, 'vitre-session', 'etc', 'dconf', 'db', 'vitre.d')
    gp = keyfile(os.path.join(d, '10-gnome-parity'))
    # common/10-ubuntu-parity is a copy of the .debs' file (sync-common.sh --check keeps it so where release/native is at hand)
    up = keyfile(os.path.join(HERE, 'common', '10-ubuntu-parity'))
    base = keyfile(os.path.join(d, '00-vitre'))
    dropped = {k for k in up if k not in gp}
    check(all(gp[k] == up[k] for k in gp) and set(gp) <= set(up), 'every key of 10-gnome-parity has the value 10-ubuntu-parity gives it (%d keys)' % len(gp))
    check(dropped == {('org/gnome/shell', 'favorite-apps'), ('org/gnome/shell/extensions/ding', 'show-trash'), ('org/gnome/shell/extensions/ding', 'show-volumes'),
                      ('org/gnome/shell/extensions/ding', 'start-corner'), ('org/gnome/shell/extensions/ding', 'arrangeorder'),
                      ('org/gnome/desktop/background', 'show-desktop-icons')},
          'only the Ubuntu-only keys are dropped (favorite-apps, the ding group, show-desktop-icons)')
    for need in (('org/gnome/shell', 'start-in-overview'), ('org/gnome/desktop/interface', 'enable-hot-corners'),
                 ('org/gnome/desktop/peripherals/touchpad', 'tap-to-click'), ('org/gnome/desktop/wm/keybindings', 'switch-windows')):
        check(need in gp, 'kept: %s/%s=%s' % (need[0], need[1], gp.get(need)))
    check(not (set(gp) & set(base)), 'no key is set by both 00-vitre and 10-gnome-parity (so file order cannot matter)')
    check('ubuntu' not in text(os.path.join(d, '10-gnome-parity')).split('\n\n', 1)[1].lower(), 'no Ubuntu value is left in the keys')

def stage_checks(spec, macros, secs):
    if not MACTAHOE:
        bad('--stage needs a checkout of MacTahoe-icon-theme: set MACTAHOE_ICON_THEME=<folder> (any commit; the ref in install.sh is the one packaged)')
        return
    if not is_vitre_tree(VITRE_SRC):
        bad('--stage needs the Vitre tree: %s is not one (set VITRE_SRC=<folder with install.sh and extensions/>)' % VITRE_SRC)
        return
    scratch = tempfile.mkdtemp(prefix='vitre-distro-check-')
    print('staging the real tree in ' + scratch + ' (the vitre-stage.sh both packagings run)')
    try:
        # --- the spec's %build and %install, run as written, with macros expanded -------------------------------------------
        bdir = os.path.join(scratch, 'rpmbuild', 'vitre-0.2.0')      # %{_builddir}/%{name}-%{version}; release/vitre stays untouched
        os.makedirs(bdir)
        for e in os.listdir(VITRE_SRC):
            os.symlink(os.path.join(VITRE_SRC, e), os.path.join(bdir, e))
        os.symlink(MACTAHOE, os.path.join(bdir, 'MacTahoe-icon-theme-' + macros['mactahoe_commit']))
        m = dict(macros)
        m['_sourcedir'] = os.path.join(HERE, 'fedora')
        m['buildroot'] = os.path.join(scratch, 'buildroot')
        script = '\n'.join(expand('\n'.join(s[2]), m) for s in secs if s[0] in ('build', 'install'))
        env = dict(os.environ, SOURCE_DATE_EPOCH='1792627200')
        r = subprocess.run(['bash', '-euo', 'pipefail', '-c', script], cwd=bdir, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        check(r.returncode == 0, 'spec %build + %install run to the end' + ('' if r.returncode == 0 else '\n' + r.stdout[-1500:]))
        if r.returncode != 0:
            return
        lists = {f: os.path.join(bdir, f) for f in os.listdir(bdir) if f.endswith('.files')}
        res = files_covered(secs, m, m['buildroot'], lists)
        stagetree = os.path.join(bdir, 'stage')
        allcovered = {}
        for pkg in PACKAGES:
            covered, missing = res[pkg]
            check(not missing, '%files of ' + pkg + ': every entry exists in the buildroot' + (' (missing %s)' % missing if missing else ''))
            want = tree_files(os.path.join(stagetree, pkg))
            check(covered == want, '%files of ' + pkg + ' = exactly the staged files (%d)%s' % (len(want), '' if covered == want else
                  ' unpackaged %s extra %s' % (sorted(want - covered)[:3], sorted(covered - want)[:3])))
            for f in covered:
                allcovered.setdefault(f, []).append(pkg)
        dup = {f: p for f, p in allcovered.items() if len(p) > 1}
        check(not dup, 'no file is in two packages' + (' (e.g. %s)' % list(dup.items())[:2] if dup else ''))
        unpackaged = tree_files(m['buildroot']) - set(allcovered)
        check(not unpackaged, 'no installed-but-unpackaged files (rpmbuild check-files)' + (' e.g. %s' % sorted(unpackaged)[:3] if unpackaged else ''))

        # --- the PKGBUILD's build() and package_*(), run as makepkg would (srcdir/pkgdir, no fakeroot) ----------------------
        sd = os.path.join(scratch, 'makepkg', 'src')
        os.makedirs(sd)
        os.symlink(VITRE_SRC, os.path.join(sd, 'vitre-0.2.0'))
        mt = re.search(r'^_mactahoe=(\w+)', text(PKGBUILD), re.M).group(1)
        os.symlink(MACTAHOE, os.path.join(sd, 'MacTahoe-icon-theme-' + mt))
        for f in os.listdir(os.path.join(HERE, 'arch')):
            if f not in ('PKGBUILD', '.SRCINFO', 'README.md') and not f.endswith('.install'):
                os.symlink(os.path.join(HERE, 'arch', f), os.path.join(sd, f))
        pk = os.path.join(scratch, 'makepkg', 'pkg')
        calls = 'srcdir="%s"\nstartdir="%s"\nsource "%s"\nbuild\n' % (sd, os.path.dirname(sd), PKGBUILD)
        for n in PACKAGES:
            calls += 'pkgdir="%s/%s"; mkdir -p "$pkgdir"; package_%s\n' % (pk, n, n)
        r = subprocess.run(['bash', '-euo', 'pipefail', '-c', calls], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        check(r.returncode == 0, 'PKGBUILD build() + ten package_*() run to the end' + ('' if r.returncode == 0 else '\n' + r.stdout[-1500:]))
        if r.returncode == 0:
            same = all(tree_files(os.path.join(pk, n)) == tree_files(os.path.join(stagetree, n)) for n in PACKAGES)
            check(same, 'PKGBUILD packages have the same file lists as the spec packages')
            d = run(['diff', '-rq', os.path.join(pk, 'vitre-session'), os.path.join(stagetree, 'vitre-session')])
            check(d.returncode == 0, 'PKGBUILD and spec session package are byte-identical')

        # --- compare with the .debs ------------------------------------------------------------------------------------------
        dist = os.path.join(NATIVE or '/nonexistent', 'dist')
        debs = {p: os.path.join(dist, '%s_0.2.0-1_all.deb' % p) for p in PACKAGES}
        if shutil.which('dpkg-deb') and all(os.path.exists(v) for v in debs.values()):
            expected = {  # the deliberate differences from the .debs, per package (relative paths in the .deb)
                'vitre-session': {'etc/dconf/db/vitre.d/10-ubuntu-parity', 'etc/dconf/db/vitre.d/10-gnome-parity',
                                  'usr/share/gnome-shell/modes/vitre.json',
                                  'usr/lib/systemd/user/vitre-user-setup.service', 'usr/share/vitre'},
                'vitre-theme': {'usr/share/gnome-shell'},      # the two session shell-theme resources (Yaru based, Ubuntu only)
                'vitre-system': {'usr/share/gnome-shell'},     # the login screen theme (no gdm-theme.gresource alternative on Fedora/Arch)
            }
            for p in PACKAGES:
                dx = os.path.join(scratch, 'deb-' + p)
                os.makedirs(dx)
                run(['dpkg-deb', '-x', debs[p], dx])
                out = run(['diff', '-rq', dx, os.path.join(stagetree, p)]).stdout.splitlines()
                diffs = set()
                for line in out:
                    mm = re.match(r'Only in (\S+): (.*)', line)
                    if mm:
                        d_, n_ = mm.groups()
                        base = dx if d_.startswith(dx) else os.path.join(stagetree, p)
                        diffs.add(os.path.relpath(os.path.join(d_, n_), base))
                        continue
                    mm = re.match(r'Files (\S+) and (\S+) differ', line)
                    if mm:
                        diffs.add(os.path.relpath(mm.group(1), dx))
                unexpected = {d for d in diffs if not (d.startswith('usr/share/doc') or d.startswith('usr/share/licenses') or
                              any(d == e or d.startswith(e + '/') for e in expected.get(p, ())))}
                check(not unexpected, p + ' = the .deb, file for file and byte for byte, except the listed differences' +
                      (' (unexpected: %s)' % sorted(unexpected)[:5] if unexpected else ''))
        else:
            print('  skip comparison with the .debs (dpkg-deb, or release/native/dist from the author\'s workspace, missing)')
        parity_checks(stagetree)
        scriptlet_tests(scratch, secs, macros)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

# ------------------------------------------------------------------------------------------------------------------------------
STUBS = {
    # logs every call; "plymouth-set-default-theme" keeps its state in $T/plymouth-theme like the real one keeps plymouthd.conf
    'dconf': 'echo "dconf $*" >> "$T/calls.log"\n',
    'gtk-update-icon-cache': 'echo "gtk-update-icon-cache $*" >> "$T/calls.log"\n',
    'mkinitcpio': 'echo "mkinitcpio $*" >> "$T/calls.log"\n',
    'plymouth-set-default-theme': '''
rebuild=0; reset=0; theme=""
for a in "$@"; do case "$a" in -R) rebuild=1 ;; --reset) reset=1 ;; *) theme="$a" ;; esac; done
if [ -n "$theme" ]; then echo "$theme" > "$T/plymouth-theme"; echo "plymouth-set-default-theme $theme" >> "$T/calls.log"
elif [ "$reset" = 1 ]; then echo spinner > "$T/plymouth-theme"; echo "plymouth-set-default-theme --reset" >> "$T/calls.log"
else cat "$T/plymouth-theme"; fi
[ "$rebuild" = 1 ] && echo "REBUILD" >> "$T/calls.log"
exit 0
''',
}

def sandbox(t, root):
    """Point the absolute paths of a scriptlet into a scratch root."""
    for p in ('/etc/', '/var/lib/', '/usr/share/'):
        t = t.replace(p, root + p)
    return t

def scriptlet_tests(scratch, secs, macros):
    print('scriptlets, run against stubs in a scratch root (nothing outside it is touched)')
    T = os.path.join(scratch, 'sandbox')
    os.makedirs(os.path.join(T, 'bin'))
    for name, body in STUBS.items():
        p = os.path.join(T, 'bin', name)
        open(p, 'w').write('#!/bin/sh\n' + body)
        os.chmod(p, 0o755)
    env = dict(os.environ, PATH=os.path.join(T, 'bin') + ':' + os.environ['PATH'], T=T)

    def reset():
        shutil.rmtree(os.path.join(T, 'etc'), ignore_errors=True)
        shutil.rmtree(os.path.join(T, 'var'), ignore_errors=True)
        shutil.rmtree(os.path.join(T, 'usr'), ignore_errors=True)
        for d in ('etc/dconf/db', 'var/lib', 'usr/share/plymouth/themes/spinner', 'usr/share/plymouth/themes/bgrt', 'usr/share/plymouth/themes/vitre',
                  'usr/share/icons/hicolor'):
            os.makedirs(os.path.join(T, d))
        open(os.path.join(T, 'calls.log'), 'w').close()
        open(os.path.join(T, 'plymouth-theme'), 'w').write('bgrt\n')

    def calls():
        return text(os.path.join(T, 'calls.log'))

    def rpm(kind, pkg, arg):
        body = [s[2] for s in secs if s[0] == kind and s[1].split()[-1] == pkg][0]
        script = sandbox(expand('\n'.join(body), macros), T)
        r = subprocess.run(['sh', '-c', script, 'scriptlet', str(arg)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        return r.returncode, r.stdout

    # vitre-session: admin databases
    reset()
    rc, _ = rpm('post', 'vitre-session', 1)
    note = os.path.join(T, 'etc/dconf/db/local.d/README.vitre')
    check(rc == 0 and os.path.isfile(note) and os.path.isfile(os.path.join(T, 'etc/dconf/db/site.d/README.vitre')) and 'dconf update' in calls(),
          'spec %post vitre-session: makes empty local.d and site.d with a note, runs dconf update')
    check('"local" database' in text(note), 'the note names its database (the heredoc expanded $name)')
    os.makedirs(os.path.join(T, 'etc/dconf/db/local.d'), exist_ok=True)
    open(os.path.join(T, 'etc/dconf/db/local.d/50-mine'), 'w').write('x\n')
    rpm('postun', 'vitre-session', 0)
    check(os.path.isfile(os.path.join(T, 'etc/dconf/db/local.d/50-mine')), 'spec %postun: an administrator folder with their own file is kept')
    check(not os.path.exists(os.path.join(T, 'etc/dconf/db/site.d')), 'spec %postun: the untouched empty site.d goes again')
    reset()
    os.makedirs(os.path.join(T, 'etc/dconf/db/local'))     # an administrator's compiled database already exists
    rpm('post', 'vitre-session', 1)
    check(not os.path.exists(os.path.join(T, 'etc/dconf/db/local.d')) and os.path.isfile(os.path.join(T, 'etc/dconf/db/site.d/README.vitre')),
          'spec %post: an existing "local" database is never touched, a missing "site" is made')
    # vitre-system: install, upgrade, remove
    reset()
    rpm('post', 'vitre-system', 1)
    check(text(os.path.join(T, 'plymouth-theme')).strip() == 'vitre' and 'REBUILD' in calls() and
          text(os.path.join(T, 'var/lib/vitre/plymouth-previous-theme')).strip() == 'bgrt', 'spec vitre-system install: previous theme remembered (bgrt), Vitre selected, initramfs rebuilt')
    open(os.path.join(T, 'calls.log'), 'w').close()
    rpm('post', 'vitre-system', 2)
    check('REBUILD' in calls(), 'spec vitre-system upgrade while selected: rebuilt')
    open(os.path.join(T, 'calls.log'), 'w').close()
    rpm('preun', 'vitre-system', 1)
    check(text(os.path.join(T, 'plymouth-theme')).strip() == 'vitre' and not calls(), 'spec vitre-system %preun during an upgrade: nothing changes')
    rpm('preun', 'vitre-system', 0)
    check(text(os.path.join(T, 'plymouth-theme')).strip() == 'bgrt' and 'REBUILD' in calls() and not os.path.exists(os.path.join(T, 'var/lib/vitre')),
          'spec vitre-system remove: previous theme (bgrt) back, initramfs rebuilt, state removed')
    reset()
    rpm('post', 'vitre-system', 1)
    open(os.path.join(T, 'plymouth-theme'), 'w').write('spinner\n')       # the administrator chose another splash meanwhile
    open(os.path.join(T, 'calls.log'), 'w').close()
    rpm('preun', 'vitre-system', 0)
    check(text(os.path.join(T, 'plymouth-theme')).strip() == 'spinner' and 'REBUILD' not in calls(), 'spec vitre-system remove: a splash the administrator chose since is left alone')
    # icons
    reset()
    rc, _ = rpm('post', 'vitre-icons-base', 1)
    check(rc == 0 and calls().count('gtk-update-icon-cache') == 3, 'spec %post vitre-icons-base: three icon caches')

    # the same for the Arch .install files
    def arch(script, fn, *args):
        src = sandbox(text(os.path.join(HERE, 'arch', script)), T)
        r = subprocess.run(['bash', '-c', src + '\n' + fn + ' "$@"', 'install', *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        return r.returncode, r.stdout
    reset()
    rc, out = arch('vitre-session.install', 'post_install', '0.2.0-1')
    check(rc == 0 and os.path.isfile(os.path.join(T, 'etc/dconf/db/site.d/README.vitre')) and 'dconf update' in calls(), 'arch vitre-session.install post_install')
    arch('vitre-session.install', 'post_remove', '0.2.0-1')
    check(not os.path.exists(os.path.join(T, 'etc/dconf/db/site.d')) and not os.path.exists(os.path.join(T, 'etc/dconf/db/local.d')), 'arch vitre-session.install post_remove')
    reset()
    open(os.path.join(T, 'etc/mkinitcpio.conf'), 'w').write('HOOKS=(base udev autodetect modconf kms keyboard keymap block filesystems fsck)\n')
    rc, out = arch('vitre-system.install', 'post_install', '0.2.0-1')
    check(text(os.path.join(T, 'plymouth-theme')).strip() == 'vitre' and 'mkinitcpio' not in calls() and 'plymouth hook is not in HOOKS' in out,
          'arch vitre-system.install post_install without the plymouth hook: theme set, no rebuild, tells the user what to add')
    reset()
    open(os.path.join(T, 'etc/mkinitcpio.conf'), 'w').write('HOOKS=(base udev plymouth autodetect modconf kms block filesystems fsck)\n')
    arch('vitre-system.install', 'post_install', '0.2.0-1')
    check(text(os.path.join(T, 'plymouth-theme')).strip() == 'vitre' and 'mkinitcpio -P' in calls(), 'arch vitre-system.install post_install with the hook: theme set, mkinitcpio -P')
    arch('vitre-system.install', 'pre_remove', '0.2.0-1')
    check(text(os.path.join(T, 'plymouth-theme')).strip() == 'bgrt' and not os.path.exists(os.path.join(T, 'var/lib/vitre')), 'arch vitre-system.install pre_remove: previous theme back')

# ------------------------------------------------------------------------------------------------------------------------------
if __name__ == '__main__':
    args = sys.argv[1:]
    if '--fix-sums' in args:
        fix_sums()
    syntax_checks()
    spec, macros, secs = spec_checks()
    arch_checks()
    if '--stage' in args:
        stage_checks(spec, macros, secs)
    print('\n%s' % ('all checks passed' if not fails else '%d check(s) FAILED' % fails))
    sys.exit(1 if fails else 0)

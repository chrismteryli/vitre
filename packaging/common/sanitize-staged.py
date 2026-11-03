#!/usr/bin/env python3
"""sanitize-staged.py STAGE_DIR
Rewrites the comments of the files that Vitre itself wrote (the vitre-* extensions, the GTK 4 window layer, the shell theme source)
so that no person's name, no quoted feedback and no internal ticket tag (B14, B15 ...) ships. Code is never touched: every rule below
matches comment text only, and tools/scan-banned.py is the backstop (the build fails if a name or tag is left).
Third-party extensions and licence files are not touched.
Usage: sanitize-staged.py STAGE_DIR [--check]   (--check only reports how many rules would fire)
       sanitize-staged.py --files FILE...        (the same rules on single files, e.g. the shell stylesheet copy)"""
import os, re, sys

OWN_DIRS = ('vitre-shell/usr/share/gnome-shell/extensions/', 'vitre-theme/usr/share/vitre/', 'vitre-theme/usr/share/themes/Vitre-Glass/gnome-shell/',
            # Vitre Dock: only Vitre's own patch comments ("Vitre (B19 ...)") match the rules below; Dhruva's prose is left as it is
            'vitre-shell-extras/usr/share/gnome-shell/extensions/vitre-dock@vitre-desktop/')
EXT = ('.js', '.css', '.json', '.xml', '.in', '.txt', '.md')

# The author's first name is never written here: a private build passes it as VITRE_SANITIZE_OWNER. Public builds leave it
# unset; their inputs already pass the build's name check, so the name rules have nothing to remove.
OWNER = re.escape(os.environ.get('VITRE_SANITIZE_OWNER', '').strip()) or r'(?!x)x'

# (pattern, replacement, flags); applied in order, to the whole file text
RULES = [
    # "B21 (Name 2026-10-15, from the lab: ...): 'stretch' = ..." at the start of a comment line -> keep the sentence that follows
    (r'(?m)^(\s*(?://|\*|/\*)?\s*)B\d+ \(' + OWNER + r'[^()]*\):\s*', r'\1', 0),
    # "(B19, Name 2026-10-15: "quoted feedback")" anywhere
    (r'\s*\((?:B\d+,\s*)?' + OWNER + r'\b[^()]*\)', '', 0),
    # "The story (Name, 2026-10-12, logo concept A ...)"
    (r'\(' + OWNER + r', \d{4}-\d{2}-\d{2}, ', '(', 0),
    # "..., picked by Name 2026-10-12)"
    (r', picked by ' + OWNER + r' \d{4}-\d{2}-\d{2}\)', ')', 0),
    (r'Motion \(' + OWNER + r'\'s pick, "[^"]*"\)', 'Motion', 0),
    (OWNER + r"'s own design", "Vitre's own design", 0),
    (r"Stage swaps he likes", "Stage swaps", 0),
    (r"\(his Files screenshot: \"days ago\" behind New Folder\)", '(seen in the Files window: "days ago" behind New Folder)', 0),
    # the shapes release/build.py leaves after it removed the name: "B21 (2026-10-15, from the morph lab: ...): 'stretch' = ..." at the
    # start of a comment line, "(B19, 2026-10-15)" anywhere, and the Dock's "Vitre (B25): ..." / "Vitre (B19, ported ...): ..."
    (r'(?m)^(\s*(?://|\*|/\*)?\s*)B\d+ \(\d{4}-\d{2}-\d{2}[^()]*\):\s*', r'\1', 0),
    (r'\s*\(B\d+, \d{4}-\d{2}-\d{2}\)', '', 0),
    (r'\bVitre \(B\d+\): ', 'Vitre: ', 0),
    (r'\bVitre \(B\d+, ', 'Vitre (', 0),
    # internal ticket tags in comments
    (r'\s*\(B\d+\)', '', 0),
    (r'(?m)((?://|\*)\s+)B\d+: ', r'\1', 0),
    (r'\(B\d+: ', '(', 0),
    (r', B\d+\)', ')', 0),
    (r' B\d+\)', ')', 0),
    (r'\bB8 tried\b', 'an earlier build tried', 0),
    (r'; B\d+: ', '; ', 0),
    (r'in his live swipes', 'in live swipes', 0),
    (r'---- B\d+ \(\d{4}-\d{2}-\d{2}\): ', '---- ', 0),
]


# Vendor words in comment lines and notes that the staged third-party folders and the theme notice carry. Exact text, comments only (no
# code changes); each is applied where the file exists, and a line that is neither in its old nor its new form is reported, so a
# changed upstream file is noticed. Dhruva's stored setting value 'macos' (a zoom style it migrates to 'fluid') is code and stays.
EXACT = [
    ('vitre-theme/usr/share/themes/Vitre-Glass/NOTICE.txt',
     'lines that named macOS features) and three shell assets that drew Apple art were replaced with Vitre art',
     "lines that named another platform's features) and three shell assets that drew another company's art were replaced with Vitre art"),
    ('vitre-shell-extras/usr/share/gnome-shell/extensions/liquid-glass@thinkingcoding1231.gmail.com/dist/animation/menuSpring.js',
     '// A16: macOS menus appear nearly full size with a quick fade, not a zoom from 20%.',
     '// Menus appear nearly full size with a quick fade, not a zoom from 20%.'),
    ('vitre-shell-extras/usr/share/gnome-shell/extensions/liquid-glass@thinkingcoding1231.gmail.com/shaders/glass.frag',
     '// same lens from the same settings, as on macOS. A glass too small to hold',
     '// same lens from the same settings, as in the reference design. A glass too small to hold'),
    ('vitre-shell-extras/usr/share/gnome-shell/extensions/liquid-glass@thinkingcoding1231.gmail.com/shaders/glass.frag',
     '// The inner shadow falls where the rim light does not, as on macOS. With',
     '// The inner shadow falls where the rim light does not, as in the reference design. With'),
]


def apply_exact(stage):
    n = 0
    for rel, old, new in EXACT:
        p = os.path.join(stage, rel)
        if not os.path.isfile(p):
            continue
        t = open(p, encoding='utf-8').read()
        if old in t:
            open(p, 'w', encoding='utf-8').write(t.replace(old, new))
            n += 1
        elif new not in t:
            print(f'sanitize-staged: note: {rel} no longer has the line this rule rewrites; check it by hand', file=sys.stderr)
    return n


def clean_text(t):
    for pat, rep, fl in RULES:
        t = re.sub(pat, rep, t, flags=fl)
    return t


def main():
    if sys.argv[1] == '--files':
        n = 0
        for p in sys.argv[2:]:
            t = open(p, encoding='utf-8').read()
            t2 = clean_text(t)
            if t2 != t:
                n += 1
                open(p, 'w', encoding='utf-8').write(t2)
        print(f'sanitize-staged: {n} file(s) rewritten')
        return
    stage = sys.argv[1]
    check = '--check' in sys.argv[2:]
    changed = 0
    for sub in OWN_DIRS:
        for d, _dirs, files in os.walk(os.path.join(stage, sub)):
            # third-party extensions never live under vitre-shell/, but the guard costs nothing
            if '@vitre-desktop' not in d and sub.startswith('vitre-shell'):
                continue
            for n in files:
                if not n.endswith(EXT):
                    continue
                p = os.path.join(d, n)
                if os.path.islink(p):
                    continue
                try:
                    t = open(p, encoding='utf-8').read()
                except (UnicodeDecodeError, OSError):
                    continue
                t2 = clean_text(t)
                if t2 != t:
                    changed += 1
                    if not check:
                        open(p, 'w', encoding='utf-8').write(t2)
    if not check:
        changed += apply_exact(stage)
    print(f'sanitize-staged: {changed} file(s) {"would change" if check else "rewritten"}')


main()

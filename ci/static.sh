#!/usr/bin/env bash
# Static checks, no GNOME needed. Runs on a plain Ubuntu runner (and on a laptop):
#   1. shellcheck on every shell script (fails on errors only; warnings and notes are not looked at)
#   2. JSON and extension metadata (ci/check-metadata.py)
#   3. glib-compile-schemas --strict on every extension's schemas folder (dry run: nothing is written into the tree)
#   4. a JavaScript syntax check of every extension .js/.mjs/.cjs file (the .js files are ES modules, as GJS loads them)
# Needs: shellcheck, glib-compile-schemas (libglib2.0-bin), node, python3. Usage: ci/static.sh [path-to-vitre-tree]
set -uo pipefail
[ $# -gt 0 ] && export VITRE_REPO="$1"
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO" || die "cannot enter $REPO"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/vitre-static.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# VITRE_CI_NO_SHELLCHECK=1 is for a laptop without shellcheck: step 1 then only runs bash -n and says so. CI never sets it.
HAVE_SHELLCHECK=1
if ! command -v shellcheck >/dev/null; then
  [ -n "${VITRE_CI_NO_SHELLCHECK:-}" ] || die "missing tool: shellcheck"
  HAVE_SHELLCHECK=0
fi
for tool in glib-compile-schemas node python3; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done
echo "tree: $REPO"
echo "shellcheck $([ "$HAVE_SHELLCHECK" = 1 ] && shellcheck --version | sed -n 's/^version: //p' || echo 'NOT INSTALLED'), node $(node --version), $(glib-compile-schemas --version 2>&1 | head -1)"

# ---- 1. shell scripts --------------------------------------------------------------------------------------------------------------
group "shellcheck (errors only)"
# every *.sh anywhere, plus extension-less files at the top two levels that start with a shell shebang
find . \( -name .git -o -name node_modules \) -prune -o -type f -name '*.sh' -print0 > "$TMP/sh.list"
while IFS= read -r -d '' f; do
  case "$(head -c 200 "$f" 2>/dev/null | head -1)" in
    '#!'*sh*|'#!'*bash*) printf '%s\0' "$f" >> "$TMP/sh.list" ;;
  esac
done < <(find . -maxdepth 2 \( -name .git -o -name node_modules \) -prune -o -type f ! -name '*.*' -print0)
sort -zu "$TMP/sh.list" > "$TMP/sh.sorted"
mapfile -d '' SCRIPTS < "$TMP/sh.sorted"
if [ "${#SCRIPTS[@]}" -eq 0 ]; then
  fail "no shell scripts found (install.sh should be one)"
else
  for s in "${SCRIPTS[@]}"; do
    if bash -n "$s" 2>"$TMP/bashn.err"; then :; else fail "$s: bash -n: $(head -1 "$TMP/bashn.err")"; fi
  done
  if [ "$HAVE_SHELLCHECK" = 0 ]; then
    echo "  SKIPPED shellcheck (not installed here); only bash -n ran on ${#SCRIPTS[@]} scripts"
  elif shellcheck --severity=error --format=gcc --external-sources "${SCRIPTS[@]}" > "$TMP/shellcheck.out" 2>&1; then
    pass "shellcheck: ${#SCRIPTS[@]} scripts, no errors"
  else
    cat "$TMP/shellcheck.out"
    fail "shellcheck found errors (listed above)"
  fi
fi
endgroup

# ---- 2. JSON and metadata ----------------------------------------------------------------------------------------------------------
group "JSON and extension metadata"
if python3 "$CI_DIR/check-metadata.py" "$REPO" | tee "$TMP/meta.out"; then
  pass "JSON and metadata"
else
  fail "JSON or metadata problems (listed above)"
fi
endgroup

# ---- 3. settings schemas -----------------------------------------------------------------------------------------------------------
group "glib-compile-schemas --strict"
n=0
for d in extensions/*/schemas; do
  [ -d "$d" ] || continue
  ls "$d"/*.gschema.xml >/dev/null 2>&1 || continue
  n=$((n + 1))
  if glib-compile-schemas --strict --dry-run "$d" 2> "$TMP/gcs.err"; then
    pass "$d"
  else
    fail "$d: $(head -3 "$TMP/gcs.err" | tr '\n' ' ')"
  fi
done
[ "$n" -gt 0 ] || fail "no schemas folders found under extensions/"
endgroup

# ---- 4. JavaScript syntax ----------------------------------------------------------------------------------------------------------
group "JavaScript syntax (node --check)"
mkdir -p "$TMP/js" "$TMP/jsout"
find extensions ci \( -name node_modules -o -name .git \) -prune -o -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print0 > "$TMP/js.list"
JS_COUNT="$(tr -cd '\0' < "$TMP/js.list" | wc -c)"
# .js files are ES modules in GJS: node only treats .mjs that way, so each .js is checked through a copy named .mjs
# (the copy is named by a counter and the real path is kept in a map for the error message)
i=0
: > "$TMP/js.map"
while IFS= read -r -d '' f; do
  i=$((i + 1))
  case "$f" in
    *.cjs) cp -- "$f" "$TMP/js/$i.cjs"; echo "$i.cjs	$f" >> "$TMP/js.map" ;;
    *)     cp -- "$f" "$TMP/js/$i.mjs"; echo "$i.mjs	$f" >> "$TMP/js.map" ;;
  esac
done < "$TMP/js.list"
if [ "$JS_COUNT" -eq 0 ]; then
  fail "no extension JavaScript files found"
else
  find "$TMP/js" -type f -print0 > "$TMP/js.files"
  xargs -0 -n 1 -P "$(nproc 2>/dev/null || echo 2)" sh -c \
    'f="$2"; b="$(basename "$f")"; node --check "$f" >/dev/null 2>"$1/$b.err" || touch "$1/$b.bad"' _ "$TMP/jsout" < "$TMP/js.files"
  if ls "$TMP"/jsout/*.bad >/dev/null 2>&1; then
    for b in "$TMP"/jsout/*.bad; do
      name="$(basename "${b%.bad}")"
      real="$(awk -F'\t' -v n="$name" '$1 == n {print $2}' "$TMP/js.map")"
      fail "$real: $(grep -m1 -E 'SyntaxError|Error' "${b%.bad}.err" | head -1)"
    done
  else
    pass "node --check: $JS_COUNT JavaScript files parse"
  fi
fi
endgroup

finish "static"

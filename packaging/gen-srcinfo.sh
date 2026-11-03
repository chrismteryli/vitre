#!/bin/bash
# gen-srcinfo.sh [PKGBUILD]   writes a .SRCINFO to stdout
# A stand-in for `makepkg --printsrcinfo` for machines without makepkg (this one is Ubuntu). It sources the PKGBUILD, which only
# defines variables and functions, and reads the per-package assignments out of each package_NAME() body. The PKGBUILD keeps those
# bodies to plain assignments plus one `_stage` line so that this works. Before the first push to the AUR, regenerate the file with
# the real tool on Arch:  makepkg --printsrcinfo > .SRCINFO   and look at the diff.
set -euo pipefail
file="$(realpath "${1:-$(dirname "${BASH_SOURCE[0]}")/arch/PKGBUILD}")"
emit() { local key="$1" v; shift; for v in "$@"; do printf '\t%s = %s\n' "$key" "$v"; done; }
# shellcheck disable=SC1090
source "$file"
echo "pkgbase = $pkgbase"
[ -z "${pkgdesc:-}" ] || emit pkgdesc "$pkgdesc"
emit pkgver "$pkgver"
emit pkgrel "$pkgrel"
[ -z "${epoch:-}" ] || emit epoch "$epoch"
emit url "$url"
emit arch "${arch[@]}"
emit license "${license[@]}"
emit makedepends "${makedepends[@]}"
emit options "${options[@]}"
emit source "${source[@]}"
emit sha256sums "${sha256sums[@]}"
for p in "${pkgname[@]}"; do
  echo
  echo "pkgname = $p"
  body="$(sed -n "/^package_${p}() {/,/^}/p" "$file" | sed '1d;$d' | grep -v '^[[:space:]]*_stage ')"
  (
    unset pkgdesc license depends optdepends install backup
    eval "$body"
    [ -z "${pkgdesc:-}" ] || emit pkgdesc "$pkgdesc"
    [ -z "${license+x}" ] || emit license "${license[@]}"
    [ -z "${depends+x}" ] || emit depends "${depends[@]}"
    [ -z "${optdepends+x}" ] || emit optdepends "${optdepends[@]}"
    [ -z "${install:-}" ] || emit install "$install"
    [ -z "${backup+x}" ] || emit backup "${backup[@]}"
  )
done

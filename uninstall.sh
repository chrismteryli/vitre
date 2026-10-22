#!/usr/bin/env bash
# Vitre uninstaller: puts back what install.sh changed, from the backup it took.
#   ./uninstall.sh                 undo the most recent install
#   ./uninstall.sh <backup-dir>    undo a specific one (~/.local/share/vitre-backup/<date>)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
B="${1:-$(ls -d "$DATA"/vitre-backup/[0-9]*[0-9]/ 2>/dev/null | sort | tail -1)}"
B="${B%/}"
[ -n "$B" ] && [ -f "$B/dconf.ini" ] || { echo "vitre: no install backup found in $DATA/vitre-backup" >&2; exit 1; }
echo "restoring from $B"

# 1. files: remove what the install created, then move back what it had moved aside (reverse order)
tac "$B/installed.txt" | while IFS= read -r p; do
  [ -n "$p" ] && case "$p" in "$HOME"/*) rm -rf -- "$p" ;; esac
done
tac "$B/moved.txt" | while IFS=$'\t' read -r dst keep; do
  [ -n "$dst" ] && [ -e "$keep" ] && { mkdir -p "$(dirname "$dst")"; mv -- "$keep" "$dst"; }
done

# 2. settings: clear every key Vitre wrote, then load the backup
section=""
while IFS= read -r line; do
  case "$line" in
    \[*\]) section="${line#[}"; section="${section%]}" ;;
    *=*)   [ -n "$section" ] && dconf reset "/org/gnome/$section/${line%%=*}" ;;
  esac
done < "$HERE/settings/vitre.ini"
# Vitre Dock's settings path: also drops the keys that install.sh copied over from Dhruva (the backup below holds the old state)
dconf reset -f /org/gnome/shell/extensions/vitre-dock/
dconf reset /org/gnome/shell/enabled-extensions
dconf reset /org/gnome/shell/disabled-extensions
dconf reset /org/gnome/shell/disable-user-extensions
dconf load /org/gnome/ < "$B/dconf.ini"

mv "$B" "$B.undone"
echo "Vitre is removed. Sign out and back in to finish."

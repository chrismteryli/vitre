#!/usr/bin/env bash
# Vitre uninstaller: puts back what install.sh changed, from the backup it took.
#   ./uninstall.sh [--factory-reset]                 undo the most recent install
#   ./uninstall.sh [--factory-reset] <backup-dir>    undo a specific one
# Ordinary uninstall removes the files Vitre installed, puts back the files it replaced, and gives a setting back its old value only if
# Vitre's value is still in place; a setting you changed since, and every setting Vitre never touched, stay as they are.
# --factory-reset is the explicit full restore: every setting Vitre owns goes back to its pre-install value, even one you changed later.
# It still leaves alone every setting that Vitre does not own. (0.2.0 reloaded the whole /org/gnome/ snapshot; no version does that now.)
# A backup made by Vitre 0.2.0 or earlier (it holds dconf.ini) is undone too, with the same rules: only Vitre-owned settings are restored.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$(realpath -m -- "${XDG_DATA_HOME:-$HOME/.local/share}")"
FACTORY_RESET=0
if [ "${1:-}" = "--factory-reset" ]; then
  FACTORY_RESET=1
  shift
fi
[ "$#" -le 1 ] || { echo "usage: $0 [--factory-reset] [backup-dir]" >&2; exit 2; }
B="${1:-$( { ls -dt "$DATA"/vitre-backup/[0-9]*-??????/ 2>/dev/null || true; } | head -1)}"
B="${B%/}"
if [ -n "$B" ] && [ -f "$B/roots.txt" ] && [ -f "$B/settings/paths.txt" ]; then
  FORMAT=current
elif [ -n "$B" ] && [ -f "$B/dconf.ini" ] && [ -f "$B/installed.txt" ] && [ -f "$B/moved.txt" ]; then
  FORMAT=legacy
else
  echo "vitre: no install backup found in $DATA/vitre-backup" >&2
  exit 1
fi
B="$(cd "$B" && pwd)"
echo "restoring from $B"

if [ "$FORMAT" = legacy ]; then
  # ---- a 0.2.0 (or older) backup: whole-file lists, plus a dump of all of /org/gnome/ taken before the install ----------------------
  HOME_THEN="$(cat "$B/home.txt" 2>/dev/null || true)"
  [ -n "$HOME_THEN" ] || HOME_THEN="$HOME"
  case "$HOME_THEN" in /*) ;; *) echo "vitre: unsafe home folder in $B/home.txt" >&2; exit 1 ;; esac
  tac "$B/installed.txt" | while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in "$HOME_THEN"/*) rm -rf -- "$p" ;; *) echo "vitre: refusing unsafe installed path: $p" >&2; exit 1 ;; esac
  done
  tac "$B/moved.txt" | while IFS=$'\t' read -r dst keep; do
    [ -n "$dst" ] || continue
    case "$dst" in "$HOME_THEN"/*) ;; *) echo "vitre: refusing unsafe restore path: $dst" >&2; exit 1 ;; esac
    case "$(realpath -m -- "$keep")" in "$B/files/"*) ;; *) echo "vitre: unsafe backup path: $keep" >&2; exit 1 ;; esac
    if [ -e "$keep" ] || [ -L "$keep" ]; then mkdir -p "$(dirname "$dst")"; mv -- "$keep" "$dst"; fi
  done
  # Only the settings Vitre owned: the keys of its settings file, Vitre Dock's folder and the three extension lists. For each, the value
  # in the old dump is written back, or the key is reset when the dump had none. Nothing else in the dump is loaded.
  dconf reset -f /org/gnome/shell/extensions/vitre-dock/
  while IFS=$'\t' read -r op path value; do
    case "$path" in /org/gnome/*) ;; *) continue ;; esac
    case "$op" in
      W) dconf write "$path" "$value" ;;
      R) dconf reset "$path" ;;
    esac
  done < <(python3 -I - "$B/dconf.ini" "$HERE/settings/vitre.ini" <<'PYEOF'
import sys
def sections(path, keep_all=False):
    cur, out = None, {}
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        if line.startswith('[') and line.endswith(']'):
            cur = line[1:-1]; out.setdefault(cur, {})
        elif cur is not None and '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1); out[cur][k] = v
    return out
old, ini = sections(sys.argv[1]), sections(sys.argv[2])
dock = 'shell/extensions/vitre-dock'
for sec, keys in ini.items():
    for k in keys:
        v = old.get(sec, {}).get(k)
        print('%s\t/org/gnome/%s/%s\t%s' % ('W' if v is not None else 'R', sec, k, v or ''))
for k, v in old.get(dock, {}).items():
    print('W\t/org/gnome/%s/%s\t%s' % (dock, k, v))
for k in ('enabled-extensions', 'disabled-extensions', 'disable-user-extensions'):
    v = old.get('shell', {}).get(k)
    print('%s\t/org/gnome/shell/%s\t%s' % ('W' if v is not None else 'R', k, v or ''))
PYEOF
)
  mv "$B" "$B.undone"
  echo "Vitre is removed. Sign out and back in to finish."
  exit 0
fi

DATA=""
CONF=""
THEMES=""
while IFS=$'\t' read -r name root; do
  case "$name" in
    DATA) DATA="$root" ;;
    CONF) CONF="$root" ;;
    THEMES) THEMES="$root" ;;
  esac
done < "$B/roots.txt"
for root in "$DATA" "$CONF" "$THEMES"; do
  case "$root" in /*) ;; *) echo "vitre: unsafe install root in $B/roots.txt" >&2; exit 1 ;; esac
done

safe_installed_path() {
  local p
  p="$(realpath -m -- "$1")"
  case "$p" in
    "$DATA"/*|"$CONF"/*|"$THEMES"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# 1. files: remove what the install created, then move back what it had moved aside (reverse order).
# Recorded roots, rather than $HOME, also cover external XDG_DATA_HOME and XDG_CONFIG_HOME locations.
tac "$B/installed.txt" | while IFS= read -r p; do
  [ -n "$p" ] || continue
  safe_installed_path "$p" || { echo "vitre: refusing unsafe installed path: $p" >&2; exit 1; }
  rm -rf -- "$p"
done
tac "$B/moved.txt" | while IFS=$'\t' read -r dst keep; do
  [ -n "$dst" ] || continue
  safe_installed_path "$dst" || { echo "vitre: refusing unsafe restore path: $dst" >&2; exit 1; }
  case "$(realpath -m -- "$keep")" in "$B/files/"*) ;; *) echo "vitre: unsafe backup path: $keep" >&2; exit 1 ;; esac
  if [ -e "$keep" ] || [ -L "$keep" ]; then
    mkdir -p "$(dirname "$dst")"
    mv -- "$keep" "$dst"
  fi
done

# 2. settings: each key has its pre-install and post-install value. Restore only when the current
# value is still the one Vitre left; later user customization belongs to the user, not this transaction.
n=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in /org/gnome/*) ;; *) echo "vitre: unsafe settings path: $path" >&2; exit 1 ;; esac
  n=$((n + 1))
  before="$(cat "$B/settings/before/$n" 2>/dev/null || true)"
  after="$(cat "$B/settings/after/$n" 2>/dev/null || true)"
  current="$(dconf read "$path" 2>/dev/null || true)"
  if [ "$FACTORY_RESET" -eq 1 ] || [ "$current" = "$after" ]; then
    if [ -n "$before" ]; then
      dconf write "$path" "$before"
    else
      dconf reset "$path"
    fi
  fi
done < "$B/settings/paths.txt"

mv "$B" "$B.undone"
echo "Vitre is removed. Sign out and back in to finish."

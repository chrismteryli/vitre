/*
* Dhruva GNOME Extension
* Copyright (C) 2026 NarkAgni
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Vitre (B5): stacks. The Downloads stack (or the folder in `stack-folder`) and, with `stack-custom-folders`, the folders
// the user added to the Dock show their newest files as a little pile; a click opens them as a fan or a grid.

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { isActorAlive } from '../../core/Utils.js';
import { acquireStackSource, releaseStackSource, downloadsPath, normalizePath } from '../../core/StackSource.js';
import { fileIcon, openFolder } from '../stacks/StackItems.js';
import StackFan from '../stacks/StackFan.js';
import StackGrid from '../stacks/StackGrid.js';


export const STACK_ITEM_KEY = 'dhruva-sys-stack';
const PILE = [
    // [size x icon size, x offset, y offset (up), tilt in degrees]; front first
    [0.86, 0, 0, 0],
    [0.80, -1, 3, -7],
    [0.76, 1, 6, 6],
];

export function stackConfig(settings) {
    const has = key => {
        try {
            return settings.settings_schema.has_key(key);
        } catch (_e) {
            return false;
        }
    };
    const str = (key, d) => (has(key) ? settings.get_string(key) : d);
    const bool = (key, d) => (has(key) ? settings.get_boolean(key) : d);
    const int = (key, d) => (has(key) ? settings.get_int(key) : d);
    const folder = normalizePath(str('stack-folder', '')) || normalizePath(downloadsPath());
    return {
        show: bool('show-stack', true),
        folder,
        isDownloads: folder === normalizePath(downloadsPath()),
        view: str('stack-view', 'auto'),
        sort: str('stack-sort', 'date-added'),
        fanLimit: Math.max(3, Math.min(15, int('stack-fan-limit', 10))),
        customFolders: bool('stack-custom-folders', true),
    };
}

// the Downloads folder button is the stack when the stack shows the Downloads folder
export function stackReplacesDownloads(settings) {
    const c = stackConfig(settings);
    return c.show && c.isDownloads;
}

export function isLocalFolder(path) {
    if (!path || path.includes('://')) return false;
    try {
        return Gio.File.new_for_path(path).query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY;
    } catch (_e) {
        return false;
    }
}

function folderName(path) {
    if (normalizePath(path) === normalizePath(downloadsPath())) return _('Downloads');
    const base = GLib.path_get_basename(path);
    return base && base !== '/' && base !== '.' ? base : path;
}

// ---- the pile of the newest files on the button ---------------------------------------------------------------------
class StackPicture {
    constructor(size, renderScale, fallbackIcon) {
        this._size = size;
        this._renderScale = renderScale;
        this._fallback = fallbackIcon;
        this._key = null;
        this.actor = new St.Widget({ width: size, height: size, style_class: 'dhruva-stack-picture' });
    }

    update(entries) {
        if (!isActorAlive(this.actor)) return;
        const top = entries.slice(0, PILE.length);
        const key = top.map(e => `${e.uri}|${e.thumb || ''}`).join('\n') || `empty:${this._fallback}`;
        if (key === this._key) return;
        this._key = key;
        this.actor.destroy_all_children();
        const size = this._size;
        if (top.length === 0) {
            const icon = new St.Icon({ icon_name: this._fallback, icon_size: Math.ceil(size * this._renderScale), style_class: 'dock-grid-icon' });
            icon.set_size(size, size);
            this.actor.add_child(icon);
            return;
        }
        for (let i = top.length - 1; i >= 0; i--) {
            const [f, dx, dy, tilt] = PILE[i];
            const s = Math.round(size * f);
            const icon = fileIcon(top[i], s, Math.ceil(s * this._renderScale));
            icon.set_position(Math.round((size - s) / 2 + dx), Math.round(size - s - dy - size * 0.04));
            icon.set_pivot_point(0.5, 1.0);
            icon.rotation_angle_z = tilt;
            this.actor.add_child(icon);
        }
    }
}

// ---- per-Dock bookkeeping: one controller per stack, kept across the Dock's re-renders ------------------------------
function stacksOf(dockUI) {
    if (!dockUI._stacks) dockUI._stacks = new Map();
    return dockUI._stacks;
}

export function beginStackRender(dockUI) {
    for (const c of stacksOf(dockUI).values()) c.used = false;
}

export function endStackRender(dockUI) {
    const stacks = stacksOf(dockUI);
    for (const [key, c] of [...stacks.entries()]) {
        if (c.used) continue;
        const active = dockUI._activeFolderMenu;
        if (active && active._stackKey === key) active.hide();
        c.source.removeListener(c.listener);
        releaseStackSource(c.source);
        stacks.delete(key);
    }
}

export function destroyStacks(dockUI) {
    if (!dockUI || !dockUI._stacks) return;
    for (const c of dockUI._stacks.values()) {
        c.source.removeListener(c.listener);
        releaseStackSource(c.source);
    }
    dockUI._stacks.clear();
}

function currentButton(dockUI, key) {
    const box = dockUI.boxActor;
    if (!isActorAlive(box)) return null;
    return box.get_children().find(b => b._stackKey === key && isActorAlive(b)) || null;
}

function ensureController(dockUI, key, path, name, sort) {
    const stacks = stacksOf(dockUI);
    let c = stacks.get(key);
    if (c && c.path !== path) {
        c.source.removeListener(c.listener);
        releaseStackSource(c.source);
        stacks.delete(key);
        c = null;
    }
    if (!c) {
        const source = acquireStackSource(path);
        c = { key, path: source.path, name, source, used: true };
        c.listener = () => {
            const btn = currentButton(dockUI, key);
            if (btn && btn._stackPicture) btn._stackPicture.update(source.entries);
        };
        source.addListener(c.listener);
        stacks.set(key, c);
    }
    c.name = name;
    c.used = true;
    c.source.sort = sort;
    return c;
}

// the Dock closes any open popup on a button press (DockUI's empty-space handler); the stack button acts on the release, so
// a stack that this very click just closed stays closed
const RECLOSE_MS = 450;

export function toggleStack(dockUI, c, btn) {
    const active = dockUI._activeFolderMenu;
    if (active && active._stackKey === c.key) {
        active.hide();
        return;
    }
    const closed = dockUI._stackClosedAt;
    if (!active && closed && closed.key === c.key && Date.now() - closed.t < RECLOSE_MS) return;
    if (active) active.hide();
    if (dockUI._activeContextMenu) {
        dockUI._activeContextMenu.hide();
        dockUI._activeContextMenu = null;
    }
    const cfg = stackConfig(dockUI.settings);
    const horizontal = dockUI.dockPosition === 'BOTTOM' || dockUI.dockPosition === 'TOP';
    let kind = cfg.view;
    if (kind !== 'fan' && kind !== 'grid') kind = c.source.entries.length <= cfg.fanLimit ? 'fan' : 'grid';
    if (!horizontal) kind = 'grid';
    const popup = kind === 'fan' ? new StackFan(dockUI, c, btn) : new StackGrid(dockUI, c, btn);
    dockUI._activeFolderMenu = popup;
    popup.show(dockUI.dockPosition);
}

// a stack button: a Dock module button (createBtn) with the pile as its picture and the fan / grid on click
export function buildStackModule(dockUI, createBtn, { key, path, name = null, icon = null, renderScale = 1, moduleKey = null }) {
    const cfg = stackConfig(dockUI.settings);
    const label = name || folderName(path);
    const fallback = icon || (normalizePath(path) === normalizePath(downloadsPath()) ? 'folder-download' : 'folder');
    const c = ensureController(dockUI, key, normalizePath(path), label, cfg.sort);
    const btn = createBtn(fallback, label, b => toggleStack(dockUI, c, b), null, { noWindows: true, id: key, moduleKey: moduleKey || key });
    btn._isStack = true;
    btn._stackKey = key;
    const app = btn._delegate && btn._delegate.app;
    if (app) {
        app._stack = c;
        app.open = () => openFolder(c.path);
    }
    const iconBin = btn._iconBin || null;
    if (iconBin && iconBin.set_child) {
        const size = Math.round(iconBin.width || dockUI.settings.get_int('icon-size'));
        const picture = new StackPicture(size, renderScale, fallback);
        iconBin.set_child(picture.actor);
        picture.update(c.source.entries);
        btn._stackPicture = picture;
        btn._stackIcon = iconBin;
    }
    return btn;
}

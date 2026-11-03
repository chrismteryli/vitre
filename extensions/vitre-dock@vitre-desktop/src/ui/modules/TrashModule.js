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


import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { isActorAlive } from '../../core/Utils.js';
import { isStackFileSource } from '../stacks/StackItems.js';
import { requestAttention } from '../dock/DockTransitions.js';


export const TRASH_MODULE_ID = 'dhruva-module-trash';
export const TRASH_ITEM_KEY = 'dhruva-sys-trash';

// Vitre (B5): the home trash folder, for when trash:/// (gvfs) is not there
export function homeTrashDir() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'Trash']));
}

// attention: the Trash's contents changed (it gives its little squash and stretch on the next render, now)
function setTrashFull(dockUI, isFull, attention = false) {
    if (!dockUI) return;
    const changed = isFull !== dockUI._trashIsFull;
    dockUI._trashIsFull = isFull;
    if (attention) requestAttention(dockUI, actor => actor._isTrash);
    if ((changed || attention) && isActorAlive(dockUI.actor)) dockUI.queueRender('incremental', true);
}

function firstChild(file, cancellable, done) {
    file.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, (f, res) => {
        let enumerator;
        try {
            enumerator = f.enumerate_children_finish(res);
        } catch (e) {
            done(null, e);
            return;
        }
        enumerator.next_files_async(1, GLib.PRIORITY_LOW, cancellable, (en, r) => {
            let has = false;
            try {
                has = en.next_files_finish(r).length > 0;
            } catch (_e) {
                has = false;
            }
            en.close_async(GLib.PRIORITY_LOW, null, () => {});
            done(has, null);
        });
    });
}

// full or empty: the home trash folder, or trash:/// (every trash the user has, other drives too) when gvfs answers
export function checkTrashFull(cancellable, done) {
    firstChild(homeTrashDir().get_child('files'), cancellable, (hasLocal, errLocal) => {
        if (hasLocal && !errLocal) {
            done(true);
            return;
        }
        const trash = Gio.File.new_for_uri('trash:///');
        trash.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, (f, res) => {
            let info = null;
            try {
                info = f.query_info_finish(res);
            } catch (_e) {
                info = null;
            }
            if (info && info.has_attribute('trash::item-count')) {
                done(info.get_attribute_uint32('trash::item-count') > 0);
                return;
            }
            firstChild(trash, cancellable, (has, err) => done(err ? false : Boolean(has)));
        });
    });
}

export function refreshTrashState(dockUI, attention = false) {
    const cancellable = (dockUI && dockUI._cancellable) ? dockUI._cancellable : null;
    checkTrashFull(cancellable, isFull => setTrashFull(dockUI, isFull, attention));
}

export function buildTrashModule(dockUI, createBtn, toggleAppWindow) {
    const iconName = dockUI._trashIsFull ? 'user-trash-full' : 'user-trash';
    const btn = createBtn(iconName, _('Trash'), (button) => toggleAppWindow('trash:///', null, _('Trash'), button), null,
        { id: TRASH_MODULE_ID, moduleKey: TRASH_ITEM_KEY });
    btn._isTrash = true;

    if (dockUI._trashIsFull === undefined) {
        dockUI._trashIsFull = false;
        refreshTrashState(dockUI);
    }

    ensureTrashDrop(dockUI).attach(btn);
    return btn;
}


// ---------------------------------------------------------------------------------------------------------------------
// Vitre (B5): the Trash takes files. Two kinds of drags reach it:
//  - a file dragged out of a stack's fan or grid (a Dock-internal drag: acceptDrop on the button);
//  - files dragged from Files or any other app. The shell is never the target of such a drag (on Wayland the drop is only
//    offered to app windows), so the Dock watches it: Main.xdndHandler reports where it is, the dragged files are read from
//    mutter's DND selection (text/uri-list) once the drag is over the Trash, and when the button is released on the Trash
//    those files go to the trash. The app sees its drag cancelled; the icon it would fly back is hidden for that moment.
// ---------------------------------------------------------------------------------------------------------------------

const HOVER_SCALE = 1.16;
const RELEASE_WAIT_MS = 2000;
const FEEDBACK_HIDE_MS = 700;

class TrashDrop {
    constructor(dockUI) {
        this._dockUI = dockUI;
        this._xdnd = null;
        this._hover = false;
        this._feedbackId = 0;
        this.log = [];
        this._monitor = { dragMotion: event => this._onMotion(event) };
        DND.addDragMonitor(this._monitor);
        if (Main.xdndHandler) {
            Main.xdndHandler.connectObject(
                'drag-begin', () => this._xdndBegin(),
                'drag-end', () => this._xdndEnd(),
                this);
        }
    }

    _note(ev, detail = {}) {
        this.log.push({ t: Math.round(GLib.get_monotonic_time() / 1000), ev, ...detail });
        if (this.log.length > 60) this.log.shift();
    }

    attach(btn) {
        const delegate = btn._delegate || {};
        delegate.handleDragOver = source => {
            if (isStackFileSource(source)) {
                if (!this._hover) this._note('stack-over');
                this._setHover(true);
                return DND.DragMotionResult.MOVE_DROP;
            }
            return DND.DragMotionResult.CONTINUE;
        };
        delegate.acceptDrop = source => {
            if (!isStackFileSource(source)) return false;
            this._setHover(false);
            this._trash([source.entry.file], 'stack');
            return true;
        };
        btn._delegate = delegate;
        if (this._hover) {
            const icon = this._iconOf(btn);
            if (icon) {
                icon.set_pivot_point(0.5, 0.75);
                icon.set_scale(HOVER_SCALE, HOVER_SCALE);
            }
        }
    }

    _button() {
        const box = this._dockUI && this._dockUI.boxActor;
        if (!isActorAlive(box)) return null;
        return box.get_children().find(c => c._isTrash && isActorAlive(c) && c.visible) || null;
    }

    _inside(x, y, margin = 2) {
        const btn = this._button();
        if (!btn || !btn.mapped) return false;
        const [bx, by] = btn.get_transformed_position();
        const [bw, bh] = btn.get_transformed_size();
        return x >= bx - margin && x <= bx + bw + margin && y >= by - margin && y <= by + bh + margin;
    }

    _iconOf(btn) {
        const bin = btn ? btn._iconBin : null;
        const icon = bin && bin.get_child ? bin.get_child() : null;
        return isActorAlive(icon) ? icon : null;
    }

    _setHover(on) {
        if (on === this._hover) return;
        this._hover = on;
        const icon = this._iconOf(this._button());
        if (!icon) return;
        icon.set_pivot_point(0.5, 0.75);
        icon.remove_transition('scale-x');
        icon.remove_transition('scale-y');
        icon.ease({
            scale_x: on ? HOVER_SCALE : 1,
            scale_y: on ? HOVER_SCALE : 1,
            duration: on ? 180 : 160,
            mode: on ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onMotion(event) {
        if (event.source === Main.xdndHandler) {
            if (this._xdnd && this._xdnd.files) {
                const over = this._inside(event.x, event.y);
                this._setHover(over);
                if (over) this._read(this._xdnd);
            }
        } else if (isStackFileSource(event.source)) {
            const [x, y] = global.get_pointer();
            if (!this._inside(x, y)) this._setHover(false);
        }
        return DND.DragMotionResult.CONTINUE;
    }

    _xdndBegin() {
        let types = [];
        try {
            types = global.display.get_selection().get_mimetypes(Meta.SelectionType.SELECTION_DND) || [];
        } catch (_e) {
            types = [];
        }
        this._xdnd = { files: types.includes('text/uri-list'), uris: null, reading: false, release: null };
        this._note('xdnd-begin', { types: types.slice(0, 8) });
    }

    _read(x) {
        if (!x || x.uris || x.reading) return;
        x.reading = true;
        const selection = global.display.get_selection();
        const stream = Gio.MemoryOutputStream.new_resizable();
        try {
            selection.transfer_async(Meta.SelectionType.SELECTION_DND, 'text/uri-list', -1, stream, null, (_s, res) => {
                let uris = [];
                try {
                    selection.transfer_finish(res);
                    stream.close(null);
                    const bytes = stream.steal_as_bytes();
                    const text = new TextDecoder().decode(bytes.toArray());
                    uris = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
                } catch (e) {
                    this._note('xdnd-read-failed', { error: e.message });
                }
                x.reading = false;
                x.uris = uris;
                this._note('xdnd-read', { n: uris.length });
                if (x.release) {
                    const release = x.release;
                    x.release = null;
                    if (GLib.get_monotonic_time() / 1000 - release <= RELEASE_WAIT_MS) this._dropUris(uris);
                }
            });
        } catch (e) {
            x.reading = false;
            this._note('xdnd-read-failed', { error: e.message });
        }
    }

    _xdndEnd() {
        const x = this._xdnd;
        this._xdnd = null;
        this._setHover(false);
        if (!x || !x.files) return;
        const [px, py] = global.get_pointer();
        const over = this._inside(px, py);
        this._note('xdnd-end', { over, x: Math.round(px), y: Math.round(py), uris: x.uris ? x.uris.length : null });
        if (!over) return;
        this._hideFeedback();
        if (x.uris) {
            this._dropUris(x.uris);
        } else {
            // released before the list arrived: trash it when it does (only within RELEASE_WAIT_MS)
            x.release = GLib.get_monotonic_time() / 1000;
            if (!x.reading) this._read(x);
        }
    }

    _dropUris(uris) {
        const files = uris.map(u => {
            try {
                return Gio.File.new_for_uri(u);
            } catch (_e) {
                return null;
            }
        }).filter(Boolean);
        if (files.length > 0) this._trash(files, 'xdnd');
    }

    // the app's drag icon would fly back to where the drag began; the files went to the trash instead
    _hideFeedback() {
        try {
            const group = global.compositor.get_feedback_group();
            group.hide();
            if (this._feedbackId) GLib.source_remove(this._feedbackId);
            this._feedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FEEDBACK_HIDE_MS, () => {
                this._feedbackId = 0;
                if (!Main.sessionMode.isLocked) group.show();
                return GLib.SOURCE_REMOVE;
            });
        } catch (_e) { /* no feedback group */ }
    }

    _trash(files, via) {
        let left = files.length;
        let failed = 0;
        files.forEach(file => {
            file.trash_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
                try {
                    f.trash_finish(res);
                } catch (e) {
                    failed++;
                    console.warn(`[Dhruva] could not move ${f.get_uri()} to the trash: ${e.message}`);
                }
                left--;
                if (left === 0) {
                    this._note('trashed', { via, n: files.length, failed });
                    if (this._dockUI) refreshTrashState(this._dockUI);
                }
            });
        });
    }

    destroy() {
        DND.removeDragMonitor(this._monitor);
        if (Main.xdndHandler) Main.xdndHandler.disconnectObject(this);
        if (this._feedbackId) {
            GLib.source_remove(this._feedbackId);
            this._feedbackId = 0;
            try {
                if (!Main.sessionMode.isLocked) global.compositor.get_feedback_group().show();
            } catch (_e) { /* ignore */ }
        }
        this._dockUI = null;
    }
}

export function ensureTrashDrop(dockUI) {
    if (!dockUI._trashDrop) dockUI._trashDrop = new TrashDrop(dockUI);
    return dockUI._trashDrop;
}

export function destroyTrashDrop(dockUI) {
    if (dockUI && dockUI._trashDrop) {
        dockUI._trashDrop.destroy();
        dockUI._trashDrop = null;
    }
}

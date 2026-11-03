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


import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { addSeparator } from './ContextMenuItems.js';
import { setBoxVertical, isActorAlive } from '../../core/Utils.js';
import { checkTrashFull, homeTrashDir } from '../modules/TrashModule.js';


const TRASH_BATCH_SIZE = 10;
const LOCAL_DELETE_STEP = 64;

// Vitre (B5): without gvfs (trash:/// unavailable) the home trash folder is emptied directly: everything under
// Trash/files, Trash/info and Trash/expunged, children before their folder, symlinks removed and never followed, and
// nothing outside the home trash folder
function emptyHomeTrash() {
    const root = homeTrashDir();
    const rootPath = root.get_path();
    const todo = ['files', 'info', 'expunged'].map(name => ({ file: root.get_child(name), keep: true, listed: false }));
    const attrs = 'standard::name,standard::type';
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        for (let n = 0; n < LOCAL_DELETE_STEP && todo.length > 0; n++) {
            const top = todo[todo.length - 1];
            if (!top.listed) {
                top.listed = true;
                let en = null;
                try {
                    en = top.file.enumerate_children(attrs, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                } catch (_e) {
                    en = null;
                }
                if (en) {
                    let info;
                    while ((info = en.next_file(null)) !== null) {
                        const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
                        todo.push({ file: top.file.get_child(info.get_name()), keep: false, listed: !isDir });
                    }
                    en.close(null);
                }
                continue;
            }
            todo.pop();
            if (top.keep) continue;
            const path = top.file.get_path();
            if (!path || !path.startsWith(`${rootPath}/`)) continue;
            try {
                top.file.delete(null);
            } catch (e) {
                console.warn(`[Dhruva] could not delete ${path}: ${e.message}`);
            }
        }
        return todo.length > 0 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    });
}

function emptyTrashAsync(cancellable = null) {
    const trashRoot = Gio.File.new_for_uri('trash:///');
    trashRoot.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (file, res) => {
        try {
            const enumerator = file.enumerate_children_finish(res);
            let listed = 0;
            const deleteNext = () => {
                enumerator.next_files_async(TRASH_BATCH_SIZE, GLib.PRIORITY_DEFAULT, cancellable, (e, filesRes) => {
                    try {
                        const files = e.next_files_finish(filesRes);
                        if (!files || files.length === 0) {
                            enumerator.close_async(GLib.PRIORITY_DEFAULT, cancellable, () => {});
                            if (!listed) emptyHomeTrash();
                            return;
                        }
                        listed += files.length;
                        files.forEach(info => {
                            const child = trashRoot.get_child(info.get_name());
                            child.delete_async(GLib.PRIORITY_DEFAULT, cancellable, () => { });
                        });
                        deleteNext();
                    } catch (_err) {
                        enumerator.close_async(GLib.PRIORITY_DEFAULT, cancellable, () => {});
                        if (!listed) emptyHomeTrash();
                    }
                });
            };
            deleteNext();
        } catch (_err) {
            emptyHomeTrash();
        }
    });
}

function confirmEmptyTrash() {
    const dialog = new ModalDialog.ModalDialog({ styleClass: 'dhruva-modal-dialog', destroyOnClose: true });
    const content = new St.BoxLayout({
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 12px; padding: 24px 20px 12px 20px; text-align: center;'
    });
    setBoxVertical(content, true);

    content.add_child(new St.Label({
        text: _('Empty Trash?'),
        style: 'font-weight: 800; font-size: 22px; color: #ffffff; text-align: center;'
    }));

    const descLabel = new St.Label({
        text: _('Everything in the Trash will be deleted for good. You can’t undo this.'),
        style: 'font-size: 15px; color: rgba(255, 255, 255, 0.75); text-align: center; margin-top: 4px; width: 300px;'
    });
    descLabel.clutter_text.line_wrap = true;
    descLabel.clutter_text.justify = true;
    content.add_child(descLabel);

    dialog.contentLayout.add_child(content);
    dialog.addButton({ label: _('Cancel'), action: () => dialog.close(), key: Clutter.KEY_Escape });
    dialog.addButton({ label: _('Empty Trash'), action: () => { dialog.close(); emptyTrashAsync(); }, isDefault: true });
    dialog.open();
}

export function attachTrashActions(contextMenu) {
    const emptyBtn = new St.Button({
        reactive: false,
        x_expand: true,
        style_class: 'context-menu-action-btn'
    });
    const label = new St.Label({
        text: _('Checking the Trash…'),
        style_class: 'context-menu-action-label',
        style: 'color: rgba(255,255,255,0.4);'
    });
    emptyBtn.set_child(label);
    contextMenu.panel.add_child(emptyBtn);
    addSeparator(contextMenu.panel);

    const cancellable = new Gio.Cancellable();
    emptyBtn.connectObject('destroy', () => cancellable.cancel(), emptyBtn);

    const showState = hasItems => {
        if (!isActorAlive(emptyBtn)) return;

        if (hasItems) {
            emptyBtn.reactive = true;
            emptyBtn.style_class = 'context-menu-action-btn-destructive';
            label.set_text(_('Empty Trash'));
            label.style_class = 'context-menu-action-label-destructive';
            label.set_style('');
            emptyBtn.connectObject('clicked', () => {
                contextMenu.hide();
                confirmEmptyTrash();
            }, emptyBtn);
        } else {
            emptyBtn.reactive = false;
            emptyBtn.set_opacity(100);
            label.set_text(_('Trash is Empty'));
            label.set_style('color: rgba(255,255,255,0.25);');
        }
    };

    // Vitre (B5): the same check the Trash icon uses (trash:/// when gvfs answers, else the home trash folder)
    checkTrashFull(cancellable, hasItems => {
        if (!cancellable.is_cancelled()) showState(hasItems);
    });
}
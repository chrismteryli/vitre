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

// Vitre (B5): a stack's grid: a glass panel above the stack icon with the folder's name, "Open in Files" and every file
// in a scrolling grid. It is built like the Dock's folder menus (FolderMenu.js: an overlay, a menuContainer holding the
// panel's drawn shape and the panel) and opens through FolderMenu's own show(), so whatever animates the folder menus
// (Vitre's stretch when vitre-menus runs, Dhruva's fade otherwise) animates the grid the same way.

import St from 'gi://St';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import FolderMenu from '../folder-menu/FolderMenu.js';
import { TimeoutTracker } from '../../core/TimeoutTracker.js';
import { isActorAlive, setBoxVertical } from '../../core/Utils.js';
import { setMagnifierPauseState } from '../magnifier/MagnifierState.js';
import { applyThemeStyle } from '../folder-menu/FolderMenuStyle.js';
import { fileIcon, openEntry, openFolder, makeFileDraggable } from './StackItems.js';


const POSITION_GAP = 20;
const ARROW_WIDTH = 24;
const ARROW_HEIGHT = 12;
export const GRID = {
    tileW: 96,
    tileH: 108,
    icon: 64,
    spacing: 4,
    maxRows: 4,
    maxCols: 6,
};

export function gridColumns(n) {
    if (n <= 9) return 3;
    if (n <= 16) return 4;
    if (n <= 30) return 5;
    return GRID.maxCols;
}

export default class StackGrid {
    constructor(dockUI, stack, buttonActor) {
        this.dockUI = dockUI;
        this.stack = stack;
        this._stackKey = stack.key;
        this.buttonActor = buttonActor;
        this.timers = new TimeoutTracker();
        this._dragging = false;

        if (isActorAlive(this.buttonActor)) this.buttonActor.connectObject('destroy', () => { this.buttonActor = null; }, this);

        this.actor = new St.Widget({ style_class: 'context-menu-overlay dhruva-stack-overlay', reactive: true, x_expand: true, y_expand: true });
        this.actor.connectObject(
            'button-release-event', (_a, event) => {
                if (event.get_button() === Clutter.BUTTON_PRIMARY || event.get_button() === Clutter.BUTTON_SECONDARY) this.hide();
                return Clutter.EVENT_STOP;
            },
            'key-press-event', (_a, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this.hide();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            'destroy', () => this._cleanup(),
            this);

        this.menuContainer = new St.Widget({ layout_manager: new Clutter.BinLayout(), reactive: true, style: 'background-color: transparent;' });
        this.menuContainer.connectObject('button-release-event', () => Clutter.EVENT_STOP, this);
        this.bgDrawingArea = new St.DrawingArea({ x_expand: true, y_expand: true, style: 'background-color: transparent;' });
        this.menuContainer.add_child(this.bgDrawingArea);

        this.panel = new St.BoxLayout({ reactive: true, style_class: 'context-menu-panel dhruva-stack-grid-panel' });
        setBoxVertical(this.panel, true);
        this.panel.connectObject('button-release-event', () => Clutter.EVENT_STOP, this);
        this.menuContainer.add_child(this.panel);
        applyThemeStyle(this, this.panel);
        this.actor.add_child(this.menuContainer);

        this._onSource = () => {
            if (this.actor && !this._dragging) this._fill();
        };
        this._buildChrome();
        this._fill();
    }

    get kind() {
        return 'grid';
    }

    _buildChrome() {
        const header = new St.BoxLayout({ style_class: 'dhruva-stack-grid-header', x_expand: true });
        setBoxVertical(header, false);
        this._title = new St.Label({ text: this.stack.name, style_class: 'dhruva-stack-grid-title', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        header.add_child(this._title);
        const open = new St.Button({ style_class: 'dhruva-stack-grid-open', label: _('Open in Files'), can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        open.connectObject('clicked', () => {
            openFolder(this.stack.path);
            this.hide();
        }, this);
        header.add_child(open);
        this._openButton = open;
        this.panel.add_child(header);

        this._scroll = new St.ScrollView({
            style_class: 'dhruva-stack-grid-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._rows = new St.BoxLayout({ style_class: 'dhruva-stack-grid-rows' });
        setBoxVertical(this._rows, true);
        this._scroll.set_child(this._rows);
        this.panel.add_child(this._scroll);
    }

    _fill() {
        if (!isActorAlive(this._rows)) return;
        this._rows.destroy_all_children();
        const entries = this.stack.source.entries;
        const cols = gridColumns(entries.length);
        const width = cols * GRID.tileW + (cols - 1) * GRID.spacing;
        this._rows.set_style(`spacing: ${GRID.spacing}px; width: ${width}px;`);
        if (entries.length === 0) {
            this._rows.add_child(new St.Label({
                text: _('%s is empty').format(this.stack.name),
                style_class: 'dhruva-stack-grid-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        let row = null;
        entries.forEach((entry, i) => {
            if (i % cols === 0) {
                row = new St.BoxLayout({ style: `spacing: ${GRID.spacing}px;` });
                setBoxVertical(row, false);
                this._rows.add_child(row);
            }
            row.add_child(this._tile(entry));
        });
        const rows = Math.ceil(entries.length / cols);
        const visibleRows = Math.min(GRID.maxRows, Math.max(1, rows));
        const height = entries.length === 0 ? 72 : visibleRows * GRID.tileH + (visibleRows - 1) * GRID.spacing;
        // room for the overlay scrollbar beside the last column
        this._scroll.set_style(`height: ${height}px; width: ${width + (rows > GRID.maxRows ? 12 : 0)}px;`);
        this._lastStateStr = null;
    }

    _tile(entry) {
        const tile = new St.Button({
            style_class: 'dhruva-stack-tile',
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.PRIMARY,
            width: GRID.tileW,
            height: GRID.tileH,
        });
        const box = new St.BoxLayout({ style_class: 'dhruva-stack-tile-box', x_expand: true });
        setBoxVertical(box, true);
        const icon = fileIcon(entry, GRID.icon, GRID.icon);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        const label = new St.Label({ text: entry.displayName, style_class: 'dhruva-stack-tile-label', x_align: Clutter.ActorAlign.CENTER });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        tile.set_child(box);
        tile._entry = entry;
        tile.connectObject('clicked', () => {
            openEntry(entry);
            this.hide();
        }, this);
        makeFileDraggable(tile, entry, {
            iconSize: GRID.icon,
            homeActor: () => {
                const btn = this._findButton();
                return btn && btn._stackIcon ? btn._stackIcon : btn;
            },
            onBegin: () => {
                this._dragging = true;
                tile.opacity = 0;
                // the drop target is whatever is under the pointer, never this overlay
                if (isActorAlive(this.actor)) Shell.util_set_hidden_from_pick(this.actor, true);
                this.hide();
            },
            onEnd: () => {
                this._dragging = false;
                if (this._pendingDispose) this._pendingDispose();
            },
        });
        return tile;
    }

    _findButton() {
        if (isActorAlive(this.buttonActor) && this.buttonActor.get_parent()) return this.buttonActor;
        const box = this.dockUI && this.dockUI.boxActor;
        if (!isActorAlive(box)) return null;
        const btn = box.get_children().find(c => c._stackKey === this._stackKey && isActorAlive(c));
        if (btn) {
            if (this.buttonActor) this.buttonActor.disconnectObject(this);
            this.buttonActor = btn;
            btn.connectObject('destroy', () => { this.buttonActor = null; }, this);
            this._isFirstPosition = true;
        }
        return btn || null;
    }

    // FolderMenu's placement (above the icon with the arrow on it), but the button is found again by its stack key
    _updatePosition() {
        if (!isActorAlive(this.actor) || !isActorAlive(this.menuContainer) || !this.actor.get_stage()) return;
        const btn = this._findButton();
        if (!btn) {
            this.hide();
            return;
        }
        const [btnX, btnY] = btn.get_transformed_position();
        const [btnW, btnH] = btn.get_transformed_size();
        if (Number.isNaN(btnX) || Number.isNaN(btnY) || btnW <= 0 || btnH <= 0) return;
        const [, panelW] = this.menuContainer.get_preferred_width(-1);
        const [, panelH] = this.menuContainer.get_preferred_height(-1);
        const stateStr = `${btnX},${btnY},${btnW},${panelW},${panelH}`;
        if (this._lastStateStr === stateStr) return;
        this._lastStateStr = stateStr;

        const dockPosition = this._dockPos || this.dockUI.dockPosition;
        let posX = btnX + btnW / 2 - panelW / 2;
        let posY = btnY;
        if (dockPosition === 'BOTTOM') {
            posY = btnY - panelH - POSITION_GAP;
            this.menuContainer.set_pivot_point(0.5, 1.0);
        } else if (dockPosition === 'TOP') {
            posY = btnY + btnH + POSITION_GAP;
            this.menuContainer.set_pivot_point(0.5, 0.0);
        } else if (dockPosition === 'LEFT') {
            posX = btnX + btnW + POSITION_GAP;
            posY = btnY + btnH / 2 - panelH / 2;
            this.menuContainer.set_pivot_point(0.0, 0.5);
        } else if (dockPosition === 'RIGHT') {
            posX = btnX - panelW - POSITION_GAP;
            posY = btnY + btnH / 2 - panelH / 2;
            this.menuContainer.set_pivot_point(1.0, 0.5);
        }
        if (posX < 10) posX = 10;
        if (posX + panelW > global.stage.width - 10) posX = global.stage.width - panelW - 10;
        if (posY < 10) posY = 10;
        if (dockPosition !== 'BOTTOM' && posY + panelH > global.stage.height - POSITION_GAP) posY = global.stage.height - panelH - POSITION_GAP;
        posX = Math.round(posX);
        posY = Math.round(posY);

        this.bgDrawingArea._arrowCenter = (dockPosition === 'BOTTOM' || dockPosition === 'TOP')
            ? (btnX + btnW / 2) - posX
            : (btnY + btnH / 2) - posY;
        this.bgDrawingArea.queue_repaint();
        if (this._blurPanel) {
            const basePad = this._blurPanel.basePad;
            this._blurPanel.setCustomInsets({ top: basePad, bottom: basePad, left: basePad, right: basePad });
            this._blurPanel.setArrow({ side: dockPosition, center: this.bgDrawingArea._arrowCenter, width: ARROW_WIDTH, height: ARROW_HEIGHT });
        }
        if (this._isFirstPosition !== false) {
            this.menuContainer.set_position(posX, posY);
            this._isFirstPosition = false;
        } else {
            this.menuContainer.ease({ x: posX, y: posY, duration: 80, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        }
    }

    show(dockPosition) {
        this.stack.source.addListener(this._onSource);
        Main.overview.connectObject('showing', () => this.hide(), this);
        // FolderMenu's own show(): its overlay placement, its 16 ms position tracker and its open animation
        FolderMenu.prototype.show.call(this, dockPosition);
        this.timers.addTimeout(0, 140, () => {
            if (isActorAlive(this.actor) && this.actor.get_stage()) {
                this._previousFocus = global.stage.get_key_focus();
                global.stage.set_key_focus(this.actor);
            }
            return false;
        });
    }

    hide(immediate = false) {
        if (!this.actor) return;
        if (this.dockUI) this.dockUI._stackClosedAt = { key: this._stackKey, t: Date.now() };
        if (this._showDelayId) {
            this.timers.remove(this._showDelayId);
            this._showDelayId = 0;
        }
        if (this._posTrackerId) {
            this.timers.remove(this._posTrackerId);
            this._posTrackerId = 0;
        }
        if (this.dockUI && isActorAlive(this.dockUI.actor)) {
            this.dockUI.actor.disconnectObject(this);
            setMagnifierPauseState(this.dockUI.actor, 'folder-menu', false);
        }
        if (this.dockUI && this.dockUI._activeFolderMenu === this) this.dockUI._activeFolderMenu = null;
        if (this.stack && this.stack.source) this.stack.source.removeListener(this._onSource);
        Main.overview.disconnectObject(this);
        const focus = global.stage.get_key_focus();
        if (focus && isActorAlive(this.actor) && (focus === this.actor || this.actor.contains(focus))) {
            const prev = this._previousFocus;
            global.stage.set_key_focus(isActorAlive(prev) ? prev : null);
        }

        const actor = this.actor;
        const menuContainer = this.menuContainer;
        this.actor = null;
        this.menuContainer = null;
        if (isActorAlive(actor)) actor.reactive = false;
        const dispose = () => {
            if (this._dragging) {
                this._pendingDispose = dispose;
                if (isActorAlive(actor)) actor.opacity = 0;
                return;
            }
            this._pendingDispose = null;
            if (isActorAlive(actor)) {
                if (actor.get_parent()) Main.layoutManager.removeChrome(actor);
                actor.destroy();
            }
        };
        if (!immediate && isActorAlive(menuContainer) && isActorAlive(actor) && actor.get_stage()) {
            menuContainer.remove_all_transitions();
            menuContainer.ease({ opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: dispose });
        } else {
            dispose();
        }
    }

    // disable: no close motion, everything goes now
    destroyNow() {
        this._dragging = false;
        if (this.actor) this.hide(true);
        else if (this._pendingDispose) this._pendingDispose();
    }

    _cleanup() {
        if (this.stack && this.stack.source) this.stack.source.removeListener(this._onSource);
        Main.overview.disconnectObject(this);
        this.timers.destroy();
        if (this._blurPanel) {
            this._blurPanel.destroy();
            this._blurPanel = null;
        }
        if (this.buttonActor) this.buttonActor.disconnectObject(this);
        if (this.bgDrawingArea) this.bgDrawingArea.disconnectObject(this);
    }
}

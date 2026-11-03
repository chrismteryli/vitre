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

// Vitre (B5): a stack's fan. The newest files rise out of the stack icon in a gentle arc, each with its name beside it,
// and "Open in Files" sits at the end. The motion is Vitre's stretch (StackMotion.js); with reduced motion it fades.
// It lives in the Dock's popup slot (dockUI._activeFolderMenu), so every path that closes a Dock popup closes it.

import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { isActorAlive } from '../../core/Utils.js';
import { Settings } from '../../core/SettingsManager.js';
import { setMagnifierPauseState } from '../magnifier/MagnifierState.js';
import { FAN_MOTION, openProgress, closeProgress, smoothstep, lerp, motionSlow } from './StackMotion.js';
import { fileIcon, namePill, openEntry, openFolder, makeFileDraggable, restRect, monitorOf, nowMs } from './StackItems.js';


export const FAN = {
    gap: 14,            // from the stack icon's edge to the first file's icon
    pitchExtra: 8,      // space between two files
    tiltMaxDeg: 8,      // tilt at `arcRef` px along the arc (the top of a full fan)
    arcRef: 680,
    minTiltDeg: 0.75,   // a file tilted less than this is drawn straight (crisp at rest)
    labelGap: 10,
    labelMax: 236,
    topMargin: 10,
    maxStretch: 0.22,   // the most a file is pulled longer while it flies (x its height)
    stretchGain: 0.3,
};

function motionAllowed() {
    try {
        const s = St.Settings.get();
        if (!s.enable_animations || s.reducedMotion === St.ReducedMotion.REDUCE) return false;
    } catch (_e) { /* older St */ }
    return !(Main.sessionMode.isLocked || Main.sessionMode.isGreeter);
}

const snap = (v, scale) => Math.round(v * scale) / scale;

export default class StackFan {
    constructor(dockUI, stack, buttonActor) {
        this.dockUI = dockUI;
        this.stack = stack;
        this._stackKey = stack.key;
        this.buttonActor = buttonActor;
        this._items = [];
        this._closing = false;
        this._dragging = false;
        this._done = false;
        this._timeline = null;

        this.actor = new St.Widget({
            style_class: 'context-menu-overlay dhruva-stack-overlay',
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_expand: true,
        });
        // a press or release on a file is the file's (click, drag); anywhere else on the overlay closes the fan
        const onItem = event => {
            const src = global.stage.get_event_actor(event);
            return Boolean(src && src !== this.actor && this.layer.contains(src));
        };
        this.actor.connectObject(
            'button-press-event', (_a, event) => (onItem(event) ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP),
            'button-release-event', (_a, event) => {
                if (onItem(event)) return Clutter.EVENT_PROPAGATE;
                if (event.get_button() === Clutter.BUTTON_PRIMARY || event.get_button() === Clutter.BUTTON_SECONDARY) this.hide();
                return Clutter.EVENT_STOP;
            },
            'key-press-event', (_a, event) => this._onKey(event),
            'destroy', () => this._cleanup(),
            this);

        this.layer = new Clutter.Actor({ reactive: false });
        this.actor.add_child(this.layer);

        this._onSource = () => {
            if (!this._closing && !this._dragging) this._build(false);
        };
    }

    get kind() {
        return 'fan';
    }

    show(dockPosition) {
        this._dockPos = dockPosition;
        Main.layoutManager.addChrome(this.actor, { affectsStruts: false });
        const dock = this.dockUI.actor;
        if (isActorAlive(dock)) {
            const parent = this.actor.get_parent();
            if (parent && parent === dock.get_parent()) parent.set_child_below_sibling(this.actor, dock);
            setMagnifierPauseState(dock, 'folder-menu', true);
            dock.connectObject('button-release-event', (_a, event) => {
                if (event.get_button() === Clutter.BUTTON_PRIMARY && !dock._isDragging && !this._isOnStackButton(event)) this.hide();
                return Clutter.EVENT_PROPAGATE;
            }, this);
        }
        this.actor.set_position(0, 0);
        this.actor.set_size(global.stage.width, global.stage.height);
        Main.overview.connectObject('showing', () => this.hide(), this);
        Main.sessionMode.connectObject('updated', () => this.hide(), this);
        this.stack.source.addListener(this._onSource);

        this._build(true);
        this._previousFocus = global.stage.get_key_focus();
        global.stage.set_key_focus(this.actor);
    }

    _isOnStackButton(event) {
        const btn = this._button();
        if (!btn) return false;
        const [x, y] = event.get_coords();
        const [bx, by] = btn.get_transformed_position();
        const [bw, bh] = btn.get_transformed_size();
        return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
    }

    // the stack's button as it is now (the Dock rebuilds its buttons on every render)
    _button() {
        if (isActorAlive(this.buttonActor) && this.buttonActor.get_parent()) return this.buttonActor;
        const box = this.dockUI && this.dockUI.boxActor;
        if (!isActorAlive(box)) return null;
        const btn = box.get_children().find(c => c._stackKey === this._stackKey && isActorAlive(c));
        if (btn) this.buttonActor = btn;
        return btn || null;
    }

    _homeIcon() {
        const btn = this._button();
        return btn && btn._stackIcon && isActorAlive(btn._stackIcon) ? btn._stackIcon : btn;
    }

    _geometry() {
        const btn = this._button();
        if (!btn) return null;
        const r = restRect(btn);
        const up = this._dockPos !== 'TOP';
        const monitor = monitorOf(btn);
        const iconSz = Math.max(40, Math.min(72, (Settings.iconSize || 48) + 6));
        const pitch = iconSz + FAN.pitchExtra;
        const ax = r.x + r.w / 2;
        const ay = up ? r.y : r.y + r.h;
        let room;
        if (up) {
            const panelBottom = Main.panel && monitor === Main.layoutManager.primaryMonitor ? Main.panel.height : 0;
            room = ay - (monitor.y + panelBottom + FAN.topMargin);
        } else {
            room = monitor.y + monitor.height - FAN.topMargin - ay;
        }
        const s0 = FAN.gap + iconSz / 2;
        const slots = Math.max(1, Math.floor((room - s0 - iconSz / 2) / pitch) + 1);
        const W = FAN.labelMax + FAN.labelGap + iconSz;
        // the arc bends right, or left when the stack sits at the right edge of the screen
        const bend = ax + iconSz + 40 > monitor.x + monitor.width ? -1 : 1;
        return { btn, r, up, monitor, iconSz, pitch, ax, ay, s0, slots, W, bend };
    }

    // points along the arc at arc lengths `lengths`: {x, y, deg}
    _arc(g, lengths) {
        const out = [];
        const tilt = FAN.tiltMaxDeg * Math.PI / 180;
        let x = 0;
        let y = 0;
        let s = 0;
        const step = 1;
        for (const target of lengths) {
            while (s < target) {
                const ds = Math.min(step, target - s);
                const phi = g.bend * tilt * Math.pow((s + ds / 2) / FAN.arcRef, 2);
                x += Math.sin(phi) * ds;
                y += Math.cos(phi) * ds;
                s += ds;
            }
            let deg = g.bend * FAN.tiltMaxDeg * Math.pow(s / FAN.arcRef, 2);
            if (Math.abs(deg) < FAN.minTiltDeg) deg = 0;
            out.push({ x: g.ax + x, y: g.up ? g.ay - y : g.ay + y, deg: g.up ? deg : -deg });
        }
        return out;
    }

    _clearItems() {
        this._items.forEach(it => {
            if (isActorAlive(it.actor)) it.actor.destroy();
        });
        this._items = [];
    }

    _build(animate) {
        const g = this._geometry();
        if (!g) {
            this.hide();
            return;
        }
        this._clearItems();
        const entries = this.stack.source.entries;
        const limit = Math.max(1, Settings.raw ? Settings.raw.get_int('stack-fan-limit') : 10);
        const count = Math.max(0, Math.min(entries.length, limit, g.slots - 1));
        const lengths = [];
        for (let k = 0; k <= count; k++) lengths.push(g.s0 + k * g.pitch);
        const points = this._arc(g, lengths);
        const resScale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;

        for (let k = 0; k <= count; k++) {
            const isOpen = k === count;
            const entry = isOpen ? null : entries[k];
            const item = this._makeItem(g, entry, isOpen);
            this.layer.add_child(item.actor);
            this._layoutItem(g, item);
            const p = points[k];
            item.rest = {
                x: snap(p.x - (g.W - g.iconSz / 2), resScale),
                y: snap(p.y - g.iconSz / 2, resScale),
                cx: p.x,
                cy: p.y,
                deg: p.deg,
            };
            item.dist = Math.hypot(p.x - g.ax, p.y - g.ay);
            item.stagger = Math.min(FAN_MOTION.staggerMaxMs, item.dist * FAN_MOTION.staggerPerPx);
            this._items.push(item);
        }
        this._geom = g;

        if (!animate) {
            this._items.forEach(it => this._pose(it, 1, 1, 'rest'));
            this._done = true;
            return;
        }
        if (!motionAllowed()) {
            this._items.forEach(it => this._pose(it, 1, 1, 'rest'));
            this.layer.opacity = 0;
            this.layer.ease({
                opacity: 255,
                duration: FAN_MOTION.fadeInMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    this._done = true;
                },
            });
            return;
        }
        this._items.forEach(it => this._pose(it, 0, 0, 'open'));
        this._run('open');
    }

    _makeItem(g, entry, isOpen) {
        const H = g.iconSz;
        const actor = new St.Button({
            style_class: `dhruva-stack-item${isOpen ? ' dhruva-stack-item-open' : ''}`,
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.PRIMARY,
        });
        const body = new St.Widget({ width: g.W, height: H });
        actor.set_child(body);
        actor.set_size(g.W, H);

        let icon;
        if (isOpen) {
            const d = Math.round(g.iconSz * 0.6);
            icon = new St.Bin({
                style_class: 'dhruva-stack-open-circle',
                width: d,
                height: d,
                child: new St.Icon({ icon_name: 'go-next-symbolic', icon_size: Math.round(d * 0.5), style_class: 'dhruva-stack-open-icon' }),
            });
            icon._slot = d;
        } else {
            icon = fileIcon(entry, g.iconSz, g.iconSz);
            icon._slot = g.iconSz;
        }
        const pill = namePill(isOpen ? _('Open in Files') : entry.displayName, FAN.labelMax - 24);
        body.add_child(pill);
        body.add_child(icon);

        const item = { actor, body, icon, pill, entry, isOpen };
        actor.connectObject('clicked', () => this._activate(item), this);
        if (!isOpen) {
            item.draggable = makeFileDraggable(actor, entry, {
                iconSize: g.iconSz,
                homeActor: () => this._homeIcon(),
                onBegin: () => this._dragBegan(item),
                onEnd: () => this._dragEnded(),
            });
        }
        return item;
    }

    _layoutItem(g, item) {
        const H = g.iconSz;
        const slot = item.icon._slot;
        item.icon.set_position(Math.round(g.W - g.iconSz / 2 - slot / 2), Math.round((H - slot) / 2));
        const [, pw] = item.pill.get_preferred_width(-1);
        const [, ph] = item.pill.get_preferred_height(pw);
        const w = Math.min(Math.ceil(pw), FAN.labelMax);
        item.pill.set_size(w, Math.ceil(ph));
        item.pill.set_position(Math.round(g.W - g.iconSz - FAN.labelGap - w), Math.round((H - ph) / 2));
        // the item turns and scales around its icon's centre; it is pulled from its leading edge
        item.actor.set_pivot_point((g.W - g.iconSz / 2) / g.W, 0.5);
        item.body.set_pivot_point((g.W - g.iconSz / 2) / g.W, g.up ? 0 : 1);
    }

    // far / near: how far the leading and the trailing edge are from the stack (0) to the item's place (1)
    _pose(it, far, near, phase) {
        const g = this._geom;
        const a = it.actor;
        if (phase === 'rest') {
            a.set_position(it.rest.x, it.rest.y);
            a.set_scale(1, 1);
            a.rotation_angle_z = it.rest.deg;
            it.body.set_scale(1, 1);
            it.pill.opacity = 255;
            it.icon.opacity = 255;
            a.opacity = it.hiddenForDrag ? 0 : 255;
            return;
        }
        const cx = lerp(g.ax, it.rest.cx, far);
        const cy = lerp(g.ay, it.rest.cy, far);
        a.set_position(cx - (g.W - g.iconSz / 2), cy - g.iconSz / 2);
        const s = lerp(FAN_MOTION.fromScale, 1, Math.max(0, Math.min(1.02, far)));
        a.set_scale(s, s);
        a.rotation_angle_z = it.rest.deg * Math.max(0, far);
        const stretch = Math.min(FAN.maxStretch, Math.max(0, (far - near) * it.dist / g.iconSz * FAN.stretchGain));
        it.body.set_scale(1 / Math.sqrt(1 + stretch), 1 + stretch);
        if (phase === 'open') {
            it.pill.opacity = Math.round(255 * smoothstep(FAN_MOTION.labelFrom, 1, far));
            it.icon.opacity = Math.round(255 * smoothstep(0, 0.12, far));
        } else {
            it.icon.opacity = Math.round(255 * smoothstep(0, 0.18, far));
        }
        a.opacity = it.hiddenForDrag ? 0 : 255;
    }

    _run(phase) {
        this._phase = phase;
        this._t0 = nowMs();
        if (phase === 'close') {
            // every item closes from where it is; the far ones leave first
            const maxDist = Math.max(1, ...this._items.map(it => it.dist));
            this._items.forEach(it => {
                it.from = it.last ?? 1;
                it.closeStagger = FAN_MOTION.closeStaggerMaxMs * (1 - it.dist / maxDist);
                it.pillFrom = it.pill.opacity;
            });
        }
        if (!this._timeline) {
            this._timeline = new Clutter.Timeline({ actor: this.layer, duration: 1000, repeat_count: -1 });
            this._timeline.connect('new-frame', () => this._tick());
        }
        if (!this._timeline.is_playing()) this._timeline.start();
        this._tick();
    }

    _tick() {
        const t = (nowMs() - this._t0) / motionSlow();
        let allDone = true;
        if (this._phase === 'open') {
            for (const it of this._items) {
                const p = openProgress(t, it.stagger);
                it.last = p.far;
                if (p.done) {
                    this._pose(it, 1, 1, 'rest');
                } else {
                    allDone = false;
                    this._pose(it, p.far, p.near, 'open');
                }
            }
        } else if (this._phase === 'close') {
            for (const it of this._items) {
                const p = closeProgress(t, it.closeStagger, it.from);
                if (!p.done) allDone = false;
                // closing, the edge nearest the stack goes first and the far edge trails
                this._pose(it, p.lead, p.trail, 'close');
                it.pill.opacity = Math.round(it.pillFrom * (1 - smoothstep(0, FAN_MOTION.labelOutMs, t - it.closeStagger)));
                if (p.done) it.actor.opacity = 0;
            }
        }
        if (allDone) {
            if (this._timeline) this._timeline.stop();
            if (this._phase === 'close') this._dispose();
            else this._done = true;
        }
    }

    _activate(item) {
        if (this._closing) return;
        if (item.isOpen) openFolder(this.stack.path);
        else openEntry(item.entry);
        this.hide();
    }

    _dragBegan(item) {
        this._dragging = true;
        item.hiddenForDrag = true;
        item.actor.opacity = 0;
        // the drop target is whatever is under the pointer, never this overlay
        Shell.util_set_hidden_from_pick(this.actor, true);
        this.actor.reactive = false;
        this.hide();
    }

    _dragEnded() {
        this._dragging = false;
        if (this._closing && this._closeFinished) this._destroyNow();
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this.hide();
            return Clutter.EVENT_STOP;
        }
        const focusable = this._items.map(it => it.actor).filter(a => isActorAlive(a));
        if (sym === Clutter.KEY_Up || sym === Clutter.KEY_Down) {
            const now = focusable.indexOf(global.stage.get_key_focus());
            const step = (sym === Clutter.KEY_Up) === (this._dockPos !== 'TOP') ? 1 : -1;
            const next = now < 0 ? 0 : Math.max(0, Math.min(focusable.length - 1, now + step));
            if (focusable[next]) focusable[next].grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    hide() {
        if (this._closing) return;
        this._closing = true;
        if (this.dockUI) this.dockUI._stackClosedAt = { key: this._stackKey, t: Date.now() };
        if (this.dockUI && this.dockUI._activeFolderMenu === this) this.dockUI._activeFolderMenu = null;
        if (this.dockUI && isActorAlive(this.dockUI.actor)) {
            this.dockUI.actor.disconnectObject(this);
            setMagnifierPauseState(this.dockUI.actor, 'folder-menu', false);
        }
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        if (this.stack && this.stack.source) this.stack.source.removeListener(this._onSource);
        const focus = global.stage.get_key_focus();
        if (focus && isActorAlive(this.actor) && (focus === this.actor || this.actor.contains(focus))) {
            const prev = this._previousFocus;
            global.stage.set_key_focus(isActorAlive(prev) ? prev : null);
        }
        if (!isActorAlive(this.actor)) return;
        this.actor.reactive = false;
        if (!this._geom || this._items.length === 0) {
            this._dispose();
            return;
        }
        if (!motionAllowed()) {
            this.layer.remove_all_transitions();
            this.layer.ease({
                opacity: 0,
                duration: FAN_MOTION.fadeOutMs,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => this._dispose(),
            });
            return;
        }
        this._run('close');
    }

    // disable: no close motion, everything goes now
    destroyNow() {
        if (!this._closing) this.hide();
        this._dragging = false;
        this._destroyNow();
    }

    _dispose() {
        this._closeFinished = true;
        if (this._dragging) {
            if (isActorAlive(this.actor)) this.actor.opacity = 0;
            return;
        }
        this._destroyNow();
    }

    _destroyNow() {
        if (!isActorAlive(this.actor)) return;
        if (this.actor.get_parent()) Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }

    _cleanup() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }
        if (this.stack && this.stack.source) this.stack.source.removeListener(this._onSource);
        if (this.dockUI && isActorAlive(this.dockUI.actor)) this.dockUI.actor.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._items = [];
    }
}

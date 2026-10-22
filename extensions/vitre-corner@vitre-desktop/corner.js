/* Which corners are live, and when the capsule shows and goes.
 *
 * A corner is ARMED on every monitor that GNOME reports as full screen (Monitor.inFullscreen, the same test that hides the
 * top bar), and on the primary monitor when the top bar is hidden by a setting (Just Perfection's panel off: the panel box
 * is moved into the overview or slid off the screen). Nothing is armed in the overview or on a locked screen, so outside
 * those cases the desktop is exactly stock: no barrier, no signal handler on the pointer.
 *
 * The trigger, both ways into the very corner (the top-right one, the top-left one in a right-to-left locale):
 *   - REST: the pointer arrives in the corner's 3 x 3 px square and stays there for `dwell-ms` (150 ms). A pointer that
 *     only passes through, or that is on its way to a control near the corner, never shows it; a pointer that was already
 *     in the corner when the corner armed (a click on the app's own full-screen button there) has to leave it first.
 *   - PUSH: two short pressure barriers on the edges at the corner, GNOME's own PressureBarrier (the hot corner's), a little
 *     more sensitive than the hot corner (50 px of push within 1 s instead of 100): throwing the pointer into the corner
 *     shows it at once. Only on a real corner (no monitor beyond either edge), so a barrier never blocks the way across.
 * A drag (a button held) never triggers. The corner itself is never reactive: nothing is placed there, so a click in the
 * corner always reaches the full-screen app, before, while and after the capsule is up.
 *
 * Going away: the capsule stays while the pointer is on it, near it (12 px) or anywhere between it and its corner; when the
 * pointer leaves that, a 400 ms grace starts (a diagonal move from the corner to the button, or a small overshoot, never
 * loses it), then it stretches back into the corner. Esc or a press anywhere else dismisses it at once (the press itself
 * still reaches the app: capsule.js only reads the button state, see _watchClicks). While the Control Center is open from
 * its button it stays.
 *
 * Fail safe: every callback runs under a guard; a failure is logged once, and three failures switch the whole thing off
 * (capsule gone, barriers and handlers removed) for the rest of the session: never worse than stock. */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';

import {Battery} from './battery.js';
import {Capsule} from './capsule.js';

const ZONE = 3;                 // the resting square in the corner (logical px)
const BARRIER = 12;             // length of each pressure barrier from the corner along its edge
const PRESSURE = 50;            // px of push ...
const PRESSURE_MS = 1000;       // ... within this long
const GRACE_MS = 400;
const MAX_FAULTS = 3;
const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;

const live = {barriers: 0};     // barriers alive right now (rig: must be 0 after disable)

// The top bar is not on the desktop because of a setting (not because of a full-screen window or the overview).
export function panelHiddenBySettings() {
    const lm = Main.layoutManager;
    const box = lm?.panelBox;
    if (!box || !Main.panel || lm._startingUp || Main.overview.visible)
        return false;
    if (lm.primaryMonitor?.inFullscreen)
        return false;
    const onDesktop = box.get_parent() === lm.uiGroup;
    const shown = box.visible && Main.panel.visible && box.opacity > 0;
    const inPlace = Math.abs(box.translation_y) < Math.max(1, box.height) / 2;
    return !(onDesktop && shown && inPlace);
}

export class CornerWatch {
    constructor({settings, path}) {
        this._settings = settings;
        this._corners = new Map();       // monitor index -> corner
        this._logged = new Set();
        this._faults = 0;
        this._broken = false;
        this._dwellId = 0;
        this._graceId = 0;
        this._syncId = 0;
        this._zone = -1;                 // the corner whose square the pointer is resting in (dwell running or done)
        this._latched = -1;              // a corner the pointer must leave before it can show the capsule again
        this._lastTrigger = null;
        this._triggers = {dwell: 0, pressure: 0};
        this._pointerId = 0;
        this._battery = null;
        this._capsule = null;
        try {
            this._start(path);
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    _start(path) {
        this._tracker = global.backend.get_cursor_tracker();
        this._battery = new Battery(() => this._capsule?.batteryChanged());
        this._capsule = new Capsule({
            iconPath: path,
            battery: this._battery,
            onClosed: () => this._guard('closed', () => this._capsuleClosed()),
            onMenuChanged: open => this._guard('menu', () => this._menuChanged(open)),
            onDismiss: why => this._guard('dismiss', () => this._dismiss(why)),
        });

        global.display.connectObject('in-fullscreen-changed', () => this._queueSync(), this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._guard('monitors', () => this._rebuild()),
            'startup-complete', () => this._queueSync(), this);
        Main.overview.connectObject(
            'showing', () => this._guard('overview', () => this._sync()),
            'hidden', () => this._queueSync(), this);
        Main.sessionMode.connectObject('updated', () => this._queueSync(), this);
        Main.layoutManager.panelBox.connectObject(
            'notify::visible', () => this._queueSync(),
            'notify::translation-y', () => this._queueSync(),
            'notify::opacity', () => this._queueSync(),
            'parent-set', () => this._queueSync(), this);
        Main.panel.connectObject('notify::visible', () => this._queueSync(), this);
        this._settings.connectObject('changed::enabled', () => this._queueSync(), this);
        this._sync();
    }

    // ---- guard ------------------------------------------------------------------------------------------------------

    _guard(name, fn) {
        if (this._broken)
            return undefined;
        try {
            return fn();
        } catch (e) {
            this._faults++;
            if (!this._logged.has(name)) {
                this._logged.add(name);
                console.error(`Vitre Corner: ${name} failed: ${e?.message ?? e}\n${e?.stack ?? ''}`);
            }
            if (this._faults >= MAX_FAULTS)
                this._failSafe();
            return undefined;
        }
    }

    _failSafe() {
        if (this._broken)
            return;
        this._broken = true;
        console.error('Vitre Corner: switched off for this session after repeated failures');
        try {
            this._capsule.close(true);
        } catch (_e) {
            // keep going: the rest must still be removed
        }
        for (const index of [...this._corners.keys()])
            this._disarm(index);
        this._untrackPointer();
        this._clearDwell();
        this._clearGrace();
    }

    // ---- which corners are armed --------------------------------------------------------------------------------------

    _queueSync() {
        if (this._syncId || this._broken)
            return;
        // the panel's visibility and the full-screen state change together: decide once, after both
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            this._guard('sync', () => this._sync());
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._syncId, '[vitre-corner] sync');
    }

    _wanted() {
        const wanted = new Set();
        const mode = Main.sessionMode;
        if (this._broken || !this._settings.get_boolean('enabled') || !mode.hasWindows || mode.isLocked || mode.isGreeter ||
            Main.overview.visible || Main.layoutManager._startingUp)
            return wanted;
        const primary = Main.layoutManager.primaryIndex;
        const hiddenBar = panelHiddenBySettings();
        for (const m of Main.layoutManager.monitors) {
            if (m.inFullscreen || (m.index === primary && hiddenBar))
                wanted.add(m.index);
        }
        return wanted;
    }

    _sync() {
        const wanted = this._wanted();
        for (const index of [...this._corners.keys()]) {
            if (!wanted.has(index))
                this._disarm(index);
        }
        for (const index of wanted) {
            if (!this._corners.has(index))
                this._arm(index);
        }
        if (this._corners.size)
            this._trackPointer();
        else
            this._untrackPointer();
        // its monitor is no longer armed (the top bar is back, the overview opens): the capsule goes in the same frame
        if (this._capsule.isUp && !this._corners.has(this._capsule.monitorIndex))
            this._capsule.close(true);
        if (this._zone >= 0 && !this._corners.has(this._zone)) {
            this._zone = -1;
            this._clearDwell();
        }
    }

    _rebuild() {
        this._capsule.close(true);
        for (const index of [...this._corners.keys()])
            this._disarm(index);
        this._sync();
    }

    _arm(index) {
        const m = Main.layoutManager.monitors[index];
        if (!m)
            return;
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const corner = {
            index, x: m.x, y: m.y, width: m.width, height: m.height, rtl,
            scale: global.display.get_monitor_scale(index),
            cornerX: rtl ? m.x : m.x + m.width, cornerY: m.y,
            barriers: [], pressure: null,
        };
        if (this._isRealCorner(m, rtl))
            this._addBarriers(corner);
        this._corners.set(index, corner);
        const [px, py] = global.get_pointer();
        if (this._inZone(corner, px, py))
            this._latched = index;
        this._capsule.prewarm();
    }

    _disarm(index) {
        const corner = this._corners.get(index);
        if (!corner)
            return;
        this._corners.delete(index);
        this._removeBarriers(corner);
        if (this._latched === index)
            this._latched = -1;
    }

    // GNOME's hot-corner test, mirrored: no other monitor just beyond the side edge or just above the top edge
    _isRealCorner(m, rtl) {
        const beside = [rtl ? m.x - 1 : m.x + m.width, m.y];
        const above = [rtl ? m.x : m.x + m.width - 1, m.y - 1];
        const inside = (o, [px, py]) => px >= o.x && px < o.x + o.width && py >= o.y && py < o.y + o.height;
        return !Main.layoutManager.monitors.some(o => o.index !== m.index && (inside(o, beside) || inside(o, above)));
    }

    _addBarriers(corner) {
        try {
            const pressure = new Layout.PressureBarrier(PRESSURE, PRESSURE_MS, Shell.ActionMode.NORMAL);
            // Only a push INTO the corner's edges counts, and never a drag (a button held). A barrier made under a pointer
            // that rests on it reports a hit when that pointer moves away from the corner (measured in the rig: the
            // capsule came up as the pointer left); such a hit points away from both edges.
            pressure.setEventFilter(event => {
                if ((global.get_pointer()[2] & BUTTONS) !== 0)
                    return true;
                const intoSide = corner.rtl ? event.dx < 0 : event.dx > 0;
                return !(intoSide || event.dy < 0);
            });
            pressure.connect('trigger', () => this._guard('pressure', () => this._onPressure(corner)));
            const {cornerX: x, cornerY: y, rtl} = corner;
            const vertical = new Meta.Barrier({
                backend: global.backend, x1: x, x2: x, y1: y, y2: y + BARRIER,
                directions: rtl ? Meta.BarrierDirection.POSITIVE_X : Meta.BarrierDirection.NEGATIVE_X,
            });
            live.barriers++;
            corner.barriers.push(vertical);
            const horizontal = new Meta.Barrier({
                backend: global.backend, x1: rtl ? x : x - BARRIER, x2: rtl ? x + BARRIER : x, y1: y, y2: y,
                directions: Meta.BarrierDirection.POSITIVE_Y,
            });
            live.barriers++;
            corner.barriers.push(horizontal);
            pressure.addBarrier(vertical);
            pressure.addBarrier(horizontal);
            corner.pressure = pressure;
        } catch (e) {
            // the rest of the corner still works by resting there
            if (!this._logged.has('barrier')) {
                this._logged.add('barrier');
                console.warn(`Vitre Corner: no pressure barrier (${e.message}); the corner still shows the capsule on rest`);
            }
            this._removeBarriers(corner);
        }
    }

    _removeBarriers(corner) {
        const pressure = corner.pressure;
        corner.pressure = null;
        if (pressure) {
            try {
                pressure.destroy();      // disconnects every barrier it was given
            } catch (_e) {
                // keep removing the barriers themselves
            }
        }
        for (const barrier of corner.barriers.splice(0)) {
            try {
                barrier.destroy();
            } catch (_e) {
                // already gone with the backend
            }
            live.barriers--;
        }
    }

    // ---- the pointer ------------------------------------------------------------------------------------------------

    _trackPointer() {
        if (this._pointerId)
            return;
        this._pointerId = this._tracker.connect('position-invalidated', () => this._guard('pointer', () => this._onPointer()));
    }

    _untrackPointer() {
        if (!this._pointerId)
            return;
        this._tracker.disconnect(this._pointerId);
        this._pointerId = 0;
    }

    _inZone(corner, x, y) {
        const inX = corner.rtl ? x < corner.cornerX + ZONE : x >= corner.cornerX - ZONE;
        return inX && y < corner.cornerY + ZONE && y >= corner.cornerY && x >= corner.x && x < corner.x + corner.width;
    }

    _cornerAt(x, y) {
        for (const corner of this._corners.values()) {
            if (this._inZone(corner, x, y))
                return corner;
        }
        return null;
    }

    _onPointer() {
        const [x, y, mods] = global.get_pointer();
        const capsule = this._capsule;
        if (capsule.isUp) {
            if (capsule.menuActive || capsule.holds(x, y)) {
                this._clearGrace();
                return;
            }
            this._startGrace();
            // on its way out the pointer may rest in another full-screen monitor's corner: that one can start its own dwell
        }
        const corner = this._cornerAt(x, y);
        if (this._latched >= 0) {
            const latched = this._corners.get(this._latched);
            if (!latched || !this._inZone(latched, x, y))
                this._latched = -1;
        }
        if (!corner) {
            if (this._zone >= 0) {
                this._zone = -1;
                this._clearDwell();
            }
            return;
        }
        if (corner.index === this._latched || corner.index === this._zone || (mods & BUTTONS))
            return;
        this._zone = corner.index;
        this._startDwell(corner);
    }

    _startDwell(corner) {
        this._clearDwell();
        const ms = this._settings.get_uint('dwell-ms');
        if (ms <= 0) {
            this._show(corner, 'dwell');
            return;
        }
        this._dwellId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._dwellId = 0;
            this._guard('dwell', () => {
                const [x, y, mods] = global.get_pointer();
                if (this._corners.get(corner.index) === corner && this._inZone(corner, x, y) && !(mods & BUTTONS))
                    this._show(corner, 'dwell');
                else
                    this._zone = -1;
            });
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._dwellId, '[vitre-corner] dwell');
    }

    _clearDwell() {
        if (this._dwellId) {
            GLib.source_remove(this._dwellId);
            this._dwellId = 0;
        }
    }

    _onPressure(corner) {
        if (this._corners.get(corner.index) !== corner)
            return;
        // a real push leaves the pointer held against the edges at the corner
        const [x, y] = global.get_pointer();
        const nearSide = corner.rtl ? x <= corner.cornerX + BARRIER + 1 : x >= corner.cornerX - BARRIER - 1;
        if (!nearSide || y > corner.cornerY + BARRIER + 1)
            return;
        if (this._capsule.isUp && this._capsule.monitorIndex === corner.index && this._capsule.drip.phase !== 'closing')
            return;
        // a push is a request even where a resting pointer would have to leave first
        this._latched = -1;
        this._zone = corner.index;
        this._show(corner, 'pressure');
    }

    _show(corner, why) {
        this._clearDwell();
        this._clearGrace();
        this._lastTrigger = why;
        this._triggers[why]++;
        this._capsule.open(corner);
    }

    _startGrace() {
        if (this._graceId)
            return;
        this._graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GRACE_MS, () => {
            this._graceId = 0;
            this._guard('grace', () => {
                const [x, y] = global.get_pointer();
                const capsule = this._capsule;
                if (capsule.isUp && !capsule.menuActive && !capsule.holds(x, y))
                    capsule.close(false);
            });
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._graceId, '[vitre-corner] grace');
    }

    _clearGrace() {
        if (this._graceId) {
            GLib.source_remove(this._graceId);
            this._graceId = 0;
        }
    }

    // Esc, or a press outside the capsule
    _dismiss(_why) {
        this._clearGrace();
        this._capsule.close(false);
    }

    // the Control Center opened or closed from the capsule's button
    _menuChanged(open) {
        if (open)
            this._clearGrace();
        else
            this._onPointer();      // the pointer may already be elsewhere: the grace starts now
    }

    // the capsule is gone (any way): a pointer still resting in the corner must leave before it shows it again
    _capsuleClosed() {
        this._clearGrace();
        const [x, y] = global.get_pointer();
        const corner = this._cornerAt(x, y);
        this._latched = corner ? corner.index : -1;
        this._zone = -1;
    }

    // ---- rig ----------------------------------------------------------------------------------------------------------

    snapshot() {
        return {
            armed: [...this._corners.keys()],
            corners: [...this._corners.values()].map(c => ({index: c.index, cornerX: c.cornerX, cornerY: c.cornerY, rtl: c.rtl,
                scale: c.scale, barriers: c.barriers.length})),
            barriersAlive: live.barriers, tracking: Boolean(this._pointerId), latched: this._latched, zone: this._zone,
            dwell: Boolean(this._dwellId), grace: Boolean(this._graceId), lastTrigger: this._lastTrigger,
            triggers: {...this._triggers}, broken: this._broken, faults: this._faults,
            battery: this._battery.info, capsule: this._capsule.snapshot(),
        };
    }

    get capsule() {
        return this._capsule;
    }

    destroy() {
        this._broken = true;            // no callback does anything from here on
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        this._clearDwell();
        this._clearGrace();
        this._untrackPointer();
        for (const index of [...this._corners.keys()])
            this._disarm(index);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.layoutManager.panelBox?.disconnectObject(this);
        Main.panel?.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._capsule?.destroy();
        this._capsule = null;
        this._battery?.destroy();
        this._battery = null;
        this._settings = null;
    }
}

// rig: barriers alive right now in this module (0 after disable)
export function liveBarriers() {
    return live.barriers;
}

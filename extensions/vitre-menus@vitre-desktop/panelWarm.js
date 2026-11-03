/* The first open of a top-bar panel in a session (Control Center, Notification Center, Logo Menu, ...) used to hitch:
 * GNOME draws that panel for the first time then (text, icons, theme textures), 70-300 ms in one frame, the same with the
 * drip off (B19b, rig `dripclock` ghost=0 vs 1). Here every panel is painted once while the session is idle shortly after
 * login, at 1/255 opacity and out of the pick (it cannot be seen or clicked), so the first real open finds it drawn.
 *
 * The paint was not the whole of it (polish-hitch, 2026-11-01): after it the first real open still took 18-28 ms in toggle()
 * alone (Notification Center, Control Center; 12-14 ms for the Logo Menu) and then 2-4 frames over 16.7 ms, against 3-5 ms and
 * clean frames for the second open. That time is GNOME's open path and every extension's open handler running for the first
 * time (style, map, Liquid Glass, Blur my Shell, Just Perfection, Rounded Window Corners, Vitre's own), which a paint does not
 * run. So each panel is also opened and closed once, instantly and in the same turn of the main loop: no frame is drawn
 * between the two calls, so nothing of it can be seen, and the code the first real open would have run for the first time has
 * run. Only while nobody could notice (see _gate): no input for 2.5 s, no grab, no fullscreen window, no banner on screen, no
 * screen reader. If the user stays busy a panel gets the paint alone, as before.
 *
 * One panel at a time, a few hundred ms apart; never while a menu is open, the screen is locked or the overview is up (it
 * then tries again later). Nothing of a menu's own state is left changed.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FIRST_MS = 9000;      // after the drips' own prewarm (3.5 s + 0.45 s per controller)
const GAP_MS = 400;
const RETRY_MS = 5000;
const HOLD_MS = 60;         // the panel stays painted this long (a frame or two)
const IDLE_MS = 2500;       // the user has not touched the keyboard, pointer or touch for this long before a panel is opened and closed
const PAIR_TRIES = 6;       // the user is busy this many passes in a row (30 s): no more open-and-close passes, only the paint, as before

export class PanelWarm {
    constructor() {
        this._done = new WeakSet();
        this._opened = new WeakSet();        // panels whose open-and-close pass is over
        this._busyTries = 0;                 // passes in a row in which the user was not idle
        this._paintOnly = false;             // the user stayed busy PAIR_TRIES times in a row: no more open-and-close passes
        this._current = null;
        this.done = false;          // true once every panel has been drawn (the rig waits for it before counting actors)
        this.pairs = 0;             // panels opened and closed at once so far (the rig reads it)
        this.lastGate = '';         // what the last check found in the way (the rig reads it)
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, FIRST_MS, () => this._next());
    }

    destroy() {
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = 0;
        this._a11y = null;
        this._restore();
    }

    _busy() {
        return Main.sessionMode.isLocked || Main.overview.visible || Boolean(Main.panel.menuManager?.activeMenu);
    }

    // Nobody could notice, lose a key press or have a banner put away: no modal grab, no input for IDLE_MS, no fullscreen window
    // (a video must not stall), no notification on screen, no screen reader (it would announce the menu). Returns what stands in the
    // way ('' when nothing does); the first reason is logged once.
    _gate() {
        let why = '';
        try {
            if (Main.modalCount > 0)
                why = 'a modal grab is held';
            else if (Main.messageTray?._notification)
                why = 'a notification is on screen';
            else if (global.backend.get_core_idle_monitor().get_idletime() < IDLE_MS)
                why = 'there was input in the last 2.5 s';
            else if (global.get_window_actors().some(a => a.meta_window?.is_fullscreen?.()))
                why = 'a window is fullscreen';
            else {
                this._a11y ??= new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.applications'});
                if (this._a11y.get_boolean('screen-reader-enabled'))
                    why = 'a screen reader is on';
            }
        } catch (e) {
            why = `the check failed (${e.message})`;
        }
        this.lastGate = why;
        if (why && !this._logged) {
            this._logged = true;
            console.log(`Liquid Menus: panel warm-up waits: ${why}`);
        }
        return why;
    }

    // Open and close a panel at once, in this turn of the main loop (see the header). Always closed again, whatever happens.
    _openAndClose(menu) {
        try {
            menu.open({animate: false});
        } catch (e) {
            console.warn(`Liquid Menus: panel warm-up open failed (${e.message})`);
        } finally {
            if (menu.isOpen) {
                try {
                    menu.close({animate: false});
                } catch (e) {
                    console.warn(`Liquid Menus: panel warm-up close failed (${e.message})`);
                }
            }
        }
    }

    _restore() {
        const c = this._current;
        this._current = null;
        if (!c || !c.box.get_stage?.())
            return;
        if (!c.wasVisible)
            c.box.hide();
        c.box.opacity = c.opacity;
        Shell.util_set_hidden_from_pick(c.box, false);
    }

    _next() {
        this._timer = 0;
        this._restore();
        if (this._busy()) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, RETRY_MS, () => this._next());
            return GLib.SOURCE_REMOVE;
        }
        const entry = Object.entries(Main.panel.statusArea)
            .map(([key, button]) => ({key, button, menu: button?.menu, box: button?.menu?.actor}))
            .find(e => e.box && !this._done.has(e.box) && e.box.get_stage?.() && !e.box.visible);
        if (!entry) {
            this.done = true;
            return GLib.SOURCE_REMOVE;          // every panel has been drawn once
        }
        const {key, button, menu, box} = entry;
        // An indicator that is not on screen cannot be opened by anyone yet, and a tray icon's menu belongs to another process (opening
        // it tells that application "about to show"): both only get the paint.
        const ours = button.mapped && button.visible && !key.startsWith('appindicator-');
        if (!this._paintOnly && !this._opened.has(box) && typeof menu.open === 'function' && ours) {
            if (!this._gate()) {
                this._busyTries = 0;
                this._opened.add(box);
                this.pairs++;
                this._openAndClose(menu);
                if (box.visible)
                    box.hide();                 // a menu that did not close (cannot happen) is put away before the paint
            } else if (++this._busyTries <= PAIR_TRIES) {
                this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, RETRY_MS, () => this._next());
                return GLib.SOURCE_REMOVE;      // the user is busy: this panel again in a few seconds
            } else {
                this._paintOnly = true;         // busy all the time: paint the rest, as before
            }
        }
        this._done.add(box);
        this._current = {box, opacity: box.opacity, wasVisible: box.visible};
        Shell.util_set_hidden_from_pick(box, true);
        box.opacity = 1;
        box.show();
        box.queue_redraw();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
            this._timer = 0;
            this._restore();
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, GAP_MS, () => this._next());
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    }
}

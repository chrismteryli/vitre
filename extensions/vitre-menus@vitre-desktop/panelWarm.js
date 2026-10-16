/* The first open of a top-bar panel in a session (Control Center, Notification Center, Logo Menu, ...) used to hitch:
 * GNOME draws that panel for the first time then (text, icons, theme textures), 70-300 ms in one frame, the same with the
 * drip off (B19b, rig `dripclock` ghost=0 vs 1). Here every panel is painted once while the session is idle shortly after
 * login, at 1/255 opacity and out of the pick (it cannot be seen or clicked), so the first real open finds it drawn.
 *
 * One panel at a time, a few hundred ms apart; never while a menu is open, the screen is locked or the overview is up (it
 * then tries again later). Nothing of a menu's own state changes: the panel's actor is only shown and hidden again.
 */
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FIRST_MS = 9000;      // after the drips' own prewarm (3.5 s + 0.45 s per controller)
const GAP_MS = 400;
const RETRY_MS = 5000;
const HOLD_MS = 60;         // the panel stays painted this long (a frame or two)

export class PanelWarm {
    constructor() {
        this._done = new WeakSet();
        this._current = null;
        this.done = false;          // true once every panel has been drawn (the rig waits for it before counting actors)
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, FIRST_MS, () => this._next());
    }

    destroy() {
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = 0;
        this._restore();
    }

    _busy() {
        return Main.sessionMode.isLocked || Main.overview.visible || Boolean(Main.panel.menuManager?.activeMenu);
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
        const box = Object.values(Main.panel.statusArea)
            .map(button => button?.menu?.actor)
            .find(a => a && !this._done.has(a) && a.get_stage?.() && !a.visible);
        if (!box) {
            this.done = true;
            return GLib.SOURCE_REMOVE;          // every panel has been drawn once
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

/* The liquid drip for the menus apps draw themselves (B15, 2026-10-15).
 *
 * A GTK 4 / GTK 3 / Electron menu is its own small popup window (Meta.WindowType DROPDOWN_MENU, POPUP_MENU, MENU, COMBO).
 * The app draws it, but the shell maps it: when one maps right after a click or a key (so tooltips, which appear after the
 * pointer has rested, are left alone), the popup is hidden and the same drip as the top-bar menus runs: a drop pulls out of
 * the spot that was clicked, swells, falls to the menu's top and blooms into its shape in glass tinted to the menu's own
 * colour, then the real menu takes over. When the popup goes away, the glass takes its place at once and retracts into the
 * same spot (the app has already destroyed the menu, so there is no content to fade).
 *
 * One controller serves every app menu (there is one open at a time; a new one ends the old one's drip at once).
 * drip-style `classic`, animations off or reduced motion: nothing happens, the menus appear as GNOME shows them.
 */
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DripController, op255, motionAllowed} from './liquidDrip.js';
import {DRIP} from './dripMotion.js';
import {GLASS_FINISH} from './glass.js';

const TYPES = new Set([Meta.WindowType.DROPDOWN_MENU, Meta.WindowType.POPUP_MENU, Meta.WindowType.MENU, Meta.WindowType.COMBO]);
const FRESH_INPUT_MS = 400;     // the popup maps within this long after a click: a menu, not a tooltip
const NEAR_PX = 80;             // ... and the pointer is on it or this close to its top or sides
const MIN_W = 60, MIN_H = 40;   // smaller popups (completion hints, tiny tooltips) are left alone
const ARROW_PX = 13;            // GTK 4 popovers that point up at their button have an arrow this tall above the menu
const RADIUS = 14;              // the popover corner (a18-chrome.css B15)
const PILL_W = 34, PILL_H = 18; // the drop pulls out of a pill this size at the spot that was clicked
// the menu's own colour (@popover_bg_color as painted, dark): the glass is tinted to it so the hand-over is seamless
const MENU_LOOK = {tint: 0.72, tintColor: [53 / 255, 53 / 255, 58 / 255]};

class AppMenuAdapter {
    constructor() {
        this.sharedField = true;
        this.target = null;      // {actor, win, pill, rect, arrow, dead}
    }

    get handoffMs() {
        return DRIP.handoffMs;
    }

    get finish() {
        return {...GLASS_FINISH, ...MENU_LOOK};
    }

    canDrip() {
        const t = this.target;
        return Boolean(t && !t.dead && t.actor.get_parent());
    }

    _rect() {
        const t = this.target;
        if (!t)
            return null;
        if (!t.dead) {
            try {
                const f = t.win.get_frame_rect();
                if (f.width >= MIN_W && f.height >= MIN_H) {
                    const top = t.arrow ? ARROW_PX : 0;
                    t.rect = {x: f.x, y: f.y + top, w: f.width, h: f.height - top};
                }
            } catch (_e) {
                t.dead = true;
            }
        }
        return t.rect;
    }

    geometry(_rest = false) {
        const t = this.target;
        const rect = this._rect();
        if (!t || !rect)
            return null;
        const r = Math.min(RADIUS, rect.w / 2, rect.h / 2);
        return {pill: {...t.pill, keep: false}, pieces: [{id: 'menu', ...rect, r, row: 0}]};
    }

    maskActor() {
        return null;            // the popup is one picture (glass and text together): it fades in whole at the hand-over
    }

    begin() {
        const t = this.target;
        if (t && !t.dead)
            t.actor.opacity = 0;
    }

    setPiece(_id, {real}) {
        const t = this.target;
        if (t && !t.dead)
            t.actor.opacity = op255(real);     // the real menu (glass and text in one picture) arrives with the hand-over only
    }

    end() {
        const t = this.target;
        if (t && !t.dead)
            t.actor.opacity = 255;
    }
}

export class AppMenuDrips {
    constructor(style) {
        this._style = style;
        this._adapter = new AppMenuAdapter();
        this._controller = new DripController('appmenu', this._adapter, {prewarm: 1, prewarmIf: () => this._style.liquid});
        this._controller.callbacks.onClosed = () => {
            if (this._adapter.target?.dead)
                this._adapter.target = null;
        };
        this._ids = [];
        const wm = global.window_manager;
        // after GNOME's own handlers (connected at startup): GNOME maps menus without an animation, so the actor is
        // already shown when this runs; it is hidden again before the frame is painted
        this._ids.push(wm.connect('map', (_wm, actor) => this._guard(() => this._onMap(actor))));
        this._ids.push(wm.connect('destroy', (_wm, actor) => this._guard(() => this._onGone(actor))));
    }

    destroy() {
        for (const id of this._ids)
            global.window_manager.disconnect(id);
        this._ids = [];
        this._controller.destroy();
        const t = this._adapter.target;
        if (t && !t.dead)
            t.actor.opacity = 255;
        this._adapter.target = null;
    }

    _guard(fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`Liquid Menus: app menu drip skipped (${e.message})`);
            const t = this._adapter.target;
            if (t && !t.dead)
                t.actor.opacity = 255;
        }
    }

    _wanted(actor) {
        const win = actor?.meta_window;
        if (!win || !TYPES.has(win.get_window_type()))
            return false;
        if (!this._style.liquid || !motionAllowed() || Main.overview.visible || Main.sessionMode.isLocked)
            return false;
        const f = win.get_frame_rect();
        if (f.width < MIN_W || f.height < MIN_H)
            return false;
        // a menu opens on a click; a tooltip after the pointer has rested
        const idle = global.backend.get_core_idle_monitor().get_idletime();
        if (idle > FRESH_INPUT_MS)
            return false;
        // ... next to the pointer (the button it hangs from, or the spot of a right click). Suggestion lists that follow
        // typing (a browser's address bar) open wherever the text field is, usually far from the pointer: no drip for those.
        const [px, py] = global.get_pointer();
        return px >= f.x - NEAR_PX && px <= f.x + f.width + NEAR_PX && py >= f.y - NEAR_PX && py <= f.y + f.height;
    }

    _onMap(actor) {
        if (!this._wanted(actor))
            return;
        // a drip still running for an earlier menu ends at once
        if (this._adapter.target)
            this._controller.reset();
        const win = actor.meta_window;
        const f = win.get_frame_rect();
        const [px, py] = global.get_pointer();
        // the drop pulls out of the spot that was clicked when it is just above the menu (a button), else out of the
        // menu's top centre (a key, or a context menu that opens at the pointer)
        const above = py <= f.y + 4 && py >= f.y - 80 && px >= f.x - 40 && px <= f.x + f.width + 40;
        const cx = above ? Math.min(f.x + f.width - PILL_W / 2, Math.max(f.x + PILL_W / 2, px)) : f.x + f.width / 2;
        const cy = above ? Math.min(py, f.y - PILL_H / 2) : f.y - PILL_H / 2 + 2;
        const target = {actor, win, dead: false, rect: null, arrow: above && win.get_client_type() === Meta.WindowClientType.WAYLAND,
            pill: {x: cx - PILL_W / 2, y: cy - PILL_H / 2, w: PILL_W, h: PILL_H}};
        actor.connectObject('destroy', () => {
            target.dead = true;
        }, this);
        this._adapter.target = target;
        actor.opacity = 0;
        this._controller.open();
    }

    _onGone(actor) {
        const t = this._adapter.target;
        if (!t || t.actor !== actor)
            return;
        this._adapter._rect();      // the last rectangle, while the window still answers
        t.dead = true;
        actor.disconnectObject(this);
        if (!this._style.liquid || !motionAllowed()) {
            this._controller.reset();
            this._adapter.target = null;
            return;
        }
        this._controller.close();
    }
}

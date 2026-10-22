/* The liquid drip for the Dock's own menus (B16): Dhruva's app menu (right-click an icon) and its folder stacks.
 *
 * They are Dhruva's widgets, not GNOME menus: each shows by fading its `menuContainer` in (opacity 0 -> 255, 180 ms) and hides
 * by fading it out with a slight shrink (120 ms, then destroys itself). Here those two eases are taken over for a Dock at the
 * bottom or the top: the drop rises out of the icon that was clicked (the drip computed falling in a mirrored space, see
 * liquidDrip.js flipAxis) and blooms into the menu, then the menu takes over; closing retracts into the icon and then lets
 * Dhruva destroy it. A Dock on the left or right keeps Dhruva's fade. Escape now closes these menus too (they had no key
 * handler, so a menu opened by mistake could only be closed with a click outside).
 *
 * The classes are patched on their prototypes (show) through Dhruva's own module (same file URL, so the same module
 * instance), and each menu's container gets an own `ease` wrapper for its lifetime. disable() puts everything back.
 */
import Clutter from 'gi://Clutter';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DripController, highlightRect, op255, motionAllowed} from './liquidDrip.js';
import {DRIP} from './dripMotion.js';
import {GLASS_FINISH} from './glass.js';

const DOCK_UUIDS = ['vitre-dock@vitre-desktop', 'dhruva@narkagni'];   // Vitre Dock first, a Dock kept under the upstream name second
const MODULES = ['src/ui/context-menu/AppContextMenu.js', 'src/ui/folder-menu/FolderMenu.js'];
const ARROW = 12;           // Dhruva's ARROW_HEIGHT
const RADIUS = 18;          // Dhruva's CORNER_RADIUS
const DOCK_LOOK = {tint: 0.5, tintColor: [0.07, 0.07, 0.09]};

class DockMenuAdapter {
    constructor() {
        this.sharedField = true;
        this.menu = null;           // the Dhruva menu being dripped
        this.rest = null;           // its last body rectangle (real space), for a close after it is gone
        this.pillRest = null;
    }

    get handoffMs() {
        return DRIP.handoffMs;
    }

    get finish() {
        return {...GLASS_FINISH, ...DOCK_LOOK};
    }

    get _up() {
        return this.menu?._dockPos === 'BOTTOM';
    }

    // the drip falls downward; a menu above its icon (Dock at the bottom) is computed mirrored about y = 0
    get flipAxis() {
        return this._up ? 0 : undefined;
    }

    _alive(actor) {
        return Boolean(actor && !actor._vitreGone && actor.get_parent());
    }

    canDrip() {
        const m = this.menu;
        return Boolean(m && this._alive(m.menuContainer) && m.buttonActor?.mapped);
    }

    geometry() {
        const m = this.menu;
        if (m && this._alive(m.menuContainer) && m.buttonActor?.mapped) {
            const [x, y] = m.menuContainer.get_transformed_position();
            const [w, h] = m.menuContainer.get_transformed_size();
            if (w > 8 && h > 8 && [x, y, w, h].every(Number.isFinite)) {
                // the body without the arrow (towards the Dock)
                this.rest = this._up ? {x, y, w, h: h - ARROW} : {x, y: y + ARROW, w, h: h - ARROW};
                this.pillRest = highlightRect(m.buttonActor);
            }
        }
        if (!this.rest || !this.pillRest)
            return null;
        const flip = r => this._up ? {...r, y: -(r.y + r.h)} : {...r};
        const body = flip(this.rest);
        const r = Math.min(RADIUS, body.w / 2, body.h / 2);
        return {pill: {...flip(this.pillRest), keep: false}, pieces: [{id: 'menu', ...body, r, row: 0}]};
    }

    maskActor() {
        return null;
    }

    begin() {
        const c = this.menu?.menuContainer;
        if (this._alive(c))
            c.opacity = 0;
    }

    setPiece(_id, {real}) {
        const c = this.menu?.menuContainer;
        if (this._alive(c))
            c.opacity = op255(real);
    }

    end() {
        const c = this.menu?.menuContainer;
        if (this._alive(c))
            c.opacity = 255;
    }
}

export class DockMenuDrips {
    constructor(style) {
        this._style = style;
        this._adapter = new DockMenuAdapter();
        this._controller = new DripController('dockmenu', this._adapter, {prewarm: 1, prewarmIf: () => this._style.liquid});
        this._injections = new InjectionManager();
        this._attached = new Map();
        this._pending = null;
        this._dead = false;
        this._load();
    }

    async _load() {
        const path = DOCK_UUIDS.map(u => Extension.lookupByUUID(u)).find(Boolean)?.path;
        if (!path)
            return;
        for (const rel of MODULES) {
            try {
                const mod = await import(`file://${path}/${rel}`);
                if (this._dead)
                    return;
                const cls = mod.default;
                if (typeof cls?.prototype?.show !== 'function')
                    continue;
                const self = this;
                this._injections.overrideMethod(cls.prototype, 'show', original => function (...args) {
                    const result = original.apply(this, args);
                    try {
                        self._attach(this);
                    } catch (e) {
                        console.warn(`Liquid Menus: a Dock menu kept its fade (${e.message})`);
                    }
                    return result;
                });
            } catch (e) {
                console.warn(`Liquid Menus: Dock menus not found (${e.message})`);
            }
        }
    }

    destroy() {
        this._dead = true;
        this._injections.clear();
        this._controller.destroy();
        this._finishPending(false);
        for (const [c, {actor, ease, wrapper}] of this._attached) {
            if (c._vitreGone)
                continue;
            if (c.ease === wrapper)
                c.ease = ease;
            delete c._vitreEase;
            c.disconnectObject(this);
            actor?.disconnectObject(this);
        }
        this._attached.clear();
        const m = this._adapter.menu;
        if (m?.menuContainer && !m.menuContainer._vitreGone)
            m.menuContainer.opacity = 255;
        this._adapter.menu = null;
    }

    _wanted(menu) {
        const pos = menu._dockPos;
        return !this._dead && this._style.liquid && motionAllowed() && (pos === 'BOTTOM' || pos === 'TOP');
    }

    _attach(menu) {
        const c = menu.menuContainer;
        if (!c || c._vitreEase)
            return;
        c.connectObject('destroy', () => {
            c._vitreGone = true;
            this._attached.delete(c);
            if (this._adapter.menu === menu) {
                this._controller.reset();
                this._adapter.menu = null;
                this._finishPending(false);
            }
        }, this);
        // Escape closes the menu (Dhruva gives it the key focus but has no key handler)
        menu.actor?.connectObject('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                menu.hide();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }, this);
        const self = this;
        const ease = c.ease;
        c._vitreEase = true;
        c.ease = function (props) {
            try {
                if (props && 'opacity' in props && self._wanted(menu)) {
                    const rest = {...props};
                    delete rest.opacity;
                    delete rest.scale_x;
                    delete rest.scale_y;
                    const onComplete = rest.onComplete;
                    const onStopped = rest.onStopped;
                    delete rest.onComplete;
                    delete rest.onStopped;
                    if (props.opacity >= 255) {
                        if (Object.keys(rest).some(k => k !== 'duration' && k !== 'mode' && k !== 'delay'))
                            ease.call(this, rest);
                        self._open(menu, onComplete, onStopped);
                        return;
                    }
                    if (props.opacity === 0 && self._close(menu, onComplete, onStopped))
                        return;
                }
                // A native fade can take over after motion/style changes. Stop the
                // old drip first so it cannot later make the surface visible again.
                if (props && 'opacity' in props && self._adapter.menu === menu) {
                    self._controller.reset();
                    self._finishPending(false);
                    self._adapter.menu = null;
                }
            } catch (e) {
                // The native ease below now owns these callbacks. Cancel the
                // failed drip without also reporting them as interrupted.
                if (self._pending?.menu === menu) {
                    self._pending = null;
                    self._controller.callbacks.onOpened = null;
                    self._controller.callbacks.onClosed = null;
                    self._controller.reset();
                    if (self._adapter.menu === menu)
                        self._adapter.menu = null;
                }
                console.warn(`Liquid Menus: a Dock menu kept its fade (${e.message})`);
            }
            return ease.call(this, props);
        };
        this._attached.set(c, {actor: menu.actor, ease, wrapper: c.ease});
    }

    // St.ease calls onComplete only on success, and onStopped for both success
    // and interruption. Dhruva relies on onStopped to remove its input overlay.
    _finishPending(finished, pending = this._pending) {
        if (!pending || this._pending !== pending)
            return;
        this._pending = null;
        this._controller.callbacks.onOpened = null;
        this._controller.callbacks.onClosed = null;
        if (pending.closing && this._adapter.menu === pending.menu)
            this._adapter.menu = null;
        // Clear ownership before callbacks: disposal can destroy the actor or
        // synchronously open another menu.
        for (const [callback, args] of [
            [pending.onStopped, [finished]],
            [finished ? pending.onComplete : null, []],
        ]) {
            try {
                callback?.(...args);
            } catch (e) {
                console.warn(`Liquid Menus: a Dock menu completion failed (${e.message})`);
            }
        }
    }

    _open(menu, onComplete, onStopped) {
        if (this._adapter.menu && this._adapter.menu !== menu)
            this._controller.reset();
        this._finishPending(false);
        this._adapter.menu = menu;
        this._adapter.rest = null;
        const pending = {menu, closing: false, onComplete, onStopped};
        this._pending = pending;
        this._controller.callbacks.onOpened = () => this._finishPending(true, pending);
        if (this._controller.phase === 'open') {
            this._finishPending(true);
            return;
        }
        this._controller.open();
    }

    // the retract plays, then Dhruva's own completion (remove the overlay, destroy the menu); false = let Dhruva fade it
    _close(menu, onComplete, onStopped) {
        if (this._adapter.menu !== menu || this._controller.phase === 'closed')
            return false;
        this._finishPending(false);
        const pending = {menu, closing: true, onComplete, onStopped};
        this._pending = pending;
        this._controller.callbacks.onClosed = () => this._finishPending(true, pending);
        if (!this._controller.close())
            this._finishPending(true);
        return true;
    }
}

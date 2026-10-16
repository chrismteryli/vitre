/* One top-bar menu under the liquid drip (plan A17): the adapter the shared controller (liquidDrip.js) drives,
 * and the wrappers that hand the menu's open and close to it.
 *
 * Liquid Glass (live: enable-menu-glass, panel-menu-*) paints glass behind these menus and runs its own spring
 * (scale and opacity of menu.box) on every open-state change. While the drip owns a menu, that glass and that
 * spring must stay out of the way: the surface shows nothing until the drip hands it over, then Liquid Glass's
 * glass fades in under the field's (same shape, 40 ms) and the field goes. The coupling is two own-property
 * overrides on that menu's Liquid Glass UIManager (`_startAnimation` is skipped while the drip owns the menu);
 * both are undone on disable, and a menu without a Liquid Glass manager is handled by the BoxPointer alone.
 */
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

import {DripController, highlightRect, op255, motionAllowed} from './liquidDrip.js';
import {DRIP} from './dripMotion.js';
import {GLASS_FINISH} from './glass.js';

const LG_UUID = 'liquid-glass@thinkingcoding1231.gmail.com';

// Liquid Glass's panel-menu look in the field's terms: out = s x tint colour + (1 - s) x brightness x saturated
// backdrop (verified on three walls in the rig); read from its settings when they are there, these are the live
// values.
const LG_LOOK = {blurRadius: 24, tintStrength: 0.42, tintColor: [28 / 255, 28 / 255, 30 / 255], brightness: 0.92, saturation: 1.7, corner: 14, expand: 12};

export class MenuDripAdapter {
    constructor(managed) {
        this._m = managed;
        this.allocCount = 0;
        this._allocAt = -1;
        this.sharedField = true;  // the menus share one parked field and content mask (liquidDrip.js)
        this.owns = false;       // true while the drip decides this menu's open / close (Liquid Glass keeps off it)
        this._saved = null;
    }

    get handoffMs() {
        return DRIP.handoffMs;
    }

    get _dead() {
        return this._m.dead;
    }

    // the source pill must be on screen (panel hidden, an indicator that is not shown: nothing to drip from)
    canDrip() {
        return !this._dead && this._m.button.mapped;
    }

    // reading Liquid Glass's look never hooks it: the hook is installed only when the drip takes over a menu
    _lg() {
        return this._dead ? null : this._m.lgManager(false);
    }

    get finish() {
        if (!this._lg())
            return GLASS_FINISH;
        // Liquid Glass: out = s x tint colour + (1 - s) x brightness x saturated backdrop (checked against its pixels)
        const look = this._m.lgLook();
        return {...GLASS_FINISH, tint: look.tintStrength, tintColor: look.tintColor, saturation: look.saturation};
    }

    get blurRadius() {
        return this._lg() ? this._m.lgLook().blurRadius : undefined;
    }

    get brightness() {
        return this._lg() ? this._m.lgLook().brightness : undefined;
    }

    geometry(rest = false) {
        const {menu, button} = this._m;
        if (this._dead || (!rest && this.allocCount <= this._allocAt))
            return null;
        const box = menu.box;
        if (!box.has_allocation() || !button.mapped)
            return null;
        const [x, y] = box.get_transformed_position();
        const [w, h] = box.get_transformed_size();
        if (![x, y, w, h].every(Number.isFinite) || w < 8 || h < 8)
            return null;
        const lg = this._lg();
        let rect;
        let radius;
        if (lg) {
            // Liquid Glass's glass is the box grown by its glass-expand on every side, corner radius from its settings
            const e = this._m.lgLook().expand;
            rect = {x: x - e, y: y - e, w: w + 2 * e, h: h + 2 * e};
            radius = this._m.lgLook().corner;
        } else {
            rect = {x, y, w, h};
            try {
                radius = box.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
            } catch (_e) {
                radius = 14;
            }
        }
        const pill = highlightRect(button);
        if (![pill.x, pill.y, pill.w, pill.h].every(Number.isFinite))
            return null;
        return {pill: {...pill, keep: true},
            pieces: [{id: 'menu', ...rect, r: Math.min(radius, rect.w / 2, rect.h / 2), row: 0}]};
    }

    maskActor() {
        return this._dead ? null : this._m.menu.box;
    }

    begin() {
        if (this._dead)
            return;
        const {menu} = this._m;
        const pointer = menu.actor;
        const box = menu.box;
        const lg = this._lg();
        this._allocAt = this.allocCount;
        this._saved = {border: pointer._border?.opacity ?? 255, hasLg: Boolean(lg)};
        box.remove_all_transitions();
        box.set_scale(1, 1);
        box.opacity = 0;
        if (pointer._border)
            pointer._border.opacity = 0;
        const glass = lg?.glass;
        if (glass) {
            glass.remove_all_transitions();
            glass.opacity = 0;
        }
    }

    setPiece(_id, {real, content}) {
        if (this._dead)
            return;
        const {menu} = this._m;
        const box = menu.box;
        box.opacity = op255(content);
        const glass = this._lg()?.glass;
        if (glass)
            glass.opacity = op255(real);
        else if (menu.actor._border)
            menu.actor._border.opacity = op255(real);
    }

    end() {
        const saved = this._saved;
        this._saved = null;
        if (this._dead)
            return;
        const {menu} = this._m;
        const pointer = menu.actor;
        const box = menu.box;
        box.set_scale(1, 1);
        box.opacity = 255;
        if (pointer._border)
            pointer._border.opacity = saved?.border ?? 255;
        const glass = this._lg()?.glass;
        if (glass)
            glass.opacity = 255;
    }
}

export class ManagedMenu {
    // host: {style: DripStyle}
    constructor(host, menu, button, name) {
        this.host = host;
        this.menu = menu;
        this.button = button;
        this.name = name;
        this.adapter = new MenuDripAdapter(this);
        this.controller = new DripController(`menu-${name}`, this.adapter, {prewarm: 5, prewarmIf: () => this.host.style.liquid});
        this._undo = [];
        this._disposed = false;
        this._lgHooked = null;
        this._pendingClose = null;
        this.dead = false;           // the menu, its BoxPointer or its button was destroyed (a tray app quit): never touch them again
        this._deadSignals = [];
    }

    // The menu's actors can be destroyed at any moment (a StatusNotifierItem process quits mid-menu). Touching a disposed
    // GObject only logs a critical per access, so the destruction is remembered by a handler and everything stops here.
    _watchLifetime() {
        const {menu, button} = this;
        for (const actor of [menu.actor, menu.box, button]) {
            if (!actor)
                continue;
            const id = actor.connect('destroy', () => this._markDead());
            this._deadSignals.push([actor, id]);
        }
    }

    _markDead() {
        if (this.dead)
            return;
        this.dead = true;
        this._pendingClose = null;
        this.controller.callbacks.onOpened = null;
        this.controller.callbacks.onClosed = null;
        this.adapter.owns = false;
        try {
            this.controller.destroy();      // the adapter does nothing now; the field (a stage actor of ours) goes
        } catch (_e) {
            // nothing else to give back
        }
        this.host.onDead?.(this);
    }

    // ---- Liquid Glass coupling ---------------------------------------------------------------------

    lgManager(hook = false) {
        try {
            const lg = Extension.lookupByUUID(LG_UUID);
            const manager = lg?._panelMenuManager?._menus?.get(this.menu)?.manager ?? null;
            if (hook && manager && manager !== this._lgHooked)
                this._hookLg(manager);
            return manager;
        } catch (_e) {
            return null;
        }
    }

    lgLook() {
        const look = {...LG_LOOK};
        try {
            const s = Extension.lookupByUUID(LG_UUID)?._settings;
            if (s) {
                look.blurRadius = s.get_int('panel-menu-blur-radius');
                look.tintStrength = s.get_double('panel-menu-tint-strength');
                look.brightness = s.get_double('panel-menu-brightness');
                look.saturation = s.get_double('panel-menu-saturation');
                const hex = s.get_string('panel-menu-tint-color');
                if (/^#[0-9a-fA-F]{6}$/.test(hex))
                    look.tintColor = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
                look.corner = s.get_double('panel-menu-corner-radius');
                look.expand = s.get_int('panel-menu-glass-expand');
            }
        } catch (_e) {
            // keep the live values
        }
        return look;
    }

    _hookLg(manager) {
        this._unhookLg();
        const own = Object.getOwnPropertyDescriptor(manager, '_startAnimation');
        const original = manager._startAnimation;
        if (typeof original !== 'function')
            return;
        const adapter = this.adapter;
        const host = this.host;
        const replacement = function (target) {
            if (adapter.owns)
                return undefined;       // the drip decides this menu's motion
            if (host.style.liquid && !motionAllowed()) {
                // Liquid Glass's own spring also needs to settle for reduced motion.
                // Its native immediate path cancels any previous ticker first.
                const enabled = this._enableAnimation;
                this._enableAnimation = false;
                try {
                    return original.call(this, target);
                } finally {
                    this._enableAnimation = enabled;
                    if (target === 0) {
                        // its immediate path shows the menu at rest (255); a closed menu rests invisible, as after its spring
                        if (this.glass)
                            this.glass.opacity = 0;
                        if (this.animActor)
                            this.animActor.opacity = 0;
                    }
                }
            }
            return original.call(this, target);
        };
        manager._startAnimation = replacement;
        this._lgHooked = manager;
        this._lgUndo = () => {
            if (manager._startAnimation !== replacement)
                return;
            if (own)
                Object.defineProperty(manager, '_startAnimation', own);
            else
                delete manager._startAnimation;
        };
    }

    _unhookLg() {
        this._lgUndo?.();
        this._lgUndo = null;
        this._lgHooked = null;
    }

    // ---- wrappers ----------------------------------------------------------------------------------

    _wrap(object, name, factory) {
        const own = Object.getOwnPropertyDescriptor(object, name);
        const original = object[name];
        if (typeof original !== 'function')
            throw new Error(`menu ${this.name}: ${name} unavailable`);
        const replacement = factory(original);
        object[name] = replacement;
        this._undo.push(() => {
            if (object[name] !== replacement)
                return;       // somebody else replaced it later: leave theirs
            if (own)
                Object.defineProperty(object, name, own);
            else
                delete object[name];
        });
    }

    enable() {
        const {menu} = this;
        const pointer = menu.actor;
        const self = this;
        const {style} = this.host;
        const controller = this.controller;
        const adapter = this.adapter;
        if (!pointer._muteInput || !pointer._muteKeys || typeof pointer._reposition !== 'function')
            throw new Error(`menu ${this.name}: unsupported BoxPointer`);
        this._watchLifetime();
        controller.callbacks.onClosed = null;

        this._wrap(pointer, '_reposition', original => function (box) {
            original.call(this, box);
            adapter.allocCount++;
        });

        // PopupMenu.open / close run Liquid Glass's open-state-changed handler BEFORE the BoxPointer is asked
        // to animate: say first whether the drip owns this one
        this._wrap(menu, 'open', original => function (params) {
            if (self.dead)
                return original.call(this, params);
            adapter.owns = !self._disposed && style.liquid && params?.animate !== false && motionAllowed();
            if (!self._disposed && style.liquid)
                self.lgManager(true);
            return original.call(this, params);
        });
        this._wrap(menu, 'close', original => function (params) {
            if (self.dead)
                return original.call(this, params);
            adapter.owns = !self._disposed && style.liquid && params?.animate !== false && motionAllowed() &&
                controller.phase !== 'closed';
            if (!self._disposed && style.liquid)
                self.lgManager(true);
            return original.call(this, params);
        });

        this._wrap(pointer, 'open', original => function (animate, onComplete) {
            if (self._disposed || self.dead)
                return original.call(this, animate, onComplete);
            // Reopening cancels the preceding close just as native BoxPointer
            // cancels its transition completion callback.
            self._pendingClose = null;
            controller.callbacks.onClosed = null;
            if (style.liquid && !motionAllowed())
                animate = PopupAnimation.NONE;
            const liquid = style.liquid && animate !== PopupAnimation.NONE && motionAllowed();
            if (!liquid) {
                if (controller.phase !== 'closed')
                    controller.reset();
                adapter.owns = false;
                const result = original.call(this, animate, onComplete);
                if (style.liquid && animate === PopupAnimation.NONE)
                    controller.markOpen();      // an instant open is still a settled surface: its close drips
                return result;
            }
            this.remove_all_transitions();
            // NONE: show(), opacity 255; the pointer itself never scales or slides in the drip
            original.call(this, PopupAnimation.NONE, onComplete);
            this.scale_x = 1;
            this.scale_y = 1;
            this.translation_x = 0;
            this.translation_y = 0;
            this.opacity = 255;
            this._muteKeys.enabled = false;
            this._muteInput.enabled = true;
            adapter.owns = true;
            controller.callbacks.onOpened = () => {
                this._muteInput.enabled = false;
            };
            controller.open(animate & PopupAnimation.SLIDE ? 1 : DRIP.switchOpenSpeed);      // FADE alone: another pop-out is closing
            return undefined;
        });

        this._wrap(pointer, 'close', original => function (animate, onComplete) {
            if (self._disposed || self.dead || !this.visible)
                return original.call(this, animate, onComplete);
            if (style.liquid && !motionAllowed())
                animate = PopupAnimation.NONE;
            if (controller.phase !== 'closed') {
                if (animate !== PopupAnimation.NONE && style.liquid && motionAllowed()) {
                    // liquid: retract into the pill (0.7x when another top-bar pop-out is taking over: FADE only)
                    const switching = !(animate & PopupAnimation.SLIDE);
                    this.remove_all_transitions();
                    this._muteInput.enabled = true;
                    this._muteKeys.enabled = true;
                    adapter.owns = true;
                    self._pendingClose = () => {
                        adapter.owns = false;
                        original.call(this, PopupAnimation.NONE, onComplete);
                    };
                    controller.callbacks.onClosed = () => self._finishPendingClose();
                    controller.close(switching ? DRIP.switchCloseScale : 1);
                    return undefined;
                }
                controller.reset();
            }
            self._pendingClose = null;
            controller.callbacks.onClosed = null;
            adapter.owns = false;
            return original.call(this, animate, onComplete);
        });
    }

    _finishPendingClose() {
        const finish = this._pendingClose;
        this._pendingClose = null;
        this.controller.callbacks.onClosed = null;
        finish?.();
    }

    disable() {
        if (this._disposed)
            return;
        const interrupted = this.controller.busy;
        this._disposed = true;
        this.controller.callbacks.onOpened = null;
        this.controller.callbacks.onClosed = null;
        for (const [actor, id] of this._deadSignals.splice(0)) {
            if (this.dead)
                break;
            try {
                actor.disconnect(id);
            } catch (_e) {
                // destroyed meanwhile
            }
        }
        try {
            this.controller.destroy();
        } catch (_e) {
            // already gone with the shell
        }
        for (const undo of this._undo.splice(0).reverse()) {
            try {
                undo();
            } catch (_e) {
                // the menu was destroyed meanwhile
            }
        }
        this._unhookLg();
        this.adapter.owns = false;
        if (this.dead) {
            // nothing of the menu is alive any more: no native close, no hand-back
            this._pendingClose = null;
            return;
        }
        try {
            if (this._pendingClose) {
                // A logical PopupMenu close has already happened; finish its
                // original native hide and menu-closed callback exactly once.
                this._finishPendingClose();
            } else if (interrupted && this.menu.isOpen) {
                // Closing through PopupMenu releases native grabs/highlights.
                this.menu.close({animate: false});
            }
        } catch (_e) {
            // The source menu may already have been destroyed by its owner.
            this._pendingClose = null;
        }
    }
}

/* Opening Vitre's Control Center (GNOME's Quick Settings menu, restyled by vitre-controls) from the capsule's button.
 *
 * Why the menu needs a new anchor: GNOME's BoxPointer positions a menu only while its source actor is mapped
 * (boxpointer.js vfunc_allocate), and the Quick Settings button lives in the top bar, which GNOME hides over a full-screen
 * window. Opened as is, the menu would keep whatever position it had last. So for as long as it is open from the capsule
 * the menu's sourceActor is the capsule's button: the BoxPointer then takes its monitor and work area from the button (the
 * right monitor when several are connected), and vitre-controls' own placement (right edge 13 px from the screen edge,
 * 14 px under the bar's band) puts the Control Center just under the capsule. GNOME's PopupMenuManager still takes the grab,
 * closes the menu on Esc or on a click outside it, and gives the keyboard back to the full-screen window when it closes.
 *
 * The stretch out of the button: vitre-controls' drip (ccDrip.js) reads its source pill from its own record of the top-bar
 * button (`_native.qs`) and refuses to drip while that button is unmapped. While the menu is open from the capsule that
 * one field points at the capsule's button instead, the same kind of runtime bridge vitre-controls itself keeps into
 * Liquid Glass (liquidGlassBridge.js). It is only made when vitre-controls is loaded with exactly the structure read here,
 * and it is undone when the menu has closed (or when either side goes away); when it cannot be made, the Control Center
 * still opens in the right place, without the stretch.
 *
 * Where the top bar has no band on that monitor (a second monitor, or the bar hidden by a setting), vitre-controls'
 * placement would put the Control Center over the capsule (14 px from the top of the work area); then the menu's own
 * actor (GNOME's 0 x 0 holder of the BoxPointer, which vitre-controls places through uiGroup, so a translation of the
 * holder moves the whole panel) is moved down by just enough to keep the usual 14 px under the capsule.
 *
 * Everything is put back exactly: the menu's own sourceActor and holder translation, vitre-controls' field, every signal. */
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CONTROLS_UUID = 'vitre-controls@vitre-desktop';
const RESTORE_FALLBACK_MS = 3000;     // 'menu-closed' ends a close; this only covers a close that never reports back
export const CC_GAP = 14;             // vitre-controls GEO.topGap: the Control Center sits this far under the bar's band

function quickSettingsMenu() {
    return Main.panel?.statusArea?.quickSettings?.menu ?? null;
}

// vitre-controls' record of the top-bar button, when (and only when) it has the structure this bridge was written against
function controlsRecord() {
    try {
        const state = Main.extensionManager?.lookup(CONTROLS_UUID)?.stateObj;
        const native = state?._native;
        const qs = Main.panel?.statusArea?.quickSettings;
        if (!native || !qs || native.qs !== qs || native.menu !== qs.menu || typeof state._dripAdapter?.canDrip !== 'function')
            return null;
        return native;
    } catch (_e) {
        return null;
    }
}

export class ControlsAnchor {
    constructor({onOpenChanged} = {}) {
        this._onOpenChanged = onOpenChanged;
        this._active = null;      // {menu, button, savedSource, native, nativeQs, open}
        this._fallbackId = 0;
        this._warned = new Set();
    }

    // true while the Control Center is open (or closing) from the capsule
    get active() {
        return Boolean(this._active);
    }

    get open() {
        return Boolean(this._active?.open);
    }

    get bridged() {
        return Boolean(this._active?.native);
    }

    get shift() {
        return this._active?.shift ?? 0;
    }

    _warnOnce(key, text) {
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        console.warn(`Vitre Corner: ${text}`);
    }

    // minTop: the highest the Control Center's top may be (stage px), or null
    toggle(button, {minTop = null} = {}) {
        const menu = quickSettingsMenu();
        if (!menu || typeof menu.open !== 'function') {
            this._warnOnce('no-menu', 'the Quick Settings menu is not available');
            return false;
        }
        if (menu.isOpen) {
            menu.close();
            return true;
        }
        this._anchor(menu, button, minTop);
        let opened = false;
        try {
            opened = menu.open({animate: true});
        } catch (e) {
            this._warnOnce('open', `the Control Center did not open (${e.message})`);
        }
        if (!opened)
            this._restore();
        return opened;
    }

    // close without animation (the capsule is going away under it: full screen ended, the extension is disabled)
    closeNow() {
        const a = this._active;
        if (!a)
            return;
        try {
            if (a.menu.isOpen)
                a.menu.close({animate: false});
        } catch (_e) {
            // the menu is going away itself
        }
        this._restore();
    }

    _anchor(menu, button, minTop) {
        this._restore();
        const a = {menu, button, savedSource: menu.sourceActor, native: null, nativeQs: null, open: false, shift: 0, holderTy: 0};
        menu.sourceActor = button;
        const native = controlsRecord();
        if (native) {
            a.native = native;
            a.nativeQs = native.qs;
            native.qs = button;
            // vitre-controls puts the panel CC_GAP under the work area's top: keep it under the capsule instead
            const holder = menu.actor;
            if (Number.isFinite(minTop) && holder && holder !== menu._boxPointer) {
                const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.findIndexForActor(button));
                const shift = Math.max(0, Math.ceil(minTop - (area.y + CC_GAP)));
                if (shift > 0) {
                    a.holderTy = holder.translation_y;
                    a.shift = shift;
                    holder.translation_y = a.holderTy + shift;
                }
            }
        }
        this._active = a;
        menu.connectObject(
            'open-state-changed', (_m, open) => this._openChanged(a, open),
            'menu-closed', () => this._restore(a),
            'destroy', () => this._restore(a), this);
        button.connectObject('destroy', () => this.closeNow(), this);
    }

    _openChanged(a, open) {
        if (this._active !== a)
            return;
        a.open = open;
        if (!open)
            this._armFallback(a);
        try {
            this._onOpenChanged?.(open);
        } catch (e) {
            console.error(`Vitre Corner: ${e.message}`);
        }
    }

    _armFallback(a) {
        this._clearFallback();
        this._fallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_FALLBACK_MS, () => {
            this._fallbackId = 0;
            if (this._active === a && !a.menu.isOpen)
                this._restore(a);
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._fallbackId, '[vitre-corner] restore');
    }

    _clearFallback() {
        if (this._fallbackId) {
            GLib.source_remove(this._fallbackId);
            this._fallbackId = 0;
        }
    }

    // put everything back; `a` limits it to that anchoring (a late signal of an older one does nothing)
    _restore(a = this._active) {
        if (!a || this._active !== a)
            return;
        this._active = null;
        this._clearFallback();
        try {
            a.menu.disconnectObject(this);
        } catch (_e) {
            // destroyed
        }
        try {
            a.button.disconnectObject(this);
        } catch (_e) {
            // destroyed
        }
        if (a.menu.sourceActor === a.button)
            a.menu.sourceActor = a.savedSource;
        if (a.native && a.native.qs === a.button)
            a.native.qs = a.nativeQs;
        if (a.shift) {
            try {
                if (a.menu.actor.translation_y === a.holderTy + a.shift)
                    a.menu.actor.translation_y = a.holderTy;
            } catch (_e) {
                // destroyed with the menu
            }
        }
        const wasOpen = a.open;
        a.open = false;
        if (wasOpen) {
            try {
                this._onOpenChanged?.(false);
            } catch (e) {
                console.error(`Vitre Corner: ${e.message}`);
            }
        }
    }

    destroy() {
        this.closeNow();
        this._clearFallback();
        this._onOpenChanged = null;
    }
}

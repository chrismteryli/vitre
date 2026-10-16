/* Liquid Menus (plan A17): the liquid drip for every top-bar menu that Control Center and Notification Center
 * do not own (Logo Menu, input source, accessibility, indicators, other extensions' PanelMenu buttons), and
 * the owner of the shared `drip-style` setting (liquid | classic) that those two and the menu-bar HUD read.
 *
 * Every PanelMenu.Button in the panel whose menu is a PopupMenu gets its BoxPointer open / close handed to a
 * drip controller (menuDrip.js). New buttons are picked up when they are added to the bar; disabling puts every
 * method back exactly as it was. drip-style `classic` (or animations off / reduced motion): nothing is changed,
 * GNOME's and Liquid Glass's own menu animation runs as before.
 */
import GLib from 'gi://GLib';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {DripStyle} from './dripStyle.js';
import {ManagedMenu} from './menuDrip.js';
import {releaseSharedFields} from './liquidDrip.js';
import {AppMenuDrips} from './appMenuDrip.js';
import {DockMenuDrips} from './dockMenuDrip.js';
import {PanelWarm} from './panelWarm.js';

export default class LiquidMenus extends Extension {
    enable() {
        this._enabled = true;
        this._settings = this.getSettings();
        this._style = new DripStyle();
        this._managed = new Map();       // menu -> ManagedMenu
        this._signals = [];
        this._buttons = new Map();       // button -> signal ids ('menu-set': a replaced menu is scanned again; 'destroy')
        this._dynamic = new Map();       // menu -> ManagedMenu for menus outside the top bar (B16), taken over when they first open
        this._dynCount = 0;
        this._host = {style: this._style, onDead: managed => {
            if (managed && this._dynamic.get(managed.menu) === managed)
                this._dynamic.delete(managed.menu);
            this._scheduleScan();
        }};
        this._idleId = 0;
        const panel = Main.panel;
        for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
            for (const signal of ['child-added', 'child-removed']) {
                const id = box.connect(signal, () => this._scheduleScan());
                this._signals.push([box, id]);
            }
        }
        this._scheduleScan();
        // B16: every other shell menu with a source (the Dock's right-click menus, the window menu, app icons in the Apps
        // view and in search, extensions' own menus) is taken over the first time it opens: the same drip, out of its source
        this._injections = new InjectionManager();
        const self = this;
        this._injections.overrideMethod(PopupMenu.PopupMenu.prototype, 'open', original => function (...args) {
            try {
                self._adopt(this, args[0]);
            } catch (e) {
                console.warn(`Liquid Menus: a menu kept GNOME's animation (${e.message})`);
            }
            return original.apply(this, args);
        });
        // B16: the Dock's own menus (Dhruva) rise out of their icon
        try {
            this._dockMenus = new DockMenuDrips(this._style);
        } catch (e) {
            console.warn(`Liquid Menus: Dock menu drip not available (${e.message})`);
            this._dockMenus = null;
        }
        // B19b: every top-bar panel drawn once while idle after login (the first open no longer hitches)
        try {
            this._warm = new PanelWarm();
        } catch (e) {
            this._warm = null;
        }
        // B15: the menus apps draw themselves drip too
        try {
            this._appMenus = new AppMenuDrips(this._style);
        } catch (e) {
            console.warn(`Liquid Menus: app menu drip not available (${e.message})`);
            this._appMenus = null;
        }
    }

    disable() {
        this._warm?.destroy();
        this._warm = null;
        this._injections?.clear();
        this._injections = null;
        for (const managed of this._dynamic?.values() ?? [])
            managed.disable();
        this._dynamic?.clear();
        this._dockMenus?.destroy();
        this._dockMenus = null;
        this._appMenus?.destroy();
        this._appMenus = null;
        this._enabled = false;
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        for (const [button, ids] of this._buttons) {
            for (const id of ids) {
                try {
                    button.disconnect(id);
                } catch (_e) {
                    // destroyed meanwhile
                }
            }
        }
        this._buttons.clear();
        for (const managed of this._managed.values())
            managed.disable();
        this._managed.clear();
        releaseSharedFields();           // the field and mask the menus shared while parked
        this._style?.destroy();
        this._style = null;
        this._settings = null;
    }

    // rig / tests: the controller of a menu
    controllerFor(menu) {
        return this._managed?.get(menu)?.controller ?? this._dynamic?.get(menu)?.controller ?? null;
    }

    get dynamic() {
        return this._dynamic;
    }

    // A menu outside the top bar opens for the first time: put it under the drip before its BoxPointer is asked to animate.
    _adopt(menu, params) {
        // (rig: the last decision, readable as extension.lastAdopt)
        const why = r => {
            this.lastAdopt = r;
        };
        if (!this._enabled || !this._style.liquid || this._managed.has(menu) || this._dynamic.has(menu))
            return why('known');
        const pointer = menu._boxPointer;
        const source = menu.sourceActor;
        if (!pointer || !menu.box || !source || !source.mapped || !pointer._muteInput || !pointer._muteKeys)
            return why(`not-a-boxpointer-menu mapped=${source?.mapped}`);
        // Control Center, Notification Center and the HUD drip their own way; top-bar menus are the scan's
        if (pointer._dripOwned || menu.actor?._dripOwned || Main.panel.contains(source))
            return why('owned');
        why('adopted');
        const managed = new ManagedMenu(this._host, menu, source, `ctx${this._dynCount++ % 1000}`);
        try {
            managed.enable();
        } catch (e) {
            managed.disable();
            throw e;
        }
        this._dynamic.set(menu, managed);
        // Menus that are destroyed as soon as they close (the window menu) would lose their retract: the destroy waits for it
        const realDestroy = menu.destroy;
        if (typeof realDestroy === 'function') {
            menu.destroy = function (...args) {
                const controller = managed.controller;
                if (!managed.dead && !managed._disposed && controller.phase === 'closing') {
                    const previous = controller.callbacks.onClosed;
                    controller.callbacks.onClosed = () => {
                        try {
                            previous?.();
                        } finally {
                            delete menu.destroy;
                            realDestroy.apply(menu, args);
                        }
                    };
                    return undefined;
                }
                delete menu.destroy;
                return realDestroy.apply(menu, args);
            };
        }
        // the instance wrapper set up by enable() is bypassed for this first open (we are already inside the prototype's
        // open), so say here what it would have said: the drip owns this open
        managed.adapter.owns = params?.animate !== false;
    }

    get managed() {
        return this._managed;
    }

    _scheduleScan() {
        if (this._idleId || !this._enabled)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    // a button whose menu is replaced (setMenu) or destroyed is scanned again at once
    _watchButton(button) {
        if (this._buttons.has(button) || typeof button.connect !== 'function')
            return;
        try {
            const ids = [button.connect('menu-set', () => this._scheduleScan()),
                button.connect('destroy', () => {
                    this._buttons.delete(button);
                    this._scheduleScan();
                })];
            this._buttons.set(button, ids);
        } catch (_e) {
            // not a signal source: nothing to watch
        }
    }

    _scan() {
        if (!this._enabled)
            return;
        const panel = Main.panel;
        const reserved = new Set([panel.statusArea.dateMenu?.menu, panel.statusArea.quickSettings?.menu]);
        const wanted = new Map();
        for (const [name, button] of Object.entries(panel.statusArea)) {
            if (!button || !panel.contains(button.container ?? button))
                continue;
            this._watchButton(button);
            const menu = button.menu;
            // Control Center and Notification Center own their menus; dummy menus have no BoxPointer
            if (!(menu instanceof PopupMenu.PopupMenu) || !menu.actor || !menu.box || !menu._boxPointer)
                continue;
            // (the marker sits on the BoxPointer, and on the menu's actor where that is a different object: Quick Settings)
            if (reserved.has(menu) || menu._boxPointer._dripOwned || menu.actor._dripOwned)
                continue;
            wanted.set(menu, {button, name});
        }
        for (const [menu, managed] of this._managed) {
            if (wanted.has(menu))
                continue;
            managed.disable();
            this._managed.delete(menu);
        }
        for (const [menu, {button, name}] of wanted) {
            if (this._managed.has(menu))
                continue;
            const managed = new ManagedMenu(this._host, menu, button, name);
            try {
                managed.enable();
                this._managed.set(menu, managed);
            } catch (error) {
                managed.disable();
                console.error(`Liquid Menus: skipped ${name}: ${error.message}`);
            }
        }
    }
}

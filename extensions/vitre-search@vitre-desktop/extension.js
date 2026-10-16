/* Vitre Search (A11) with the Apps view (A19): search bar with Liquid Glass morphs, and the app grid inside it.
 * See vitresearch.js for the structure, motion.js for the measured tables and appsView.js for the Apps view. */
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {VitreSearch} from './vitresearch.js';
import {KeybindingManager} from './keybinding.js';

const SHELL_KEYS = 'org.gnome.shell.keybindings';

export default class VitreSearchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._vitresearch = new VitreSearch(this._settings);
        this._keys = new KeybindingManager(this._settings, () => this._vitresearch.toggle(), msg => console.log(msg));
        this._keys.enable();
        this._routeAppGrid();
        console.log(`A11 VitreSearch: enabled (keybinding ${this._keys.status.state}${this._keys.status.accel ? ` ${this._keys.status.accel}` : ''})`);
    }

    disable() {
        this._unrouteAppGrid();
        this._keys?.disable();
        this._keys = null;
        this._vitresearch?.destroy();
        this._vitresearch = null;
        this._settings = null;
    }

    // A19: GNOME's app grid entry points open the Apps view instead. Main.overview.showApps is what the Dock's
    // apps button and other callers use; Super+A is re-bound. With the overview already open, GNOME's own
    // behaviour stays (the grid page inside the overview).
    _routeAppGrid() {
        this._inject = new InjectionManager();
        const self = this;
        this._inject.overrideMethod(Main.overview, 'showApps', original => function (...args) {
            if (!Main.overview.visible && self._vitresearch?.openApps(self._pointer()))
                return;
            original.call(this, ...args);
        });
        try {
            Main.wm.removeKeybinding('toggle-application-view');
            Main.wm.addKeybinding('toggle-application-view', new Gio.Settings({schema_id: SHELL_KEYS}),
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    if (Main.overview.visible)
                        Main.overview._overview.controls._toggleAppsPage();
                    else
                        this._vitresearch?.toggleApps(null);
                });
            this._reboundKeys = true;
        } catch (e) {
            console.log(`A19 Apps: could not re-bind Super+A: ${e.message}`);
            this._reboundKeys = false;
        }
    }

    _unrouteAppGrid() {
        this._inject?.clear();
        this._inject = null;
        if (this._reboundKeys) {
            Main.wm.removeKeybinding('toggle-application-view');
            const controls = Main.overview._overview?.controls;
            if (controls?._toggleAppsPage) {
                Main.wm.addKeybinding('toggle-application-view', new Gio.Settings({schema_id: SHELL_KEYS}),
                    Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                    controls._toggleAppsPage.bind(controls));
            }
            this._reboundKeys = false;
        }
    }

    _pointer() {
        const [x, y] = global.get_pointer();
        return {x, y};
    }

    // rig + README: the live controller
    get vitresearch() {
        return this._vitresearch;
    }

    get keybinding() {
        return this._keys;
    }
}

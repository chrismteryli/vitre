import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'liquid-glass@thinkingcoding1231.gmail.com';

/* Suspends ONLY Liquid Glass's Quick Settings glass manager (the one glass panel that
 * would sit behind the whole grid) while Control Center is enabled, and puts it back
 * on disable. Every other Liquid Glass manager (menus, notifications, OSD, dock,
 * panel menus) and every Liquid Glass setting stays untouched; no settings are written.
 *
 * Liquid Glass builds the manager 1.5 s after its own enable, then calls setup() on it
 * and (in disable()) cleanup() unconditionally. So:
 *   - a manager that exists already is cleaned up and kept in place;
 *   - one that appears later is caught by an accessor installed on the extension
 *     instance and its setup() is turned into a no-op for as long as we are active;
 *   - on disable the neutralised manager is replaced by a fresh, set-up instance of the
 *     same class built with the same constructor arguments.
 */
export class LiquidGlassQuickSettingsBridge {
    constructor({onError = () => {}, extensionManager = Main.extensionManager} = {}) {
        this._extensions = extensionManager;
        this._onError = onError;
        this._enabled = false;
        this._signal = 0;
        this._hooked = null;   // {extension, holder, descriptor}
        this._owned = null;    // {extension, manager, Constructor, args, hadSetupOverride}
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        this._signal = this._extensions.connect('extension-state-changed', (_m, ext) => {
            if (ext.uuid === UUID)
                this._safely(() => this._sync());
        });
        try {
            this._sync();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _safely(action) {
        try {
            action();
        } catch (_error) {
            // Never forward settings or object contents.
            this._onError(new Error('Control Center could not suspend the Liquid Glass Quick Settings glass.'));
        }
    }

    _sync() {
        if (!this._enabled)
            return;
        const record = this._extensions.lookup(UUID);
        const extension = record?.stateObj;
        if (this._hooked?.extension !== extension) {
            this._unhook();
            this._owned = null;
            if (extension)
                this._hook(extension);
        }
    }

    _hook(extension) {
        const bridge = this;
        const descriptor = Object.getOwnPropertyDescriptor(extension, '_quickSettingsManager');
        const holder = {value: extension._quickSettingsManager};
        Object.defineProperty(extension, '_quickSettingsManager', {
            configurable: true,
            enumerable: true,
            get() {
                return holder.value;
            },
            set(value) {
                holder.value = value;
                if (value && bridge._enabled)
                    bridge._safely(() => bridge._neutralize(extension, value));
            },
        });
        this._hooked = {extension, holder, descriptor};
        if (holder.value)
            this._safely(() => this._suspendExisting(extension, holder.value));
    }

    _snapshot(extension, manager) {
        return {extension, manager, Constructor: manager.constructor,
            args: [manager.extensionPath, manager._settings, manager._logger]};
    }

    _checkManager(manager) {
        if (typeof manager.cleanup !== 'function' || typeof manager.setup !== 'function' ||
            manager.menu !== Main.panel.statusArea.quickSettings.menu)
            throw new Error('Unsupported Liquid Glass Quick Settings manager.');
    }

    // A manager that is already set up: undo its glass, keep the object.
    _suspendExisting(extension, manager) {
        if (this._owned?.manager === manager)
            return;
        this._checkManager(manager);
        this._owned = this._snapshot(extension, manager);
        manager.cleanup();
        this._silence(manager);
    }

    // A manager that was just assigned and whose setup() has not run yet.
    _neutralize(extension, manager) {
        if (this._owned?.manager === manager)
            return;
        this._checkManager(manager);
        this._owned = this._snapshot(extension, manager);
        this._silence(manager);
    }

    _silence(manager) {
        // Own property that shadows the prototype's setup(); removed again on disable.
        Object.defineProperty(manager, 'setup', {configurable: true, writable: true, value: () => {}});
    }

    _unhook() {
        const hooked = this._hooked;
        this._hooked = null;
        if (!hooked)
            return;
        const {extension, holder, descriptor} = hooked;
        const value = holder.value;
        delete extension._quickSettingsManager;
        if (descriptor)
            Object.defineProperty(extension, '_quickSettingsManager', descriptor);
        extension._quickSettingsManager = value;
    }

    disable() {
        this._enabled = false;
        if (this._signal)
            this._extensions.disconnect(this._signal);
        this._signal = 0;
        const owned = this._owned;
        this._owned = null;
        this._unhook();
        if (!owned)
            return;
        const record = this._extensions.lookup(UUID);
        if (record?.state !== ExtensionState.ACTIVE || record.stateObj !== owned.extension ||
            owned.extension._quickSettingsManager !== owned.manager)
            return;
        delete owned.manager.setup; // drop the no-op shadow
        const restored = new owned.Constructor(...owned.args);
        try {
            restored.setup();
        } catch (_error) {
            restored.cleanup();
            throw new Error('Liquid Glass Quick Settings restoration failed.');
        }
        owned.extension._quickSettingsManager = restored;
    }
}

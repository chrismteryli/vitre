import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'liquid-glass@thinkingcoding1231.gmail.com';

// GNOME 51 / installed Liquid Glass UIManager contract. No settings writes.
// Keep its cleaned date manager in place: Liquid Glass.disable() calls cleanup()
// unconditionally. Other Liquid Glass managers are never touched.
export class LiquidGlassDateMenuBridge {
    constructor({onError = () => {}, extensionManager = Main.extensionManager,
        getDateMenu = () => Main.panel.statusArea.dateMenu.menu} = {}) {
        this._extensions = extensionManager;
        this._getDateMenu = getDateMenu;
        this._onError = onError;
        this._enabled = false;
        this._signal = 0;
        this._hook = null;
        this._owned = null;
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
            // Do not forward private settings, objects or notification content.
            this._onError(new Error('Notification Center could not suspend the Liquid Glass date-menu effect.'));
        }
    }

    _sync() {
        if (!this._enabled)
            return;
        const record = this._extensions.lookup(UUID);
        const extension = record?.stateObj;
        if (this._hook?.extension !== extension) {
            this._unhook();
            this._owned = null; // Never recreate a manager in an obsolete instance.
            if (extension)
                this._hookEnable(extension);
        }
        if (record?.state === ExtensionState.ACTIVE)
            this._suspend(extension);
    }

    _hookEnable(extension) {
        const original = extension.enable;
        if (typeof original !== 'function')
            throw new Error('Unsupported Liquid Glass extension lifecycle.');
        const descriptor = Object.getOwnPropertyDescriptor(extension, 'enable');
        const bridge = this;
        const afterEnable = () => {
            if (bridge._enabled && bridge._extensions.lookup(UUID)?.stateObj === extension)
                bridge._safely(() => bridge._suspend(extension));
        };
        // GNOME's extension-order rebase calls enable() without emitting ACTIVE.
        // This instance-only wrapper covers that path and preserves its return.
        const wrapper = function (...args) {
            const result = original.apply(this, args);
            if (result?.then)
                return result.then(value => { afterEnable(); return value; });
            afterEnable();
            return result;
        };
        extension.enable = wrapper;
        this._hook = {extension, descriptor, wrapper};
    }

    _unhook() {
        const hook = this._hook;
        this._hook = null;
        if (!hook || hook.extension.enable !== hook.wrapper)
            return;
        if (hook.descriptor)
            Object.defineProperty(hook.extension, 'enable', hook.descriptor);
        else
            delete hook.extension.enable;
    }

    _suspend(extension) {
        const manager = extension?._uiManager;
        if (!manager || this._owned?.manager === manager)
            return;
        if (manager.menu !== this._getDateMenu() || manager._keyPrefix !== 'menu' ||
            manager._enableKey !== 'enable-menu-glass' ||
            typeof manager.cleanup !== 'function' || typeof manager.setup !== 'function')
            throw new Error('Unsupported Liquid Glass date-menu manager.');
        // Snapshot every constructor argument before cleanup. Constructor-only
        // open-state/destroy listeners mean setup() on the cleaned object is wrong.
        const args = [manager.extensionPath, manager._settings, manager._logger,
            {menu: manager.menu}, manager._ownsAccentCss, manager._enableKey,
            manager._keyPrefix, manager._label, manager._ownsSettingsNamespace];
        this._owned = {extension, manager, Constructor: manager.constructor, args};
        manager.cleanup(); // No arguments: inspected UIManager.cleanup() takes none.
    }

    disable() {
        this._enabled = false;
        if (this._signal)
            this._extensions.disconnect(this._signal);
        this._signal = 0;
        this._unhook();
        const owned = this._owned;
        if (!owned)
            return;
        const record = this._extensions.lookup(UUID);
        if (record?.state !== ExtensionState.ACTIVE || record.stateObj !== owned.extension ||
            owned.extension._uiManager !== owned.manager) {
            this._owned = null;
            return;
        }
        const restored = new owned.Constructor(...owned.args);
        try {
            restored.setup();
        } catch (_error) {
            restored.cleanup();
            throw new Error('Liquid Glass date-menu restoration failed.');
        }
        owned.extension._uiManager = restored;
        this._owned = null;
    }
}

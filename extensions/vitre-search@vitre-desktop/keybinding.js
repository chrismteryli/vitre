/* Registers VitreSearch's own accelerator only when nothing else on this desktop uses it.
 *
 * GNOME owns Super+Space for input-source switching (org.gnome.desktop.wm.keybindings
 * switch-input-source), and IBus listens on it too. Taking it silently would break layout switching,
 * so this module compares the accelerator with every keybinding setting it knows about
 * (window manager, shell, mutter, media keys and custom keybindings) and, when it finds a clash,
 * leaves the binding unregistered and logs ONE line naming the owner. It re-checks when the
 * accelerator setting or any of those schemas changes, so moving input switching elsewhere activates
 * VitreSearch's key at once, with no re-login.
 */
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const KEY_NAME = 'toggle-vitresearch';
const SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];
const CUSTOM_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
const CUSTOM_BASE = 'org.gnome.settings-daemon.plugins.media-keys';

const MOD_ALIASES = {
    primary: 'ctrl', control: 'ctrl', ctrl: 'ctrl', ctl: 'ctrl',
    super: 'super', mod4: 'super', hyper: 'hyper',
    alt: 'alt', mod1: 'alt', meta: 'alt',
    shift: 'shift',
};

// '<Super>space' -> 'super+space'; modifiers sorted, key lower-cased. Returns null for a non-accelerator.
export function normalizeAccel(accel) {
    if (typeof accel !== 'string' || !accel.length)
        return null;
    const mods = [];
    let rest = accel.trim();
    let m;
    while ((m = /^<([^>]+)>/.exec(rest))) {
        const alias = MOD_ALIASES[m[1].toLowerCase()];
        if (alias && !mods.includes(alias))
            mods.push(alias);
        rest = rest.slice(m[0].length);
    }
    if (!rest || /\s/.test(rest))
        return null;
    return [...mods.sort(), rest.toLowerCase()].join('+');
}

function lookupSchema(id) {
    return Gio.SettingsSchemaSource.get_default()?.lookup(id, true) ?? null;
}

// `backend` is only for tests (a memory backend); the shell passes nothing and reads the real settings.
function open(schema, backend, path) {
    const params = {settings_schema: schema};
    if (backend)
        params.backend = backend;
    if (path)
        params.path = path;
    return new Gio.Settings(params);
}

// Every [owner, accelerator] pair the desktop settings hold, read-only.
export function collectAccelerators(backend = null) {
    const owners = [];
    for (const id of SCHEMAS) {
        const schema = lookupSchema(id);
        if (!schema)
            continue;
        const settings = open(schema, backend);
        for (const key of schema.list_keys()) {
            const type = schema.get_key(key).get_value_type().dup_string();
            let values = [];
            if (type === 'as')
                values = settings.get_strv(key);
            else if (type === 's')
                values = [settings.get_string(key)];
            for (const v of values) {
                const n = normalizeAccel(v);
                if (n)
                    owners.push({owner: `${id} ${key}`, accel: n});
            }
        }
        if (id === CUSTOM_BASE) {
            const customSchema = lookupSchema(CUSTOM_SCHEMA);
            if (customSchema) {
                for (const path of settings.get_strv('custom-keybindings')) {
                    const s = open(customSchema, backend, path);
                    const n = normalizeAccel(s.get_string('binding'));
                    if (n)
                        owners.push({owner: `custom keybinding "${s.get_string('name')}"`, accel: n});
                }
            }
        }
    }
    return owners;
}

export class KeybindingManager {
    constructor(settings, handler, log = console.log, backend = null) {
        this._backend = backend;
        this._settings = settings;
        this._handler = handler;
        this._log = log;
        this._registered = false;
        this._watchers = [];
        this.status = {state: 'unregistered', accel: null, reason: ''};
        this._loggedFor = null;
    }

    enable() {
        this._settings.connectObject(`changed::${KEY_NAME}`, () => this.sync(), this);
        // moving input switching (or any other keybinding) away from the accelerator frees it
        for (const id of [...SCHEMAS]) {
            const schema = lookupSchema(id);
            if (!schema)
                continue;
            const s = open(schema, this._backend);
            s.connectObject('changed', () => this.sync(), this);
            this._watchers.push(s);
        }
        this.sync();
    }

    disable() {
        this._unregister();
        this._settings.disconnectObject(this);
        for (const w of this._watchers)
            w.disconnectObject(this);
        this._watchers = [];
    }

    _unregister() {
        if (this._registered) {
            Main.wm.removeKeybinding(KEY_NAME);
            this._registered = false;
        }
    }

    sync() {
        const accels = this._settings.get_strv(KEY_NAME);
        const wanted = accels.map(normalizeAccel).filter(Boolean);
        const conflicts = [];
        if (wanted.length) {
            for (const {owner, accel} of collectAccelerators(this._backend)) {
                if (wanted.includes(accel))
                    conflicts.push(owner);
            }
        }
        this._unregister();
        if (!wanted.length) {
            this.status = {state: 'unregistered', accel: null, reason: 'no accelerator set'};
            return this.status;
        }
        if (conflicts.length) {
            this.status = {state: 'conflict', accel: accels.join(','), reason: conflicts.join('; ')};
            const key = `${accels.join(',')}|${conflicts.join(';')}`;
            if (this._loggedFor !== key) {
                this._loggedFor = key;
                this._log(`A11 VitreSearch: ${accels.join(', ')} is already used by ${conflicts.join('; ')}; ` +
                    'keybinding not registered. Set another accelerator (see the README) or move the other one.');
            }
            return this.status;
        }
        const action = Main.wm.addKeybinding(KEY_NAME, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP, () => this._handler());   // POPUP: the key also closes VitreSearch while its own grab is active
        if (action === Meta.KeyBindingAction.NONE) {
            this.status = {state: 'failed', accel: accels.join(','), reason: 'Meta refused the accelerator'};
            this._log(`A11 VitreSearch: could not register ${accels.join(', ')}`);
            return this.status;
        }
        this._registered = true;
        this._loggedFor = null;
        this.status = {state: 'registered', accel: accels.join(','), reason: ''};
        return this.status;
    }
}

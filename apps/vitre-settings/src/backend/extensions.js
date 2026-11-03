// Which GNOME Shell extensions are installed, where, and whether the running shell has them active.
//
// First choice: ask the running shell (org.gnome.Shell.Extensions.ListExtensions). It returns the folder each extension
// was loaded from, which is what decides which schema file is the live one: a per-user copy in
// ~/.local/share/gnome-shell/extensions wins over a system copy in /usr/share, exactly as the shell resolves it.
//
// Fallback (no shell on the bus, for example under a test runner): scan the same folders in the shell's order and read
// the enabled list from org.gnome.shell plus the session mode file (the Vitre session enables its extensions through
// /usr/share/gnome-shell/modes/vitre.json, not through the enabled-extensions key).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The shell itself serves the org.gnome.Shell.Extensions interface at /org/gnome/Shell. (The bus name
// org.gnome.Shell.Extensions belongs to the Extensions app, which is only D-Bus activated.)
const BUS_NAME = 'org.gnome.Shell';
const OBJECT_PATH = '/org/gnome/Shell';
const IFACE = 'org.gnome.Shell.Extensions';

// ExtensionState in GNOME Shell 45 and later
const STATE_ACTIVE = 1;
const STATE_ERROR = 3;
const STATE_OUT_OF_DATE = 4;
const STATE_ACTIVATING = 8;

// Usable = its settings take effect. An enabled extension is INACTIVE while the screen is locked (the shell switches
// user extensions off in the lock screen), so "enabled and not broken" is the test, not "active right now".
function usable(info) {
    const state = Number(info.state ?? 0);
    if (state === STATE_ERROR || state === STATE_OUT_OF_DATE)
        return false;
    if (typeof info.enabled === 'boolean')
        return info.enabled;
    return state === STATE_ACTIVE || state === STATE_ACTIVATING;
}

function extensionDirs() {
    const dirs = [GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions'])];
    for (const d of GLib.get_system_data_dirs())
        dirs.push(GLib.build_filenamev([d, 'gnome-shell', 'extensions']));
    return dirs;
}

function readJson(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch {
        return null;
    }
}

function settingsStrv(schemaId, key) {
    const source = Gio.SettingsSchemaSource.get_default();
    const schema = source?.lookup(schemaId, true);
    if (!schema?.has_key(key))
        return [];
    return new Gio.Settings({settings_schema: schema}).get_strv(key);
}

export class ExtensionIndex {
    constructor() {
        this._entries = new Map();   // uuid -> {uuid, path, active, name}
        this.shellReachable = false;
        this.shellVersion = null;
        this._signalId = 0;
    }

    load() {
        this._entries.clear();
        this.shellReachable = false;
        if (GLib.getenv('VITRE_SETTINGS_NO_SHELL') !== '1' && this._loadFromShell())
            this.shellReachable = true;
        else
            this._loadFromDisk();
    }

    _loadFromShell() {
        try {
            const bus = Gio.DBus.session;
            const reply = bus.call_sync(BUS_NAME, OBJECT_PATH, IFACE, 'ListExtensions', null,
                new GLib.VariantType('(a{sa{sv}})'), Gio.DBusCallFlags.NO_AUTO_START, 2000, null);
            const [list] = reply.recursiveUnpack();
            for (const [uuid, info] of Object.entries(list)) {
                this._entries.set(uuid, {
                    uuid,
                    path: info.path ?? null,
                    name: info.name ?? uuid,
                    active: usable(info),
                });
            }
            try {
                const v = bus.call_sync(BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                    new GLib.Variant('(ss)', [IFACE, 'ShellVersion']), null, Gio.DBusCallFlags.NO_AUTO_START, 1000, null);
                this.shellVersion = v.recursiveUnpack()[0];
            } catch {
                this.shellVersion = null;
            }
            return true;
        } catch {
            return false;
        }
    }

    _modeExtensions() {
        const mode = GLib.getenv('GNOME_SHELL_SESSION_MODE');
        if (!mode)
            return [];
        for (const d of GLib.get_system_data_dirs()) {
            const json = readJson(GLib.build_filenamev([d, 'gnome-shell', 'modes', `${mode}.json`]));
            if (json?.enabledExtensions)
                return json.enabledExtensions;
        }
        return [];
    }

    _loadFromDisk() {
        const enabled = new Set([...settingsStrv('org.gnome.shell', 'enabled-extensions'), ...this._modeExtensions()]);
        const disabled = new Set(settingsStrv('org.gnome.shell', 'disabled-extensions'));
        // With no enabled list at all (an empty test profile) nothing could be told apart: count every installed one.
        const assumeAll = enabled.size === 0;
        for (const dir of extensionDirs()) {
            let children;
            try {
                children = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch {
                continue;
            }
            for (let info; (info = children.next_file(null));) {
                const uuid = info.get_name();
                if (this._entries.has(uuid))
                    continue;   // the first folder wins, as in the shell
                const path = GLib.build_filenamev([dir, uuid]);
                const meta = readJson(GLib.build_filenamev([path, 'metadata.json']));
                if (!meta)
                    continue;
                this._entries.set(uuid, {
                    uuid, path, name: meta.name ?? uuid,
                    active: !disabled.has(uuid) && (assumeAll || enabled.has(uuid)),
                });
            }
        }
    }

    get(uuid) {
        return this._entries.get(uuid) ?? null;
    }

    isActive(uuid) {
        return Boolean(this._entries.get(uuid)?.active);
    }

    // Calls back when the shell reports an extension turning on or off (the window rebuilds its pages).
    watch(callback) {
        if (this._signalId)
            return;
        this._signalId = Gio.DBus.session.signal_subscribe(BUS_NAME, IFACE, 'ExtensionStateChanged', OBJECT_PATH,
            null, Gio.DBusSignalFlags.NONE, () => callback());
    }

    unwatch() {
        if (this._signalId)
            Gio.DBus.session.signal_unsubscribe(this._signalId);
        this._signalId = 0;
    }
}

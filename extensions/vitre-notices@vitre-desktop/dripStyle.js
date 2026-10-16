/* The shared `drip-style` setting: `liquid` (default) or `classic` (the reference-measured motion of A9 / A13 / A15,
 * unchanged). The key lives in the schema of the vitre-menus@vitre-desktop extension
 * (org.gnome.shell.extensions.vitre-menus); Control Center, Notification Center and the menu-bar HUD read it
 * without depending on that extension being loaded: when the schema cannot be found they fall back to
 * `liquid`. Read live at every open, so a change applies to the next pop-out without a login. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UUID = 'vitre-menus@vitre-desktop';
const SCHEMA_ID = 'org.gnome.shell.extensions.vitre-menus';
export const STYLES = ['liquid', 'classic'];

function findSchemaDir() {
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    for (const dir of dirs) {
        const path = GLib.build_filenamev([dir, 'gnome-shell', 'extensions', UUID, 'schemas']);
        if (GLib.file_test(GLib.build_filenamev([path, 'gschemas.compiled']), GLib.FileTest.EXISTS))
            return path;
    }
    return null;
}

export class DripStyle {
    constructor() {
        this._settings = null;
        this._override = null;
        try {
            const dir = findSchemaDir();
            if (dir) {
                const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
                const schema = source.lookup(SCHEMA_ID, false);
                if (schema)
                    this._settings = new Gio.Settings({settings_schema: schema});
            }
        } catch (_e) {
            this._settings = null;
        }
    }

    // rig only: force a style without touching dconf
    setOverride(value) {
        this._override = value;
    }

    get value() {
        if (this._override)
            return this._override;
        try {
            const v = this._settings?.get_string('drip-style');
            return STYLES.includes(v) ? v : 'liquid';
        } catch (_e) {
            return 'liquid';
        }
    }

    get liquid() {
        return this.value === 'liquid';
    }

    get hasSchema() {
        return Boolean(this._settings);
    }

    destroy() {
        this._settings = null;
    }
}

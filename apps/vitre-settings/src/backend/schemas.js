// Finds the settings schema a row writes to, at run time.
//
// A spec names a schema and, for a GNOME Shell extension, the extension that reads it:
//     {schema: 'org.gnome.shell.extensions.vitre-swipe', ext: 'vitre-swipe@vitre-desktop'}
// Extension schemas are looked up in that extension's own schemas/ folder (the folder the shell loaded it from), with the
// system schemas as the parent source; plain GNOME schemas ({schema: 'org.gnome.desktop.interface'}) come from the
// default source. Writes go through Gio.Settings, so the per-user install and the system packages are handled the same.
//
// A spec resolves to nothing when the extension is missing or not active, or the schema or key does not exist. Rows built
// on a spec that resolves to nothing are never shown: no switch that does nothing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class SettingsRegistry {
    constructor(extensions) {
        this.extensions = extensions;
        this._sources = new Map();    // schemas dir -> Gio.SettingsSchemaSource | null
        this._settings = new Map();   // cache key -> Gio.Settings
    }

    reset() {
        this._sources.clear();
        this._settings.clear();
    }

    _sourceFor(dir) {
        if (!this._sources.has(dir)) {
            let source = null;
            if (GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS)) {
                try {
                    source = Gio.SettingsSchemaSource.new_from_directory(dir,
                        Gio.SettingsSchemaSource.get_default(), false);
                } catch (e) {
                    console.warn(`vitre-settings: cannot read schemas in ${dir}: ${e.message}`);
                }
            }
            this._sources.set(dir, source);
        }
        return this._sources.get(dir);
    }

    // Gio.SettingsSchema for a spec, or null.
    schema(spec) {
        if (!spec)
            return null;
        if (spec.ext) {
            const ext = this.extensions.get(spec.ext);
            if (!ext?.active || !ext.path)
                return null;
            const source = this._sourceFor(GLib.build_filenamev([ext.path, 'schemas']));
            // an extension may also ship its schema system-wide (glib-2.0/schemas): fall back to the default source
            return source?.lookup(spec.schema, false) ??
                Gio.SettingsSchemaSource.get_default()?.lookup(spec.schema, true) ?? null;
        }
        return Gio.SettingsSchemaSource.get_default()?.lookup(spec.schema, true) ?? null;
    }

    has(spec, key) {
        const schema = this.schema(spec);
        return Boolean(schema && (!key || schema.has_key(key)));
    }

    // Gio.Settings for a spec (shared, so every row on the same schema sees the same object), or null.
    settings(spec) {
        const schema = this.schema(spec);
        if (!schema)
            return null;
        const id = `${spec.ext ?? ''}|${spec.schema}`;
        if (!this._settings.has(id))
            this._settings.set(id, new Gio.Settings({settings_schema: schema}));
        return this._settings.get(id);
    }

    // The first spec of a list that resolves and has every key named (used for the Dock: Vitre Dock or Dhruva).
    first(specs, keys = []) {
        for (const spec of specs) {
            const schema = this.schema(spec);
            if (schema && keys.every(k => schema.has_key(k)))
                return spec;
        }
        return null;
    }

    // Range or choices of a key as the schema declares them: {type: 'range', min, max} | {type: 'enum', values} | null
    range(spec, key) {
        const schema = this.schema(spec);
        if (!schema?.has_key(key))
            return null;
        const [type, value] = schema.get_key(key).get_range().recursiveUnpack();
        if (type === 'range')
            return {type, min: value[0], max: value[1]};
        if (type === 'enum')
            return {type, values: value};
        return null;
    }
}

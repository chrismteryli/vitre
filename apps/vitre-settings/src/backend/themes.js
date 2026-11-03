// Installed icon themes, cursor themes and Vitre wallpapers, read from the standard folders at run time.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function iconDirs() {
    return [
        GLib.build_filenamev([GLib.get_home_dir(), '.icons']),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']),
        ...GLib.get_system_data_dirs().map(d => GLib.build_filenamev([d, 'icons'])),
    ];
}

function children(dir) {
    const out = [];
    try {
        const e = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = e.next_file(null));)
            out.push(info.get_name());
    } catch {
        // folder missing
    }
    return out.sort();
}

function readIndex(path) {
    const kf = new GLib.KeyFile();
    try {
        kf.load_from_file(path, GLib.KeyFileFlags.NONE);
    } catch {
        return null;
    }
    const get = key => {
        try {
            return kf.get_locale_string('Icon Theme', key, null);
        } catch {
            return null;
        }
    };
    return {name: get('Name'), hidden: get('Hidden') === 'true', directories: get('Directories')};
}

const SKIP = new Set(['default', 'hicolor', 'locolor']);

// [{id, name}] with the Vitre themes first. kind: 'icons' | 'cursors'
export function listThemes(kind) {
    const found = new Map();
    for (const dir of iconDirs()) {
        for (const id of children(dir)) {
            if (found.has(id) || SKIP.has(id))
                continue;
            const base = GLib.build_filenamev([dir, id]);
            const index = readIndex(GLib.build_filenamev([base, 'index.theme']));
            if (kind === 'cursors') {
                if (!GLib.file_test(GLib.build_filenamev([base, 'cursors']), GLib.FileTest.IS_DIR))
                    continue;
            } else if (!index?.directories || index.hidden) {
                continue;
            }
            found.set(id, {id, name: index?.name || id});
        }
    }
    const vitreFirst = t => (t.id.startsWith('Vitre') ? 0 : 1);
    return [...found.values()].sort((a, b) => vitreFirst(a) - vitreFirst(b) || a.name.localeCompare(b.name));
}

// Vitre wallpapers as light and dark pairs: [{id, name, light, dark}] (paths). The per-user copy wins over the system one.
export function listWallpapers() {
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
        .map(d => GLib.build_filenamev([d, 'backgrounds', 'vitre']));
    const pairs = new Map();
    for (const dir of dirs) {
        for (const file of children(dir)) {
            const m = /^vitre-([a-z0-9]+)-(light|dark)\.(png|jpg|jpeg|webp)$/.exec(file);
            if (!m)
                continue;
            const [, id, variant] = m;
            if (!pairs.has(id))
                pairs.set(id, {id, name: id.charAt(0).toUpperCase() + id.slice(1), dir});
            const pair = pairs.get(id);
            if (pair.dir === dir && !pair[variant])
                pair[variant] = GLib.build_filenamev([dir, file]);
        }
    }
    // Drift is the Vitre default and leads the set
    const order = id => (id === 'drift' ? 0 : 1);
    return [...pairs.values()].filter(p => p.light && p.dark)
        .sort((a, b) => order(a.id) - order(b.id) || a.name.localeCompare(b.name));
}

export function uriToPath(uri) {
    try {
        return uri ? Gio.File.new_for_uri(uri).get_path() : null;
    } catch {
        return null;
    }
}

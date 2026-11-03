/*
* Dhruva GNOME Extension
* Copyright (C) 2026 NarkAgni
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Vitre (B5): the files of a folder shown as a stack in the Dock. One source per folder path, shared by every Dock that
// shows it (refcounted), kept up to date by a Gio.FileMonitor. The Dock rebuilds its buttons on every render, so the
// stack's state lives here and the buttons only show it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


const ATTRS = [
    'standard::name', 'standard::display-name', 'standard::content-type', 'standard::icon', 'standard::type',
    'standard::is-hidden', 'standard::is-backup', 'standard::size',
    'time::created', 'time::created-usec', 'time::changed', 'time::changed-usec', 'time::modified', 'time::modified-usec',
    'thumbnail::path', 'thumbnail::is-valid',
].join(',');
const BATCH = 200;
const MAX_ITEMS = 2000;
const REFRESH_DEBOUNCE_MS = 220;
// downloads that are still being written (browsers rename them when they are done)
const PARTIAL = /\.(crdownload|part|partial|download|opdownload|tmp)$/i;

const _sources = new Map();
const _collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function downloadsPath() {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
}

export function normalizePath(path) {
    if (!path) return '';
    let p = path;
    if (p.startsWith('file://')) {
        const f = Gio.File.new_for_uri(p);
        p = f.get_path() || p;
    }
    if (p.startsWith('~/')) p = GLib.build_filenamev([GLib.get_home_dir(), p.slice(2)]);
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// the moment a file arrived in the folder: its birth time when it was created there, else the last inode change (a move
// into the folder changes it, an archive's old modification time does not)
function stamp(info, attr) {
    if (!info.has_attribute(attr)) return 0;
    const usec = info.has_attribute(`${attr}-usec`) ? info.get_attribute_uint32(`${attr}-usec`) : 0;
    return info.get_attribute_uint64(attr) * 1e6 + usec;
}

function addedTime(info) {
    const best = Math.max(stamp(info, 'time::created'), stamp(info, 'time::changed'));
    return best || stamp(info, 'time::modified');
}

function toEntry(dir, info) {
    const name = info.get_name();
    const file = dir.get_child(name);
    const type = info.get_file_type();
    let thumb = null;
    if (info.has_attribute('thumbnail::path') &&
        (!info.has_attribute('thumbnail::is-valid') || info.get_attribute_boolean('thumbnail::is-valid'))) {
        thumb = info.get_attribute_byte_string('thumbnail::path') || null;
    }
    return {
        name,
        displayName: info.get_display_name() || name,
        file,
        uri: file.get_uri(),
        path: file.get_path(),
        contentType: info.get_content_type() || '',
        gicon: info.get_icon(),
        isDir: type === Gio.FileType.DIRECTORY,
        size: info.get_size(),
        added: addedTime(info),
        thumb,
    };
}

function sortEntries(list, sort) {
    if (sort === 'name') {
        list.sort((a, b) => _collator.compare(a.displayName, b.displayName));
    } else {
        // newest first; equal times fall back to the name so the order is stable
        list.sort((a, b) => (b.added - a.added) || _collator.compare(a.displayName, b.displayName));
    }
    return list;
}

class StackSource {
    constructor(path) {
        this.path = path;
        this.dir = Gio.File.new_for_path(path);
        this.entries = [];
        this.loaded = false;
        this.exists = true;
        this._sort = 'date-added';
        this._listeners = new Set();
        this._refs = 0;
        this._monitor = null;
        this._refreshId = 0;
        this._cancellable = null;
        this._generation = 0;
        this._startMonitor();
        this.refresh();
    }

    get sort() {
        return this._sort;
    }

    set sort(value) {
        const v = value === 'name' ? 'name' : 'date-added';
        if (v === this._sort) return;
        this._sort = v;
        sortEntries(this.entries, v);
        this._emit();
    }

    addListener(fn) {
        this._listeners.add(fn);
    }

    removeListener(fn) {
        this._listeners.delete(fn);
    }

    _emit() {
        for (const fn of [...this._listeners]) {
            try {
                fn(this);
            } catch (e) {
                console.warn(`[Dhruva] stack listener failed: ${e.message}`);
            }
        }
    }

    _startMonitor() {
        try {
            this._monitor = this.dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.set_rate_limit(250);
            this._monitor.connect('changed', () => this._queueRefresh());
        } catch (e) {
            this._monitor = null;
            console.warn(`[Dhruva] stack: cannot watch ${this.path}: ${e.message}`);
        }
    }

    _queueRefresh() {
        if (this._refreshId) return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_LOW, REFRESH_DEBOUNCE_MS, () => {
            this._refreshId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh() {
        if (this._cancellable) this._cancellable.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const generation = ++this._generation;
        const found = [];
        const done = exists => {
            if (generation !== this._generation) return;
            this._cancellable = null;
            this.exists = exists;
            this.entries = sortEntries(found, this._sort).slice(0, MAX_ITEMS);
            this.loaded = true;
            this._emit();
        };
        this.dir.enumerate_children_async(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, (dir, res) => {
            let enumerator;
            try {
                enumerator = dir.enumerate_children_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) done(false);
                return;
            }
            const next = () => {
                enumerator.next_files_async(BATCH, GLib.PRIORITY_LOW, cancellable, (en, r) => {
                    let infos;
                    try {
                        infos = en.next_files_finish(r);
                    } catch (e) {
                        en.close_async(GLib.PRIORITY_LOW, null, () => {});
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) done(true);
                        return;
                    }
                    if (!infos || infos.length === 0) {
                        en.close_async(GLib.PRIORITY_LOW, null, () => {});
                        done(true);
                        return;
                    }
                    for (const info of infos) {
                        const name = info.get_name();
                        if (info.get_is_hidden() || info.get_is_backup() || name.startsWith('.') || PARTIAL.test(name)) continue;
                        found.push(toEntry(this.dir, info));
                    }
                    next();
                });
            };
            next();
        });
    }

    destroy() {
        this._generation++;
        if (this._cancellable) this._cancellable.cancel();
        this._cancellable = null;
        if (this._refreshId) GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
        this._listeners.clear();
    }
}

// a source for `path`; every acquire needs one release
export function acquireStackSource(path) {
    const p = normalizePath(path);
    let source = _sources.get(p);
    if (!source) {
        source = new StackSource(p);
        _sources.set(p, source);
    }
    source._refs++;
    return source;
}

export function releaseStackSource(source) {
    if (!source || source._refs <= 0) return;
    source._refs--;
    if (source._refs === 0) {
        if (_sources.get(source.path) === source) _sources.delete(source.path);
        source.destroy();
    }
}

export function destroyAllStackSources() {
    for (const source of _sources.values()) source.destroy();
    _sources.clear();
}

// diagnostics (the rig checks that disable leaves no folder watched)
export function stackSourceCount() {
    return _sources.size;
}

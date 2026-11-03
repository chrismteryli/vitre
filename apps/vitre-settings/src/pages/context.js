// What a page builder gets: the settings registry, the extension index, and bookkeeping so a rebuild drops every handler
// the old rows connected.
import Adw from 'gi://Adw';

export class PageContext {
    constructor({registry, extensions, window, app}) {
        this.registry = registry;
        this.extensions = extensions;
        this.window = window;
        this.app = app;
        this._handlers = [];
        this._disposers = [];
    }

    // Gio.Settings for a spec when it resolves and has every key named, else null.
    settings(spec, ...keys) {
        if (!spec || !keys.every(k => this.registry.has(spec, k)))
            return null;
        return this.registry.settings(spec);
    }

    track(object, id) {
        this._handlers.push([object, id]);
    }

    onDispose(fn) {
        this._disposers.push(fn);
    }

    dispose() {
        for (const [object, id] of this._handlers)
            object.disconnect(id);
        this._handlers = [];
        for (const fn of this._disposers)
            fn();
        this._disposers = [];
    }

    toast(title) {
        this.window?.toast(title);
    }

    // Adds a group with the rows that exist (null rows are skipped). Returns null and adds nothing when none exist.
    group(page, {title = '', description = ''}, rows) {
        rows = rows.flat().filter(Boolean);
        if (rows.length === 0)
            return null;
        const group = new Adw.PreferencesGroup({title, description});
        for (const row of rows)
            group.add(row);
        page.add(group);
        page._vitreGroups = (page._vitreGroups ?? 0) + 1;
        return group;
    }
}

export function newPage({name, title, icon}) {
    const page = new Adw.PreferencesPage({name, title, icon_name: icon});
    return page;
}

// The page, or null when no group made it onto it (the page is then left out of the sidebar).
export function finish(page) {
    return page._vitreGroups > 0 ? page : null;
}

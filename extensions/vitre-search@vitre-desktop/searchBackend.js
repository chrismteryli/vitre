/* Search for VitreSearch: GNOME's own search providers, queried the way the overview does it
 * (search.js SearchResultsView): the application provider (apps + system actions) and every enabled
 * remote provider from gnome-shell/search-providers/*.ini (Files, Calculator, Settings, ...), loaded with
 * the shell's own loadRemoteSearchProviders(). Results are grouped for the four filter buttons:
 *   apps      application results (.desktop ids)
 *   actions   system actions (Lock Screen, Log Out ...: the application provider's non-.desktop ids)
 *             and every remote provider except Files (Settings, Calculator, Characters ...)
 *   files     the Files (Nautilus) provider
 *   clipboard the CURRENT clipboard text only (GNOME has no clipboard history; none is kept here)
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {AppSearchProvider} from 'resource:///org/gnome/shell/ui/appDisplay.js';
import {loadRemoteSearchProviders} from 'resource:///org/gnome/shell/ui/remoteSearch.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

export const GROUPS = ['apps', 'files', 'actions', 'clipboard'];
export const GROUP_TITLES = {apps: 'Applications', files: 'Files', actions: 'Actions', clipboard: 'Clipboard', other: 'Other'};
const FILES_PROVIDER = 'org.gnome.Nautilus.desktop';
const SEARCH_DELAY_MS = 90;
const PER_GROUP = {apps: 5, files: 4, actions: 4, clipboard: 1, other: 3};
const PER_GROUP_FILTERED = {apps: 8, files: 8, actions: 8, clipboard: 1, other: 8};

function groupOf(provider, id) {
    if (provider.id === 'applications')
        return id.endsWith('.desktop') ? 'apps' : 'actions';
    if (provider.id === FILES_PROVIDER)
        return 'files';
    return 'actions';
}

export class SearchBackend {
    constructor({useRemote = true, onChanged = () => {}} = {}) {
        this._onChanged = onChanged;
        this._providers = [];
        this._raw = new Map();       // provider.id -> ids of the current terms
        this._items = new Map();     // provider.id -> [{group, provider, id, meta}]
        this._terms = [];
        this._termsStr = '';
        this._gen = 0;
        this._timeoutId = 0;
        this._cancellable = new Gio.Cancellable();
        this._clipboardText = '';
        this._pending = 0;

        this.addProvider(new AppSearchProvider());
        if (useRemote) {
            try {
                const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
                for (const p of loadRemoteSearchProviders(settings))
                    this.addProvider(p);
            } catch (e) {
                console.log(`A11 VitreSearch: remote search providers not loaded: ${e.message}`);
            }
        }
    }

    get providerIds() {
        return this._providers.map(p => p.id);
    }

    get terms() {
        return this._terms;
    }

    get searching() {
        return this._timeoutId !== 0 || this._pending > 0;
    }

    addProvider(provider) {
        provider.searchInProgress = false;
        this._providers.push(provider);
    }

    removeProvider(provider) {
        const i = this._providers.indexOf(provider);
        if (i >= 0)
            this._providers.splice(i, 1);
        this._items.delete(provider.id);
        this._raw.delete(provider.id);
    }

    reset() {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        this._gen++;
        this._terms = [];
        this._termsStr = '';
        this._raw.clear();
        this._items.clear();
        this._pending = 0;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    setQuery(text) {
        const terms = text.split(/\s+/).filter(Boolean);
        const str = terms.join(' ');
        if (str === this._termsStr)
            return;
        if (terms.length === 0) {
            this.reset();
            this._onChanged();
            return;
        }
        const isSub = this._termsStr !== '' && str.startsWith(this._termsStr);
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        this._gen++;
        this._pending = 0;
        this._terms = terms;
        this._termsStr = str;
        this._isSub = isSub;
        this._previousRaw = isSub ? new Map(this._raw) : new Map();
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._timeoutId = 0;
            this._run(this._gen);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Force a queued search now (used when Return is pressed before the debounce fired).
    flush() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
            this._run(this._gen);
        }
    }

    async _run(gen) {
        const terms = this._terms;
        const cancellable = this._cancellable;
        const previous = this._previousRaw;
        const isSub = this._isSub;
        this._pending += this._providers.length;
        this.refreshClipboard();
        await Promise.all(this._providers.map(async provider => {
            try {
                let ids;
                if (isSub && previous.has(provider.id))
                    ids = await provider.getSubsearchResultSet(previous.get(provider.id), terms, cancellable);
                else
                    ids = await provider.getInitialResultSet(terms, cancellable);
                if (gen !== this._gen)
                    return;
                this._raw.set(provider.id, ids);
                const limit = 12;
                const shown = provider.filterResults(ids, limit);
                const metas = shown.length ? await provider.getResultMetas(shown, cancellable) : [];
                if (gen !== this._gen)
                    return;
                this._items.set(provider.id, metas.map(meta => ({
                    group: groupOf(provider, meta.id), provider, id: meta.id, meta,
                })));
                this._onChanged();
            } catch (e) {
                if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                    console.log(`A11 VitreSearch: provider ${provider.id} failed: ${e.message}`);
            } finally {
                if (gen === this._gen)
                    this._pending--;
            }
        }));
        if (gen === this._gen)
            this._onChanged();
    }

    // The clipboard is read when VitreSearch opens, per query and when the Clipboard filter is chosen.
    refreshClipboard() {
        try {
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                this._clipboardText = text ?? '';
                this._onChanged();
            });
        } catch (_e) { /* no clipboard in this session */ }
    }

    clipboardItem() {
        const text = this._clipboardText;
        if (!text)
            return null;
        const first = text.split('\n')[0].trim().slice(0, 90);
        if (!first)
            return null;
        return {
            group: 'clipboard', provider: null, id: 'clipboard:current',
            meta: {id: 'clipboard:current', name: first, description: 'Clipboard',
                createIcon: size => new St.Icon({icon_name: 'edit-paste-symbolic', icon_size: size}),
                clipboardText: text},
        };
    }

    /* Items to show: `filter` is null or one of GROUPS. Returns {top, sections: [{group, items}]}. */
    view(filter, maxRows = 12) {
        const byGroup = {apps: [], files: [], actions: [], other: [], clipboard: []};
        for (const provider of this._providers) {
            for (const it of this._items.get(provider.id) ?? [])
                byGroup[it.group].push(it);
        }
        const clip = this.clipboardItem();
        if (clip && (filter === 'clipboard' ||
            (this._terms.length && this._terms.every(t => clip.meta.clipboardText.toLowerCase().includes(t.toLowerCase())))))
            byGroup.clipboard.push(clip);
        const limits = filter ? PER_GROUP_FILTERED : PER_GROUP;
        const sections = [];
        const order = filter ? [filter] : ['apps', 'actions', 'files', 'clipboard'];
        for (const g of order) {
            const items = byGroup[g].slice(0, limits[g]);
            if (items.length)
                sections.push({group: g, items});
        }
        let top = null;
        if (!filter && sections.length) {
            top = sections[0].items.shift();
            if (!sections[0].items.length)
                sections.shift();
        }
        // trim to the room available
        let rows = top ? 1 : 0;
        const trimmed = [];
        for (const s of sections) {
            const room = Math.max(0, maxRows - rows);
            if (!room)
                break;
            const items = s.items.slice(0, room);
            rows += items.length;
            trimmed.push({group: s.group, items});
        }
        return {top, sections: trimmed, rows};
    }

    activate(item) {
        if (item.group === 'clipboard') {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.meta.clipboardText);
            return;
        }
        const provider = item.provider;
        if (provider.id === 'applications') {
            if (item.id.endsWith('.desktop')) {
                const app = provider._appSys.lookup_app(item.id);
                app?.activate();
            } else {
                SystemActions.getDefault().activateAction(item.id);
            }
            return;
        }
        provider.activateResult(item.id, this._terms);
        if (item.meta.clipboardText)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.meta.clipboardText);
    }

    destroy() {
        this.reset();
        this._providers = [];
        this._onChanged = () => {};
    }
}

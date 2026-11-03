/* Apps view (A19): the app grid inside Vitre Search, in place of GNOME's app grid.
 *
 * Layout follows the the reference design single-window Apps view (plans/A19-measurements.md, look B): the search bar on
 * top, then in the same glass panel a row of category chips, one row of suggestions under a hairline, and the
 * scrolling grid of every app (name order). Typing in the bar filters the grid. Arrows move the selection,
 * Return opens the app.
 *
 * Motion (the owner's pick, "from what you touched"): the panel grows out of the bar with the results-panel
 * expand, and the icons ripple in from the point that opened the view (the Dock's apps button under the
 * pointer, the Apps button, or the bar's centre for the keyboard), each one fading and growing from 0.92
 * with a delay that grows with its distance from that point. All times are absolute (St's slow-down factor
 * is divided out), and reduced motion shows the grid at once.
 */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Spring, Fade, role, EPS_OPACITY} from './liquid.js';
import {Ticker, motionMode} from './liquidClock.js';

const PT = 1.15;                                // GNOME logical px per the reference point
export const APPS = {
    cols: 5,
    tileW: 132,                                 // 115 pt column pitch
    tileH: 112,                                 // 102 pt row pitch, a little tighter for five rows in view
    icon: 64,
    chipsH: 40,
    suggestH: 120,
    hairH: 9,
    padTop: 6,
    padBottom: 10,
    ripple: {fromScale: 0.92, msPerPx: 0.32, maxDelay: 170},     // a tile starts this much later per px from the origin (a spill)
};

// the reference design's categories, mapped from freedesktop Categories= keys (first match wins)
const CATEGORIES = [
    {id: 'utilities', label: 'Utilities', keys: ['Utility', 'System', 'Settings', 'Accessibility', 'TerminalEmulator', 'FileManager', 'Monitor', 'PackageManager', 'Security', 'Archiving', 'Filesystem']},
    {id: 'productivity', label: 'Productivity', keys: ['Office', 'Finance', 'ProjectManagement', 'Calendar', 'ContactManagement', 'WordProcessor', 'Spreadsheet', 'Presentation', 'TextEditor', 'Development', 'IDE']},
    {id: 'creativity', label: 'Creativity', keys: ['Graphics', 'Photography', 'AudioVideoEditing', '2DGraphics', '3DGraphics', 'RasterGraphics', 'VectorGraphics', 'Recorder', 'Music', 'Video']},
    {id: 'reading', label: 'Reading', keys: ['Education', 'Science', 'Documentation', 'Viewer', 'Dictionary', 'Literature', 'News', 'Maps']},
    {id: 'social', label: 'Social', keys: ['Network', 'Chat', 'InstantMessaging', 'Email', 'WebBrowser', 'VideoConference', 'Telephony']},
    {id: 'entertainment', label: 'Entertainment', keys: ['Game', 'AudioVideo', 'Player', 'TV']},
    {id: 'other', label: 'Other', keys: []},
];

function categoryOf(app) {
    let raw = '';
    try {
        raw = app.get_app_info()?.get_categories() ?? '';
    } catch (_e) {
        raw = '';
    }
    const cats = raw.split(';').filter(Boolean);
    for (const c of CATEGORIES) {
        if (c.keys.some(k => cats.includes(k)))
            return c.id;
    }
    return 'other';
}

export class AppsGrid {
    constructor({onActivate}) {
        this._onActivate = onActivate;
        this._apps = [];
        this._tiles = [];
        this._visible = [];
        this._selected = -1;
        this._category = null;
        this._query = '';
        this._origin = null;

        this.actor = new St.BoxLayout({style_class: 'sp-apps', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._chips = new St.BoxLayout({style_class: 'sp-chips', x_align: Clutter.ActorAlign.CENTER});
        this._chipButtons = CATEGORIES.map(c => {
            const b = new St.Button({style_class: 'sp-chip', label: c.label, can_focus: false, track_hover: true});
            b._cat = c.id;
            b.connect('clicked', () => this.setCategory(this._category === c.id ? null : c.id));
            this._chips.add_child(b);
            return b;
        });
        this.actor.add_child(this._chips);

        this._suggestBox = new St.BoxLayout({style_class: 'sp-apps-suggest', x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._suggestBox);
        this._hair = new St.Widget({style_class: 'sp-apps-hairline', x_expand: true});
        this.actor.add_child(this._hair);

        this._scroll = new St.ScrollView({style_class: 'sp-apps-scroll', overlay_scrollbars: true, x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this._gridBox = new St.BoxLayout({style_class: 'sp-apps-grid', orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
        this._scroll.set_child(this._gridBox);
        this.actor.add_child(this._scroll);

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject('installed-changed', () => {
            this._loadApps();
            this._render(false);
        }, this);
        this._loadApps();
    }

    destroy() {
        this._appSystem.disconnectObject(this);
        this.actor.destroy();
    }

    // ---- data --------------------------------------------------------------------------------

    _loadApps() {
        const seen = new Set();
        this._apps = [];
        for (const info of Gio.AppInfo.get_all()) {
            if (!info.should_show())
                continue;
            const app = this._appSystem.lookup_app(info.get_id());
            if (!app || seen.has(app.get_id()))
                continue;
            seen.add(app.get_id());
            this._apps.push({app, name: app.get_name() ?? '', cat: categoryOf(app),
                keywords: (info.get_keywords?.() ?? []).join(' ').toLowerCase()});
        }
        this._apps.sort((a, b) => a.name.localeCompare(b.name));
    }

    _suggestions() {
        const used = Shell.AppUsage.get_default().get_most_used().filter(a => a && a.get_app_info()?.should_show());
        return used.slice(0, APPS.cols);
    }

    // ---- public ------------------------------------------------------------------------------

    // origin: stage point the ripple starts from, or null for the panel's top centre
    show(origin) {
        this._origin = origin;
        this._query = '';
        this._category = null;
        this._syncChips();
        this._render(true);
    }

    setQuery(text) {
        const q = (text ?? '').trim().toLowerCase();
        if (q === this._query)
            return;
        this._query = q;
        this._render(false);
    }

    setCategory(id) {
        this._category = id;
        this._syncChips();
        this._render(false);
    }

    // height the panel needs for this content (px), capped by the caller
    get _suggestHeight() {
        return this._suggestBox.visible && this._suggestBox.get_n_children() > 0 ? APPS.suggestH + APPS.hairH : 0;
    }

    get naturalHeight() {
        const n = this._visible.length - (this._suggestHeight ? this._suggestBox.get_n_children() : 0);
        const rows = Math.max(1, Math.ceil(n / APPS.cols));
        const suggest = this._suggestHeight;
        return APPS.padTop + APPS.chipsH + suggest + rows * APPS.tileH + APPS.padBottom;
    }

    // the panel's current height, so the scroll view fills what is left
    fitTo(panelH) {
        const suggest = this._suggestHeight;
        const h = Math.max(APPS.tileH, panelH - APPS.padTop - APPS.chipsH - suggest - APPS.padBottom);
        if (Math.abs(this._scroll.height - h) > 0.5)
            this._scroll.set_height(h);
    }

    move(dx, dy) {
        if (!this._visible.length)
            return;
        let i = this._selected < 0 ? 0 : this._selected + dx + dy * APPS.cols;
        i = Math.max(0, Math.min(this._visible.length - 1, i));
        this._select(i);
    }

    activateSelected() {
        const t = this._visible[this._selected];
        if (t)
            this._onActivate(t._app);
        return Boolean(t);
    }

    // ---- view --------------------------------------------------------------------------------

    _syncChips() {
        for (const b of this._chipButtons) {
            if (b._cat === this._category)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
    }

    _makeTile(app) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'sp-app-box', x_align: Clutter.ActorAlign.CENTER});
        let icon = null;
        try {
            icon = app.create_icon_texture(APPS.icon);
        } catch (_e) {
            icon = new St.Icon({icon_name: 'application-x-executable', icon_size: APPS.icon});
        }
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        const label = new St.Label({text: app.get_name() ?? '', style_class: 'sp-app-label', x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = 3;   // Pango.EllipsizeMode.END
        box.add_child(label);
        const tile = new St.Button({style_class: 'sp-app', child: box, can_focus: false, track_hover: true, reactive: true});
        tile.set_size(APPS.tileW, APPS.tileH);
        tile.set_pivot_point(0.5, 0.5);
        tile._app = app;
        tile.connect('clicked', () => this._onActivate(app));
        tile.connect('notify::hover', () => {
            if (tile.hover)
                this._select(this._visible.indexOf(tile), false);
        });
        return tile;
    }

    _render(ripple) {
        // suggestions (only with no query and no category, as on the reference design)
        this._suggestBox.destroy_all_children();
        const showSuggest = !this._query && !this._category;
        this._suggestBox.visible = showSuggest;
        this._hair.visible = showSuggest;
        const tiles = [];
        if (showSuggest) {
            for (const app of this._suggestions()) {
                const t = this._makeTile(app);
                this._suggestBox.add_child(t);
                tiles.push(t);
            }
        }
        if (!this._suggestBox.get_n_children()) {
            this._suggestBox.visible = false;
            this._hair.visible = false;
        }
        // grid
        this._gridBox.destroy_all_children();
        const list = this._apps.filter(a =>
            (!this._category || a.cat === this._category) &&
            (!this._query || a.name.toLowerCase().includes(this._query) || a.keywords.includes(this._query)));
        let row = null;
        list.forEach((a, i) => {
            if (i % APPS.cols === 0) {
                row = new St.BoxLayout({style_class: 'sp-apps-row'});
                this._gridBox.add_child(row);
            }
            const t = this._makeTile(a.app);
            row.add_child(t);
            tiles.push(t);
        });
        if (!list.length) {
            const empty = new St.Label({text: 'No Apps', style_class: 'sp-empty'});
            this._gridBox.add_child(empty);
        }
        this._visible = tiles;
        this._select(tiles.length ? 0 : -1, false);
        if (ripple)
            this._ripple(tiles);
    }

    _select(i, scroll = true) {
        if (this._selected >= 0)
            this._visible[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = i;
        const t = this._visible[i];
        if (!t)
            return;
        t.add_style_pseudo_class('selected');
        if (scroll && this._gridBox.contains(t)) {
            const adj = this._scroll.get_vadjustment?.() ?? this._scroll.vadjustment;
            const rowY = t.get_parent().y;
            if (adj) {
                if (rowY < adj.value)
                    adj.value = rowY;
                else if (rowY + APPS.tileH > adj.value + adj.page_size)
                    adj.value = rowY + APPS.tileH - adj.page_size;
            }
        }
    }

    // icons fade in (fade role) and grow in (bead), later the farther they are from where the view was opened (a spill delay
    // per px, as the lab's Dock stack); reduced motion: they are there at once
    _ripple(tiles) {
        this._rippleTicker?.stop();
        if (motionMode() !== 'full')
            return;
        const R = APPS.ripple;
        // positions are known only after the first allocation: use the layout grid instead
        const ox = this._origin ? this._origin.x : null;
        const oy = this._origin ? this._origin.y : null;
        const [ax, ay] = this.actor.get_transformed_position();
        const items = tiles.map((t, i) => {
            const inSuggest = this._suggestBox.contains(t);
            const gi = inSuggest ? i : i - this._suggestBox.get_n_children();
            const col = gi % APPS.cols;
            const row = Math.floor(gi / APPS.cols) + (inSuggest ? 0 : 1);
            const cx = ax + col * APPS.tileW + APPS.tileW / 2;
            const cy = ay + APPS.chipsH + row * APPS.tileH + APPS.tileH / 2;
            const d = ox === null ? Math.hypot(col - (APPS.cols - 1) / 2, row) * APPS.tileW : Math.hypot(cx - ox, cy - oy);
            t.remove_all_transitions();
            t.opacity = 0;
            t.set_scale(R.fromScale, R.fromScale);
            return {t, wait: Math.min(R.maxDelay, d * R.msPerPx) / 1000, op: new Fade(0, role('fade'), EPS_OPACITY),
                s: new Spring(R.fromScale, role('bead'), 1e-4), alive: true};
        });
        for (const it of items)
            it.t.connectObject('destroy', () => (it.alive = false), it);
        const ticker = new Ticker(dt => {
            let more = false;
            for (const it of items) {
                if (!it.alive)
                    continue;
                if (it.wait > 0) {
                    it.wait -= dt;
                    if (it.wait > 0) {
                        more = true;
                        continue;
                    }
                    it.op.set(1);
                    it.s.set(1);
                }
                it.t.opacity = Math.round(255 * it.op.step(dt));
                const sc = it.s.step(dt);
                it.t.set_scale(sc, sc);
                if (!it.op.rest || !it.s.rest)
                    more = true;
            }
            if (!more) {
                for (const it of items) {
                    if (it.alive)
                        it.t.disconnectObject(it);
                }
            }
            return more;
        });
        this._rippleTicker = ticker;
        ticker.start();
    }
}

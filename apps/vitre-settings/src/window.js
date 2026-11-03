import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {PageContext} from './pages/context.js';
import {PAGES} from './pages/index.js';

const REBUILD_DELAY_MS = 300;

export const VitreSettingsWindow = GObject.registerClass(
class VitreSettingsWindow extends Adw.ApplicationWindow {
    constructor({application, registry, extensions}) {
        super({
            application,
            title: 'Vitre Settings',
            default_width: 880,
            default_height: 660,
            width_request: 360,
            height_request: 360,
        });
        this.registry = registry;
        this.extensions = extensions;
        this._ctx = null;
        this._built = [];          // [{module, page, row}]
        this._rebuildId = 0;

        // ---- sidebar ----
        this._list = new Gtk.ListBox({css_classes: ['navigation-sidebar']});
        this._list.connect('row-activated', (_l, row) => this.showPage(row._pageId));
        const sideHeader = new Adw.HeaderBar();
        const sideView = new Adw.ToolbarView({content: new Gtk.ScrolledWindow({
            child: this._list, hscrollbar_policy: Gtk.PolicyType.NEVER,
        })});
        sideView.add_top_bar(sideHeader);
        this._sidebar = new Adw.NavigationPage({title: 'Vitre Settings', tag: 'sidebar', child: sideView});

        // ---- content ----
        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 120,
            hhomogeneous: false, vhomogeneous: false,
        });
        const contentView = new Adw.ToolbarView({content: this._stack});
        contentView.add_top_bar(new Adw.HeaderBar());
        this._content = new Adw.NavigationPage({title: '', tag: 'content', child: contentView});

        this._split = new Adw.NavigationSplitView({
            sidebar: this._sidebar, content: this._content,
            min_sidebar_width: 250, max_sidebar_width: 290, sidebar_width_fraction: 0.3,
        });
        this._toasts = new Adw.ToastOverlay({child: this._split});
        this.content = this._toasts;

        const narrow = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 600sp')});
        narrow.add_setter(this._split, 'collapsed', true);
        this.add_breakpoint(narrow);

        this.build();
        this.extensions.watch(() => this._queueRebuild());
        this.connect('close-request', () => {
            this.extensions.unwatch();
            this._ctx?.dispose();
            return false;
        });
    }

    get pageIds() {
        return this._built.map(b => b.module.id);
    }

    get currentPage() {
        return this._stack.visible_child_name;
    }

    build() {
        const keep = this._stack.visible_child_name;
        this._ctx?.dispose();
        for (const b of this._built) {
            this._stack.remove(b.page);
            this._list.remove(b.row);
        }
        this._built = [];
        this.registry.reset();

        this._ctx = new PageContext({registry: this.registry, extensions: this.extensions, window: this, app: this.application});
        for (const module of PAGES) {
            let page = null;
            try {
                page = module.build(this._ctx);
            } catch (e) {
                logError(e, `vitre-settings: the ${module.id} page failed to build`);
            }
            if (!page)
                continue;
            this._stack.add_named(page, module.id);
            const row = this._sidebarRow(module);
            this._list.append(row);
            this._built.push({module, page, row});
        }
        const first = this._built.find(b => b.module.id === keep) ?? this._built[0];
        if (first)
            this.showPage(first.module.id, false);
    }

    _sidebarRow(module) {
        const box = new Gtk.Box({spacing: 12, margin_top: 2, margin_bottom: 2});
        box.append(new Gtk.Image({icon_name: module.icon}));
        box.append(new Gtk.Label({label: module.title, xalign: 0, hexpand: true}));
        const row = new Gtk.ListBoxRow({child: box});
        row._pageId = module.id;
        row.update_property([Gtk.AccessibleProperty.LABEL], [module.title]);
        return row;
    }

    showPage(id, reveal = true) {
        const entry = this._built.find(b => b.module.id === id);
        if (!entry)
            return false;
        this._stack.visible_child_name = id;
        this._content.title = entry.module.title;
        this._list.select_row(entry.row);
        if (reveal)
            this._split.show_content = true;
        return true;
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBUILD_DELAY_MS, () => {
            this._rebuildId = 0;
            this.extensions.load();
            this.build();
            return GLib.SOURCE_REMOVE;
        });
    }

    toast(title) {
        this._toasts.add_toast(new Adw.Toast({title, timeout: 3}));
    }
});

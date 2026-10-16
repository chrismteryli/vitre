import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider, QuickToggle, QuickMenuToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {UndoJournal, GEO, roleOfItem, kindOfRole, menuOrigin} from './helpers.js';
import {GlassLayer} from './glass.js';
import {CCLayout} from './layout.js';
import {LiquidGlassQuickSettingsBridge} from './liquidGlassBridge.js';
import {installMenuMotion} from './motion.js';
import {DripController} from './liquidDrip.js';
import {DripStyle} from './dripStyle.js';
import {CCDripAdapter} from './ccDrip.js';
import {NowPlayingTile} from './nowPlaying.js';
import {buildSliderTile} from './sliderTile.js';
import {SliderFeedback, PillFeedback, ToggleFeedback, ModulePress, ButtonFeedback} from './ccFeedback.js';

function requireCondition(condition) {
    if (!condition)
        throw new Error('Control Center requires the verified GNOME 51 Quick Settings structure');
}

const GLASS_RADIUS = {
    circle: GEO.circleRadius, pill: GEO.circleRadius, tile: GEO.tileRadius,
    slider: GEO.sliderRadius, wide: GEO.sliderRadius,
};

/* Validate every private dependency before changing anything. */
function inspectNativeMenu() {
    const qs = Main.panel.statusArea.quickSettings;
    const menu = qs?.menu;
    const pointer = menu?._boxPointer;
    const grid = menu?._grid;
    const layout = grid?.layout_manager;
    const system = qs?._system?.quickSettingsItems?.[0];
    requireCondition(qs && menu && pointer && grid && layout && system);
    requireCondition(typeof pointer._reposition === 'function' && typeof pointer.open === 'function' &&
        typeof pointer.close === 'function' && pointer._muteInput && pointer._muteKeys);
    requireCondition(typeof menu.addItem === 'function' && typeof menu.close === 'function');
    requireCondition(layout._overlay instanceof Clutter.Actor && typeof layout.nColumns === 'number');
    requireCondition(qs._backgroundApps && qs._powerProfiles && qs._volumeOutput);
    return {qs, menu, pointer, grid, layout, system, box: menu.box};
}

export default class ControlCenter extends Extension {
    enable() {
        this._enabled = true;
        this._active = false;
        this._pending = new Set();
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncSession());
        try {
            this._syncSession();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._enabled = false;
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = 0;
        }
        this._deactivate();
    }

    _syncSession() {
        if (!this._enabled)
            return;
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
            this._deactivate();
            return;
        }
        if (!this._active && !this._waiting) {
            this._waiting = true;
            this._whenReady(() => {
                this._waiting = false;
                if (this._enabled && !this._active)
                    this._activate();
            });
        }
    }

    // Quick Settings builds its indicators asynchronously at startup.
    _whenReady(callback, tries = 0) {
        const qs = Main.panel.statusArea.quickSettings;
        if (qs?._backgroundApps && qs._powerProfiles && qs._volumeOutput && qs._system) {
            callback();
            return;
        }
        if (tries > 80) {
            this._waiting = false;
            throw new Error('Control Center: Quick Settings did not finish loading');
        }
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._pending.delete(id);
            if (this._enabled && !this._active)
                this._whenReady(callback, tries + 1);
            else
                this._waiting = false;
            return GLib.SOURCE_REMOVE;
        });
        this._pending.add(id);
    }

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._journal.add(() => object.disconnect(id));
        return id;
    }

    _class(actor, name) {
        if (actor.has_style_class_name(name))
            return;
        actor.add_style_class_name(name);
        this._journal.add(() => actor.remove_style_class_name(name));
    }

    _activate() {
        const native = inspectNativeMenu();
        this._native = native;
        this._journal = new UndoJournal();
        this._mods = new Map();      // item -> {id, role, kind, layer}
        this._fb = new Map();        // item -> hover / click feedback objects (A13)
        this._nextId = 1;
        // A17: liquid drip (drip-style liquid | classic, read from the liquid-menus schema; liquid if it is absent)
        this._dripStyle = new DripStyle();
        this._dripAdapter = new CCDripAdapter(this);
        this._drip = {style: this._dripStyle, controller: new DripController('cc', this._dripAdapter, {prewarm: 24, prewarmIf: () => this._dripStyle?.liquid})};
        this._bridge = new LiquidGlassQuickSettingsBridge({onError: () => {
            this._deactivate();
            console.error('Control Center restored Quick Settings after a Liquid Glass lifecycle mismatch');
        }});
        const {menu, grid, pointer, box, qs, layout: originalLayout, system} = native;
        try {
            this._bridge.enable();
            menu.close({animate: false});
            for (const actor of [pointer, box]) {
                for (const [key, value] of [['scale_x', 1], ['scale_y', 1],
                    ['translation_x', 0], ['translation_y', 0], ['opacity', 255]])
                    this._journal.property(actor, key, value);
            }
            this._class(qs.menu.actor, 'cc-menu');
            this._class(pointer, 'cc-pointer');
            this._journal.property(pointer, '_dripOwned', true);   // A17: Liquid Menus leaves this menu to us
            this._journal.property(qs.menu.actor, '_dripOwned', true);   // (the Quick Settings menu's actor is not its BoxPointer)
            this._class(box, 'cc-box');
            this._class(grid, 'cc-grid');
            this._class(qs, 'cc-button');

            // GNOME's system row (battery, screenshot, settings, lock, power) is not part of
            // the reference design Control Center. Screenshot becomes a circle; the rest is hidden.
            const screenshot = system.child?.get_children().find(c => c.constructor.name === 'ScreenshotItem');
            if (screenshot)
                this._journal.move(screenshot, grid);
            this._hide(system);

            // Layout: ours replaces QuickSettingsLayout; its column spans are carried over
            // and written back to the original on disable.
            const overlay = originalLayout._overlay;
            const hooks = {
                entries: container => this._entries(container),
                layerOf: actor => this._mods.get(actor)?.layer ?? null,
            };
            this._layout = new CCLayout(overlay, hooks);
            const spans = new Map();
            for (const child of grid.get_children()) {
                try {
                    spans.set(child, originalLayout.get_child_meta(grid, child).columnSpan);
                } catch {
                    // placeholder or non-managed child
                }
            }
            this._journal.add(() => {
                grid.layout_manager = originalLayout;
                for (const child of grid.get_children()) {
                    const span = this._ccSpans?.get(child);
                    if (span)
                        originalLayout.child_set_property(grid, child, 'column-span', span);
                }
                grid.queue_relayout();
            });
            this._ccSpans = spans;
            grid.layout_manager = this._layout;
            for (const [child, span] of spans)
                this._layout.child_set_property(grid, child, 'column-span', span);

            // Now Playing tile (2x2) from GNOME's own MPRIS source.
            const tile = new NowPlayingTile();
            this._journal.add(() => tile.destroyTile());
            grid.add_child(tile);
            this._register(tile, 'nowplaying', 'tile');
            // A13: press response on the transport buttons
            for (const button of [tile._prev, tile._play, tile._next])
                this._feedback(tile, () => new ButtonFeedback(button, this._journal), `np-${button.style_class}`);

            this._active = true;
            for (const child of [...grid.get_children()])
                this._adopt(child);
            grid.connectObject('destroy', () => { this._shutdown = true; }, this);
            this._journal.add(() => grid.disconnectObject(this));
            this._connect(grid, 'child-added', (_g, child) => this._adopt(child));
            this._connect(grid, 'child-removed', (_g, child) => this._drop(child));

            // Position: grid's right edge 13 px from the monitor edge, 14 px under the bar.
            const adapter = this;
            this._journal.method(pointer, '_reposition', original => function (allocationBox) {
                original.call(this, allocationBox);
                if (!adapter._active)
                    return;
                adapter._dripAdapter.allocCount++;
                const area = this._workArea;
                if (!area)
                    return;
                const target = menuOrigin(area, allocationBox.get_width());
                // The Quick Settings menu actor is 0 x 0, which cannot be inverted: walk up
                // to the first ancestor that can (as BoxPointer._reposition does).
                let parent = this.get_parent();
                let success = false;
                let x = 0;
                let y = 0;
                while (!success && parent) {
                    [success, x, y] = parent.transform_stage_point(target.x, target.y);
                    parent = parent.get_parent();
                }
                if (success)
                    allocationBox.set_origin(Math.floor(x), Math.floor(y));
            });
            installMenuMotion(pointer, this._journal, () => this._active, this._drip);
            this._connect(menu, 'open-state-changed', (_menu, open) => {
                if (open)
                    grid.queue_relayout();
                else
                    this._resetFeedback();
            });
            this._active = true;
            grid.queue_relayout();
        } catch (error) {
            this._deactivate();
            throw error;
        }
    }

    _hide(actor) {
        const was = actor.visible;
        const id = actor.connect('notify::visible', () => {
            if (this._active && actor.visible)
                actor.visible = false;
        });
        this._journal.add(() => {
            actor.disconnect(id);
            actor.visible = was;
        });
        actor.visible = false;
    }

    // Everything the grid asks for: the visible, classified modules in GNOME's order.
    _entries(container) {
        const out = [];
        for (const child of container.get_children()) {
            const mod = this._mods.get(child);
            if (!mod || !child.visible || mod.role === 'system')
                continue;
            out.push({id: mod.id, actor: child, role: mod.role, kind: mod.kind});
        }
        return out;
    }

    _register(item, role, kind) {
        const id = this._nextId++;
        const mod = {id, role, kind, layer: null};
        this._mods.set(item, mod);
        this._class(item, 'cc-module');
        this._class(item, `cc-${kind}`);
        this._class(item, `cc-role-${role}`);
        const syncVisible = () => {
            if (mod.layer)
                mod.layer.actor.visible = item.visible && role !== 'system';
            this._native.grid.queue_relayout();
        };
        item.connectObject('notify::visible', syncVisible, this);
        this._journal.add(() => item.disconnectObject(this));
        if (role !== 'system') {
            mod.layer = new GlassLayer({radius: GLASS_RADIUS[kind] ?? GEO.circleRadius});
            this._native.grid.insert_child_at_index(mod.layer.actor, 0);
            this._journal.add(() => mod.layer.destroy());
            mod.layer.actor.visible = item.visible;
        }
        return mod;
    }

    _adopt(child) {
        if (!this._active || this._mods.has(child) || child === this._native.layout._overlay ||
            child === this._layout._overlay || child.name === 'cc-glass-layer')
            return;
        // the placeholder that follows the submenu overlay is a plain Clutter.Actor
        if (!(child instanceof St.Widget) && !child.get_n_children?.())
            return;
        const isSlider = child instanceof QuickSlider;
        const isToggle = child instanceof QuickToggle || child instanceof QuickMenuToggle;
        const title = child.title ?? child._title?.text ?? '';
        let role = roleOfItem({className: child.constructor.name, title, hasMenu: Boolean(child.menu)});
        if (role === 'extra' || role === 'extra-menu') {
            if (isSlider)
                role = 'extra-slider';
            else if (!isToggle && child.constructor.name !== 'ScreenshotItem')
                role = 'extra-wide';
        }
        const kind = kindOfRole(role, isSlider);
        const mod = this._register(child, role, kind);
        this._style(child, mod);
        this._native.grid.queue_relayout();
    }

    _drop(child) {
        if (this._shutdown || !this._mods)
            return;
        const mod = this._mods.get(child);
        if (!mod)
            return;
        child.disconnectObject(this);
        mod.layer?.destroy();
        this._mods.delete(child);
        this._native.grid.queue_relayout();
    }

    // A13: the menu has closed (after its fade): every hover / press state back to rest, no animation.
    _resetFeedback() {
        for (const [item, list] of this._fb ?? []) {
            // a module that was dropped (destroyed: a device went away) has nothing to reset; touching it only logs 'already disposed'
            if (!this._mods?.has(item))
                continue;
            for (const fb of list.values())
                fb.reset?.();
        }
    }

    // A13: build one feedback object; a failure here must never take Control Center down.
    _feedback(item, build, key) {
        try {
            const fb = build();
            let list = this._fb.get(item);
            if (!list) {
                list = new Map();
                this._fb.set(item, list);
            }
            list.set(key, fb);
            return fb;
        } catch (error) {
            console.error(`Control Center feedback (${key}) skipped: ${error.message}`);
            return null;
        }
    }

    _style(item, mod) {
        const j = this._journal;
        const {role, kind} = mod;
        if (kind === 'slider' && item instanceof QuickSlider) {
            let parts = null;
            if (role === 'display' || role === 'sound' || role === 'mic')
                parts = buildSliderTile(item, role, j);
            if (role === 'sound' && item._menuButton?.child) // the reference: the output picker is a round button
                j.property(item._menuButton.child, 'icon_name', 'audio-speakers-symbolic');
            if (parts)
                this._feedback(item, () => new SliderFeedback(item, parts.row, j), 'slider');
            if (role === 'sound' && item._menuButton)
                this._feedback(item, () => new ButtonFeedback(item._menuButton, j), 'round');
            // the reference's Display tile has no round button; right-click / long-press still opens GNOME's
            // per-monitor menu (QuickSlider opens it from the slider's popup-menu signal).
            if (role === 'display' && item._menuButton)
                this._hide(item._menuButton);
            return;
        }
        if (!(item instanceof QuickToggle) && !(item instanceof QuickMenuToggle)) {
            // the Screenshot circle: a plain button, press response only
            if (kind === 'circle' && mod.layer)
                this._feedback(item, () => new ModulePress(item, mod.layer, item, j), 'press');
            return;
        }
        const contents = item instanceof QuickMenuToggle ? item._box.get_first_child() : item;
        const icon = contents._icon;
        if (icon) {
            j.property(icon, 'y_align', Clutter.ActorAlign.CENTER);
            j.property(icon, 'x_align', Clutter.ActorAlign.CENTER);
        }
        if (role === 'focus') {
            j.property(item, 'title', 'Focus');
            j.property(item, 'iconName', 'weather-clear-night-symbolic');
        }
        if (kind === 'pill' && item instanceof QuickMenuToggle) {
            // the reference's pill: the disc is the toggle; the rest of the pill opens the submenu.
            // The submenu button is laid over the text area (fixed width in CSS), above the toggle.
            const box = item._box;
            const [contentsActor, separator, menuButton] = box.get_children();
            item._pillMenuButton = menuButton;
            j.add(() => { delete item._pillMenuButton; });
            const wrap = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
                style_class: 'cc-pill-wrap'});
            j.add(() => wrap.destroy());
            const saved = item.get_child();
            j.add(() => item.set_child(saved));
            item.set_child(wrap);
            j.move(contentsActor, wrap);
            j.move(separator, wrap);
            j.move(menuButton, wrap);
            j.property(menuButton, 'x_align', Clutter.ActorAlign.END);
            j.property(menuButton, 'x_expand', true);
            j.property(menuButton, 'y_expand', true);
            j.property(menuButton, 'y_align', Clutter.ActorAlign.FILL);
            menuButton.add_style_class_name('cc-pill-open');
            j.add(() => menuButton.remove_style_class_name('cc-pill-open'));
            // A13: ">" at the right end while the pointer is over the text area
            this._feedback(item, () => new PillFeedback(wrap, menuButton, j), 'chevron');
        }
        if (kind === 'circle') {
            const titleBox = contents._title?.get_parent();
            if (titleBox)
                j.property(titleBox, 'visible', false);
            if (icon) {
                j.property(icon, 'x_expand', true);
                j.property(icon, 'y_expand', true);
            }
            // a circle has no room for the submenu arrow; right-click / long-press opens the menu
            if (item instanceof QuickMenuToggle) {
                const [, separator, menuButton] = item._box.get_children();
                if (separator)
                    j.property(separator, 'visible', false);
                if (menuButton)
                    j.property(menuButton, 'visible', false);
            }
        }
        // A13: press response + on/off crossfade
        if (mod.layer && icon && (kind === 'circle' || kind === 'pill')) {
            const pressButton = contents;
            const menuButton = kind === 'pill' && item instanceof QuickMenuToggle ? item._pillMenuButton : null;
            this._feedback(item, () => new ToggleFeedback(item, mod.layer, {kind, pressButton, menuButton, icon}, j), 'toggle');
        }
    }

    _deactivate() {
        this._active = false;
        this._waiting = false;
        for (const id of this._pending ?? [])
            GLib.Source.remove(id);
        this._pending?.clear();
        const native = this._native;
        if (native) {
            try {
                native.menu.close({animate: false});
            } catch {
                // Continue returning surviving native actors during teardown.
            }
        }
        this._drip?.controller.destroy();
        this._dripAdapter?.destroy();
        this._dripStyle?.destroy();
        this._drip = null;
        this._dripStyle = null;
        this._dripAdapter = null;
        const failures = this._journal?.rollback() ?? 0;
        this._journal = null;
        this._mods?.clear();
        this._mods = null;
        this._fb = null;
        this._native = null;
        this._layout = null;
        this._ccSpans = null;
        this._bridge?.disable();
        this._bridge = null;
        if (failures)
            console.error(`Control Center cleanup encountered ${failures} unavailable native objects`);
    }
}

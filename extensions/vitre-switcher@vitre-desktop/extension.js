/* Switcher Glass (A7): the Super-Tab switcher of the reference design on GNOME's Super-Tab (app switcher) and Alt-Tab (window
 * switcher) popups. Everything is done by wrapping methods of GNOME's own classes at run time (InjectionManager)
 * and by restyling the popup's actors right after GNOME builds them; no GNOME file is edited and no GNOME method
 * body is copied.
 *
 *   timing  : the panel appears in one frame SHOW_DELAY_MS after the key press (Just Perfection's "remove the
 *             switcher delay" is overridden for these two popups only); a second Tab press shows it at once, as
 *             GNOME does. The dismissal is a 200 ms blur-fade on a Clutter.Timeline (absolute time, not scaled by
 *             the shell slow-down factor) that runs while the chosen window is already coming forward.
 *   layout  : layout.js (icon 1.0, pitch 1.30, padding 0.35, height 1.70, radius 0.32, plate 1.18).
 *   look    : glass.js, the A9 clear-glass recipe, as the first child of the panel; the plate of the selected
 *             item and the selected app's name under it.
 *   motion  : the highlight is a pseudo-class change (one frame); the list scroll that GNOME eases for very long
 *             lists is made instant too.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';

import {GlassLayer, MARGIN} from './glass.js';
import {computeMetrics} from './layout.js';
import {SHOW_DELAY_MS, FADE_MS, opacityAt, blurAt} from './motion.js';

const TAG = '[switcher-glass]';
const nowMs = () => GLib.get_monotonic_time() / 1000;
const scaleFactor = () => Math.max(1, St.ThemeContext.get_for_stage(global.stage).scale_factor);

function animationsOff() {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return true;
    try {
        // GNOME 51: St.ReducedMotion (REDUCE) when the accessibility setting asks for it
        return settings.reducedMotion === St.ReducedMotion?.REDUCE;
    } catch {
        return false;
    }
}

function removeSource(id) {
    if (id)
        GLib.source_remove(id);
    return 0;
}

// ---------------------------------------------------------------------------------------------------------
// show: one frame, SHOW_DELAY_MS after the key press

function reveal(popup) {
    const sg = popup._sg;
    sg.shown = true;
    sg.timer = removeSource(sg.timer);
    // GNOME's own 150 ms timer (and Just Perfection's immediate call) are replaced by ours
    popup._initialDelayTimeoutId = removeSource(popup._initialDelayTimeoutId);
    Main.osdWindowManager.hideAll();
    popup.opacity = 255;
    sg.revealedAt = nowMs();
}

function showImmediately(original) {
    return function (...args) {
        const sg = this._sg;
        if (!sg?.ok || sg.disposed)
            return original.apply(this, args);
        if (sg.shown)
            return undefined;
        const force = sg.forceShow;
        sg.forceShow = false;
        const left = SHOW_DELAY_MS - (nowMs() - sg.t0);
        if (force || left <= 0) {
            reveal(this);
            return undefined;
        }
        // Too early (Just Perfection calls this right after show(); GNOME's timer calls it at 150 ms):
        // drop GNOME's timer and wait for ours.
        this._initialDelayTimeoutId = removeSource(this._initialDelayTimeoutId);
        if (!sg.timer) {
            sg.timer = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, Math.max(1, Math.ceil(left)), () => {
                sg.timer = 0;
                if (sg.disposed || sg.shown)
                    return;
                reveal(this);
            });
            GLib.Source.set_name_by_id(sg.timer, '[switcher-glass] reveal');
        }
        return undefined;
    };
}

// a key press the popup acted on (second Tab, arrow, ...) shows it at once, as in GNOME
function keyPressHandler(original) {
    return function (...args) {
        const result = original.apply(this, args);
        if (this._sg?.ok && result !== Clutter.EVENT_PROPAGATE)
            this._sg.forceShow = true;
        return result;
    };
}

// ---------------------------------------------------------------------------------------------------------
// dismissal: ~200 ms blur-fade, in parallel with the window coming forward

function startFade(popup) {
    const sg = popup._sg;
    const list = popup._switcherList;
    sg.fading = true;
    sg.fadeStartedAt = nowMs();
    popup.reactive = false;
    sg.timer = removeSource(sg.timer);

    const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 1, brightness: 1.0});
    const target = list?._scrollView ?? list;
    target?.add_effect_with_name('sg-fade-blur', blur);

    const timeline = new Clutter.Timeline({actor: popup, duration: Math.round(FADE_MS)});
    sg.fade = {timeline, blur, target, frames: 0};
    const apply = ms => {
        popup.opacity = Math.round(255 * opacityAt(ms));
        blur.radius = Math.max(1, blurAt(ms));
    };
    apply(0);
    timeline.connect('new-frame', (_t, ms) => {
        sg.fade.frames++;
        apply(ms);
    });
    timeline.connect('completed', () => {
        popup.opacity = 0;
        popup.destroy();
    });
    timeline.start();
}

function fadeAndDestroy(original) {
    return function (...args) {
        const sg = this._sg;
        if (!sg?.ok || sg.disposed)
            return original.apply(this, args);
        if (sg.fading)
            return undefined;
        // never shown (a quick tap) or animations off: GNOME's own path destroys at once
        if (this.opacity === 0 || animationsOff()) {
            sg.timer = removeSource(sg.timer);
            return original.apply(this, args);
        }
        this._popModal();
        startFade(this);
        return undefined;
    };
}

// ---------------------------------------------------------------------------------------------------------
// panel: metrics, classes, glass

function scrollInstant(list, index, toRight) {
    const adjustment = list._scrollView.hadjustment;
    let [value, , upper, , , pageSize] = adjustment.get_values();
    const item = list._items[index];
    if (item.allocation.x1 < value)
        value = Math.max(0, item.allocation.x1);
    else if (item.allocation.x2 > value + pageSize)
        value = Math.min(upper, item.allocation.x2 - pageSize);
    if (toRight)
        list._scrollableLeft = true;
    else
        list._scrollableRight = true;
    adjustment.value = value;
    if (toRight && index === list._items.length - 1)
        list._scrollableRight = false;
    if (!toRight && index === 0)
        list._scrollableLeft = false;
    list.queue_relayout();
}

function installGlass(popup, list, radius, slot = 'glass') {
    const sg = popup._sg;
    const glass = new GlassLayer({radius});
    sg[slot] = glass;
    list.insert_child_at_index(glass.actor, 0);
    // The list's allocate vfunc only allocates its own children, so the layer is allocated here, from the
    // list's allocation change (grown by MARGIN on every side), and the clones are re-offset.
    const sync = () => {
        const b = list.get_allocation_box();
        const w = b.get_width();
        const h = b.get_height();
        if (!(w > 0 && h > 0))
            return;
        const box = new Clutter.ActorBox();
        box.x1 = -MARGIN;
        box.y1 = -MARGIN;
        box.x2 = w + MARGIN;
        box.y2 = h + MARGIN;
        glass.actor.allocate(box);
        const [px, py] = popup.get_transformed_position();
        glass.sync(w, h, (Number.isFinite(px) ? px : 0) + b.x1 - MARGIN, (Number.isFinite(py) ? py : 0) + b.y1 - MARGIN);
    };
    list.connectObject('notify::allocation', sync, popup);
    return glass;
}

function stylePanel(popup, list, m, css, kind) {
    list.set_style_class_name('sg-switcher-list');
    const bottom = kind === 'app' ? m.padBottomApp : m.padBottomWin;
    list.set_style(`padding: ${css(m.padTop)}px ${css(m.padX)}px ${css(bottom)}px ${css(m.padX)}px; ` +
        `border-radius: ${css(m.radius)}px;`);
    // the item container reads its spacing from the theme node on every style change
    list._list.set_style_class_name('sg-item-container');
    list._list.set_style(`spacing: ${css(m.gap)}px;`);
    list._list.spacing = css(m.gap);
}

function attachApp(popup, list, m, css) {
    list._iconSize = css(m.S);                    // skips GNOME's stock icon-size search
    list.icons.forEach(icon => icon.set_size(css(m.S)));
    list._items.forEach((item, i) => {
        item._square = false;                     // width = the plate, not the taller item
        item.set_style_class_name('sg-item');
        item.set_style('padding: 0px; margin: 0px;');
        const icon = list.icons[i];
        icon.set_style_class_name('sg-app');
        icon._iconBin.set_style_class_name('sg-plate');
        icon._iconBin.set_style(`padding: ${css(m.p)}px; border-radius: ${css(m.plateRadius)}px;`);
        icon.label.set_style_class_name('sg-label');
        icon.label.set_style(`font-size: ${css(m.fontPx)}px;`);
        icon.label.set_width(m.plate);
        icon.label.set_height(m.labelH);
        icon.label.opacity = 0;
    });
    list._arrows.forEach(arrow => (arrow.opacity = 0));   // the reference design has no multi-window arrows

    const highlight = list.highlight.bind(list);
    list.highlight = (n, justOutline) => {
        highlight(n, justOutline);
        list.icons.forEach((icon, i) => {
            const bin = icon._iconBin;
            icon.label.opacity = i === n ? 255 : 0;
            bin.remove_style_pseudo_class('selected');
            bin.remove_style_pseudo_class('highlighted');
            if (i === n)
                bin.add_style_pseudo_class(justOutline ? 'highlighted' : 'selected');
        });
    };
}

function attachWindow(popup, list, m, css) {
    for (const icon of list.icons) {
        const first = icon._icon.get_first_child();
        const mutterWindow = icon.window.get_compositor_private();
        if (first instanceof Clutter.Clone && mutterWindow) {
            const [w, h] = mutterWindow.get_size();
            const k = Math.min(1, m.S / w, m.S / h);
            first.set_size(w * k, h * k);
        } else if (first && 'icon_size' in first) {
            first.icon_size = css(m.S);
        }
        icon._icon.set_size(m.S, m.S);
    }
    list._items.forEach(item => {
        item.set_style_class_name('sg-item sg-plate');
        item.set_style(`padding: ${css(m.p)}px; margin: 0px; border-radius: ${css(m.plateRadius)}px;`);
    });
    list._label.set_style_class_name('sg-label');
    list._label.set_style(`font-size: ${css(m.fontPx)}px;`);
    list._label.set_height(m.labelH);
}

// the window strip that GNOME opens under the app list (Super-` / Down / a pause on an app with several windows)
function styleThumbnails(popup) {
    const sg = popup._sg;
    const thumbs = popup._thumbnails;
    if (!sg?.ok || !thumbs)
        return;
    const m = sg.metrics;
    const css = px => px / scaleFactor();
    const pad = Math.round(0.10 * m.S);
    const radius = Math.round(0.24 * m.S);
    thumbs.set_style_class_name('sg-switcher-list sg-thumbs');
    thumbs.set_style(`padding: ${css(pad)}px; border-radius: ${css(radius)}px;`);
    thumbs._list.set_style_class_name('sg-item-container');
    thumbs._list.set_style(`spacing: ${css(Math.round(0.06 * m.S))}px;`);
    thumbs._items.forEach(item => {
        item.set_style_class_name('sg-item sg-plate');
        item.set_style(`padding: ${css(Math.round(0.06 * m.S))}px; margin: 0px; border-radius: ${css(Math.round(0.12 * m.S))}px;`);
    });
    thumbs._labels.forEach(label => {
        label.set_style_class_name('sg-label');
        label.set_style(`font-size: ${css(Math.round(0.095 * m.S))}px;`);
    });
    thumbs._scrollToLeft = index => scrollInstant(thumbs, index, false);
    thumbs._scrollToRight = index => scrollInstant(thumbs, index, true);
    installGlass(popup, thumbs, radius, 'thumbGlass');
}

function attach(popup, kind, t0) {
    const sg = {t0, kind, ok: false, shown: false, fading: false, disposed: false, timer: 0, forceShow: false,
        glass: null, fade: null};
    popup._sg = sg;
    const list = popup._switcherList;
    const monitor = Main.layoutManager.primaryMonitor;
    const scale = scaleFactor();
    const css = px => px / scale;
    const m = computeMetrics({count: list.icons.length, monitorWidth: monitor.width});
    sg.metrics = m;

    popup.add_style_class_name('sg-switcher-popup');
    stylePanel(popup, list, m, css, kind);
    if (kind === 'app')
        attachApp(popup, list, m, css);
    else
        attachWindow(popup, list, m, css);
    list._scrollToLeft = index => scrollInstant(list, index, false);
    list._scrollToRight = index => scrollInstant(list, index, true);
    installGlass(popup, list, m.radius);

    popup.connect('destroy', () => {
        sg.disposed = true;
        sg.timer = removeSource(sg.timer);
        if (sg.fade) {
            sg.fade.timeline.stop();
            sg.fade = null;
        }
    });
    sg.ok = true;
}

// ---------------------------------------------------------------------------------------------------------

// One invisible paint of everything the switcher draws (glass shader, actor blur, opacity flatten) shortly after
// the extension loads, so the first real Alt-Tab does not pay the one-time shader/offscreen setup (measured
// ~12 ms on the first reveal frame in the rig) inside the one frame that has to appear on time.
function warmUp() {
    const holder = new St.Widget({name: 'sg-warmup', width: 96, height: 96, opacity: 1, reactive: false});
    Shell.util_set_hidden_from_pick(holder, true);
    const glass = new GlassLayer({radius: 24});
    glass.actor.set_position(-MARGIN, -MARGIN);
    glass.actor.set_size(96 + 2 * MARGIN, 96 + 2 * MARGIN);
    holder.add_child(glass.actor);
    const probe = new St.Widget({width: 40, height: 40, x: 20, y: 20, style: 'background-color: white;'});
    probe.add_effect_with_name('sg-warm-blur', new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 4, brightness: 1.0}));
    holder.add_child(probe);
    Main.uiGroup.add_child(holder);
    glass.sync(96, 96, 0 - MARGIN, 0 - MARGIN);
    return holder;
}

export default class SwitcherGlass extends Extension {
    enable() {
        this._injections = new InjectionManager();
        const inj = this._injections;
        const base = SwitcherPopup.SwitcherPopup.prototype;

        for (const [kind, cls] of [['app', AltTab.AppSwitcherPopup], ['window', AltTab.WindowSwitcherPopup]]) {
            inj.overrideMethod(cls.prototype, '_init', original => function (...args) {
                const t0 = nowMs();
                original.apply(this, args);
                try {
                    attach(this, kind, t0);
                } catch (e) {
                    console.error(`${TAG} could not restyle the ${kind} switcher, using GNOME's: ${e.stack ?? e}`);
                    if (this._sg)
                        this._sg.ok = false;
                }
            });
            inj.overrideMethod(cls.prototype, '_keyPressHandler', keyPressHandler);
        }
        inj.overrideMethod(AltTab.AppSwitcherPopup.prototype, '_createThumbnails', original => function (...args) {
            original.apply(this, args);
            try {
                styleThumbnails(this);
            } catch (e) {
                console.error(`${TAG} could not restyle the window strip: ${e.stack ?? e}`);
            }
        });
        inj.overrideMethod(base, '_showImmediately', showImmediately);
        inj.overrideMethod(base, 'fadeAndDestroy', fadeAndDestroy);
        this._warmId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._warmId = 0;
            try {
                this._warm = warmUp();
            } catch (e) {
                console.error(`${TAG} warm-up skipped: ${e.message}`);
                return;
            }
            this._warmId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, 250, () => {
                this._warmId = 0;
                this._warm?.destroy();
                this._warm = null;
            });
        });
        console.log(`${TAG} enabled`);
    }

    disable() {
        this._warmId = removeSource(this._warmId);
        this._warm?.destroy();
        this._warm = null;
        this._injections?.clear();
        this._injections = null;
        console.log(`${TAG} disabled`);
    }
}

/* Control Center hover and click feedback (plan A13). Constants live in feedback.js.
 *
 *  - SliderFeedback : slider tile (Display, Sound): hover shows a round white knob at the end of the fill
 *                     and a ">" at the top-right of the tile; press morphs the knob into a clear glass
 *                     capsule (lens) through which the track shows; it follows the pointer; release morphs back.
 *  - PillFeedback   : pill text area (the part that opens the submenu) shows a ">" at the pill's right end.
 *  - ToggleFeedback : circles and pill discs: press response (scale + brighten), on/off crossfade of the
 *                     disc fill and the glyph colour.
 *  - ButtonFeedback : small round buttons (Now Playing transport, Sound output button): press response.
 * Every actor added here is registered with the extension's UndoJournal and removed on disable. */
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {FB, Tween, PressResponse, bindPress, centrePivot, setScale, pressGrow, lerp, lerpColor, cssRgba, animationsOn} from './feedback.js';
import {GlassLayer, MARGIN} from './glass.js';

const WHITE = {red: 255, green: 255, blue: 255, alpha: 255};

export const CCChevron = GObject.registerClass(
class CCChevron extends St.DrawingArea {
    _init() {
        const s = FB.chevronStroke;
        super._init({
            style_class: 'cc-fb-chevron', reactive: false,
            width: Math.ceil(FB.chevronWidth + s), height: Math.ceil(FB.chevronHeight + s),
        });
        this.connect('repaint', () => this._draw());
    }

    _draw() {
        const [w, h] = this.get_surface_size();
        const cr = this.get_context();
        const s = FB.chevronStroke;
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(s);
        cr.setLineCap(1);
        cr.setLineJoin(1);
        cr.moveTo(s / 2 + 0.5, s / 2);
        cr.lineTo(w - s / 2 - 0.5, h / 2);
        cr.lineTo(s / 2 + 0.5, h - s / 2);
        cr.stroke();
        cr.$dispose();
    }
});

function makeChevron(opacity = 0) {
    const chevron = new CCChevron();
    chevron.opacity = opacity;
    chevron.visible = opacity > 0;
    return chevron;
}

const fade = (actor, v) => {
    actor.opacity = Math.round(255 * v);
    actor.visible = v > 0;
};

/* ---- slider tile ---------------------------------------------------------------------------- */
export class SliderFeedback {
    // item: QuickSlider already rebuilt by buildSliderTile; row: its 'cc-slider-row' box
    constructor(item, row, journal) {
        this.kind = 'slider';
        this._item = item;
        this._slider = item.slider;
        this._row = row;
        this._dragging = false;
        const j = journal;
        const column = item.get_child();
        const wrap = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
            style_class: 'cc-slider-wrap'});
        j.add(() => wrap.destroy());
        j.add(() => {
            wrap.remove_child(column);
            item.set_child(column);
        });
        item.set_child(wrap);
        wrap.add_child(column);
        this._wrap = wrap;

        this._overlay = new Clutter.Actor({name: 'cc-fb-overlay', reactive: false, x_expand: true, y_expand: true});
        wrap.add_child(this._overlay);
        this.knob = new St.Widget({name: 'cc-fb-knob', style_class: 'cc-fb-knob', reactive: false, opacity: 0, visible: false});
        this._overlay.add_child(this.knob);
        this.lens = new GlassLayer({radius: 6, blurRadius: FB.lensBlurRadius, brightness: FB.lensBrightness,
            finish: FB.lensFinish});
        this.lens.actor.name = 'cc-fb-lens';
        this.lens.actor.opacity = 0;
        this.lens.actor.visible = false;
        this.lens.addSource(row);
        this._overlay.add_child(this.lens.actor);

        // ">" at the tile's top-right corner; a button when the tile has a menu (Sound: output picker)
        this.chevron = makeChevron(255);
        this._chevronButton = new St.Button({
            style_class: 'cc-fb-chevron-button', child: this.chevron, reactive: false, can_focus: false,
            style: `padding: 0; margin: ${Math.round(FB.tileChevronCenterY - (FB.chevronHeight + FB.chevronStroke) / 2)}px ${FB.tileChevronRight}px 0 0; min-width: 0; min-height: 0; background-color: transparent; border: none; box-shadow: none;`,
        });
        // BinLayout only honours x_align / y_align of an actor that also expands
        this._chevronButton.x_expand = true;
        this._chevronButton.y_expand = true;
        this._chevronButton.x_align = Clutter.ActorAlign.END;
        this._chevronButton.y_align = Clutter.ActorAlign.START;
        this._chevronButton.opacity = 0;
        this._chevronButton.visible = false;
        this._chevronButton.connect('clicked', () => {
            if (item.menuEnabled)
                item.menu.open();
        });
        wrap.add_child(this._chevronButton);
        const syncReactive = () => {
            this._chevronButton.reactive = Boolean(item.menuEnabled);
        };
        item.connectObject('notify::menu-enabled', syncReactive, this);
        syncReactive();

        this._hov = new Tween(item, () => this._apply(), 0, `hover:${item.constructor.name}`);
        this._morph = new Tween(item, () => this._apply(), 0, `morph:${item.constructor.name}`);

        // the item itself must track the pointer: QuickSlider is created non-reactive
        j.property(item, 'reactive', true);
        j.property(item, 'track_hover', true);
        item.connectObject('notify::hover', () => this._syncHover(), this);
        this._slider.connectObject(
            'drag-begin', () => this._onDrag(true),
            'drag-end', () => this._onDrag(false),
            'notify::value', () => this._apply(),
            'notify::allocation', () => this._apply(), this);
        j.add(() => this.destroy());
    }

    _syncHover() {
        const on = this._item.hover || this._dragging;
        this._hov.to(on ? 1 : 0, on ? FB.hoverInMs : FB.hoverOutMs, 'linear');
    }

    _onDrag(on) {
        this._dragging = on;
        this._morph.to(on ? 1 : 0, FB.morphMs, 'easeOut');
        this._syncHover();
    }

    // Menu closed: back to rest without animating (a hidden actor's timeline would stall mid-way).
    reset() {
        this._dragging = false;
        this._hov.set(0);
        this._morph.set(0);
    }

    // Test hook (rig only): hold the morph at a given progress without timing.
    debugSet(hover, morph) {
        this._hov.set(hover);
        this._morph.set(morph);
    }

    // Where the knob centre sits: the end of the fill, in overlay coordinates.
    valuePosition() {
        const sl = this._slider;
        const [sx, sy] = sl.get_transformed_position();
        const [ox, oy] = this._overlay.get_transformed_position();
        if (![sx, sy, ox, oy].every(Number.isFinite))
            return null;
        const box = sl.get_allocation_box();
        const width = box.get_width();
        const barH = sl._barLevelHeight || 4;
        const br = Math.min(width, barH) / 2;
        const frac = sl.maximumValue > 0 ? sl.value / sl.maximumValue : 0;
        return {x: sx - ox + br + (width - 2 * br) * frac, y: sy - oy + box.get_height() / 2, ox, oy};
    }

    _apply() {
        const hov = this._hov.value;
        const m = this._morph.value;
        fade(this._chevronButton, hov);
        if (hov <= 0 && m <= 0) {
            this.knob.opacity = 0;
            this.knob.visible = false;
            this.lens.actor.opacity = 0;
            this.lens.actor.visible = false;
            return;
        }
        const pos = this.valuePosition();
        const d = FB.knobDiameter;
        const lw = d * FB.lensWidthRatio;
        const lh = d * FB.lensHeightRatio;
        const w = Math.round(lerp(d, lw, m));
        const h = Math.round(lerp(d, lh, m));
        if (pos) {
            const x = Math.round(pos.x - w / 2);
            const y = Math.round(pos.y - h / 2);
            this.knob.set_position(x, y);
            this.knob.set_size(w, h);
            this.lens.actor.set_position(x - MARGIN, y - MARGIN);
            this.lens.actor.set_size(w + 2 * MARGIN, h + 2 * MARGIN);
            this.lens.radius = Math.min(w, h) / 2;
            this.lens.sync(w, h, pos.ox + x - MARGIN, pos.oy + y - MARGIN);
        }
        fade(this.knob, hov * (1 - m));
        fade(this.lens.actor, hov * m);
    }

    // For the rig: the live geometry of the knob/lens/chevron.
    snapshot() {
        const pos = this.valuePosition();
        const r = a => {
            const [x, y] = a.get_transformed_position();
            const [w, h] = a.get_transformed_size();
            return {x, y, w, h};
        };
        return {
            hover: this._hov.value, morph: this._morph.value, dragging: this._dragging, itemHover: this._item.hover,
            knob: {...r(this.knob), op: this.knob.opacity, vis: this.knob.visible},
            lens: {...r(this.lens.actor), op: this.lens.actor.opacity, vis: this.lens.actor.visible},
            chevron: {...r(this._chevronButton), op: this._chevronButton.opacity, vis: this._chevronButton.visible,
                reactive: this._chevronButton.reactive},
            value: this._slider.value,
            valuePos: pos ? {x: pos.ox + pos.x, y: pos.oy + pos.y} : null,
        };
    }

    destroy() {
        this._hov.destroy();
        this._morph.destroy();
        this._item.disconnectObject(this);
        this._slider.disconnectObject(this);
        this.lens.destroy();
    }
}

/* ---- pill: ">" over the text area -------------------------------------------------------------- */
export class PillFeedback {
    // wrap: the pill's BinLayout wrapper; menuButton: the invisible button over the text area
    constructor(wrap, menuButton, journal) {
        this.kind = 'pill';
        this._menuButton = menuButton;
        this.chevron = makeChevron();
        this.chevron.x_expand = true;
        this.chevron.y_expand = true;
        this.chevron.x_align = Clutter.ActorAlign.END;
        this.chevron.y_align = Clutter.ActorAlign.CENTER;
        this.chevron.set_style(`margin: 0 ${FB.pillChevronRight}px 0 0;`);
        wrap.add_child(this.chevron);
        this._tween = new Tween(menuButton, v => fade(this.chevron, v), 0, 'pillchevron');
        menuButton.connectObject('notify::hover', () => {
            const on = menuButton.hover;
            this._tween.to(on ? 1 : 0, on ? FB.pillChevronInMs : FB.pillChevronOutMs, 'linear');
        }, this);
        journal.add(() => this.destroy());
        journal.add(() => this.chevron.destroy());
    }

    reset() {
        this._tween.set(0);
    }

    snapshot() {
        const [x, y] = this.chevron.get_transformed_position();
        const [w, h] = this.chevron.get_transformed_size();
        return {hover: this._menuButton.hover, value: this._tween.value, op: this.chevron.opacity, vis: this.chevron.visible,
            x, y, w, h};
    }

    destroy() {
        this._tween.destroy();
        this._menuButton.disconnectObject(this);
    }
}

/* ---- toggles: circles and pill discs ---------------------------------------------------------- */
function themeColor(actor) {
    try {
        const c = actor.get_theme_node().get_foreground_color();
        return {red: c.red, green: c.green, blue: c.blue, alpha: c.alpha};
    } catch {
        return WHITE;
    }
}

function accentColor(actor) {
    try {
        const [ok, c] = actor.get_theme_node().lookup_color('-st-accent-color', true);
        if (ok)
            return {red: c.red, green: c.green, blue: c.blue, alpha: c.alpha};
    } catch {
        // fall through
    }
    return {red: 53, green: 132, blue: 228, alpha: 255};
}

/* Press response of a whole glass module: scale about its centre (module + glass layer together) and
 * brighten the glass tint. `pressButton` is whichever St.Button actually receives the press. */
export class ModulePress {
    constructor(item, layer, pressButton, journal) {
        this._item = item;
        this._layer = layer;
        this._targets = [item, layer.actor];
        centrePivot(this._targets);
        this._press = new PressResponse(item, p => {
            const [w, h] = item.get_size();
            setScale(this._targets, 1 + pressGrow(w, h) * p);
            layer.setTint(layer.baseTint + FB.pressTintBoost * p);
        }, `press:module:${item.constructor.name}`);
        bindPress(pressButton, this._press);
        journal.add(() => {
            this._press.destroy();
            pressButton.disconnectObject(this._press);
            for (const a of this._targets) {
                a.set_pivot_point(0, 0);
                a.scale_x = 1;
                a.scale_y = 1;
            }
            layer.setTint(layer.baseTint);
        });
    }

    get p() {
        return this._press.p;
    }

    reset() {
        this._press.tween.set(0);
    }

    snapshot() {
        return {pressP: this._press.p, scale: this._item.scale_x, layerScale: this._layer.actor.scale_x, tint: this._layer._tint};
    }
}

/* Press response of a pill's disc: scale the 40 px disc about its centre and brighten it (white glow). */
class DiscPress {
    constructor(item, disc, glow, pressButton, journal) {
        this._disc = disc;
        centrePivot([disc]);
        this._press = new PressResponse(item, p => {
            const [w, h] = disc.get_size();
            setScale([disc], 1 + pressGrow(w, h) * p);
            glow.opacity = Math.round(255 * FB.pressTintBoost * p);
        }, `press:disc:${item.constructor.name}`);
        bindPress(pressButton, this._press);
        journal.add(() => {
            this._press.destroy();
            pressButton.disconnectObject(this._press);
            disc.set_pivot_point(0, 0);
            disc.scale_x = 1;
            disc.scale_y = 1;
        });
    }

    get p() {
        return this._press.p;
    }

    reset() {
        this._press.tween.set(0);
    }
}

export class ToggleFeedback {
    // item: the module; layer: its GlassLayer;
    // opts: {kind: 'circle'|'pill', pressButton, menuButton?, icon}
    constructor(item, layer, opts, journal) {
        this.kind = opts.kind;
        this._item = item;
        this._layer = layer;
        this._icon = opts.icon;
        const j = journal;
        const fill = new St.Widget({style_class: 'cc-fb-fill', reactive: false, x_expand: true, y_expand: true});
        this._fill = fill;
        if (opts.kind === 'circle') {
            // the whole circle is the disc: [fill, original content] inside the module
            const saved = item.get_child();
            const wrap = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
                style_class: 'cc-fb-wrap'});
            j.add(() => wrap.destroy());
            j.add(() => {
                if (saved.get_parent() === wrap)
                    wrap.remove_child(saved);
                item.set_child(saved);
            });
            item.set_child(wrap);
            wrap.add_child(fill);
            wrap.add_child(saved);
            this._disc = wrap;
            this._press = new ModulePress(item, layer, opts.pressButton, j);
        } else {
            // pill: the disc is the icon; [dark disc, fill, glow, icon] in a 40 px wrapper
            const box = opts.icon.get_parent();
            const index = box.get_children().indexOf(opts.icon);
            const dark = new St.Widget({style_class: 'cc-fb-dark', reactive: false, x_expand: true, y_expand: true});
            const glow = new St.Widget({style_class: 'cc-fb-glow', reactive: false, x_expand: true, y_expand: true, opacity: 0});
            const wrap = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'cc-fb-disc',
                y_align: Clutter.ActorAlign.CENTER, x_expand: false});
            j.add(() => wrap.destroy());
            j.add(() => box.remove_child(wrap));
            box.insert_child_at_index(wrap, index);
            wrap.add_child(dark);
            wrap.add_child(fill);
            wrap.add_child(glow);
            j.move(opts.icon, wrap);
            this._disc = wrap;
            this._glow = glow;
            this._press = new DiscPress(item, wrap, glow, opts.pressButton, j);
            if (opts.menuButton)
                this._textPress = new ModulePress(item, layer, opts.menuButton, j);
        }

        // ---- on/off crossfade: fill opacity and glyph colour -------------------------------------
        this._state = new Tween(item, v => this._applyState(v), item.checked ? 1 : 0, `state:${item.constructor.name}`);
        this._offColor = WHITE;
        this._onColor = null;
        this._applyState(this._state.value);
        item.connectObject('notify::checked', () => {
            this._onColor ??= accentColor(item);
            // the stylesheet has already flipped the glyph to its new colour: hold the old one until the tween plays
            if (animationsOn())
                this._applyState(this._state.value, true);
            const target = item.checked ? 1 : 0;
            this._state.to(target, FB.stateMs, 'linear', () => this._applyState(target));
        }, this);
        j.add(() => this.destroy());
    }

    reset() {
        this._press.reset();
        this._textPress?.reset();
        this._state.set(this._item.checked ? 1 : 0);
    }

    _applyState(v, hold = false) {
        this._fill.opacity = Math.round(255 * v);
        const icon = this._icon;
        if (!icon)
            return;
        if (!hold && !this._state.running && (v <= 0 || v >= 1)) {
            // steady state: the stylesheet colours the glyph
            icon.set_style(null);
            return;
        }
        const on = this._onColor ?? (this._onColor = accentColor(this._item));
        icon.set_style(`color: ${cssRgba(lerpColor(this._offColor, on, v))} !important;`);
    }

    snapshot() {
        const t = this._item;
        const [x, y] = t.get_transformed_position();
        const [w, h] = t.get_transformed_size();
        const [dx, dy] = this._disc.get_transformed_position();
        const [dw, dh] = this._disc.get_transformed_size();
        return {
            checked: t.checked, state: this._state.value, fillOp: this._fill.opacity,
            glyph: this._icon ? themeColor(this._icon) : null,
            pressP: this._press.p, textPressP: this._textPress?.p ?? null,
            itemScale: t.scale_x, discScale: this._disc.scale_x, layerScale: this._layer.actor.scale_x,
            tint: this._layer._tint, glow: this._glow?.opacity ?? null,
            item: {x, y, w, h}, disc: {x: dx, y: dy, w: dw, h: dh},
        };
    }

    destroy() {
        this._state.destroy();
        this._item.disconnectObject(this);
    }
}

/* ---- small round buttons ---------------------------------------------------------------------- */
export class ButtonFeedback {
    constructor(button, journal) {
        this.kind = 'button';
        this._button = button;
        centrePivot([button]);
        this._press = new PressResponse(button, p => {
            const [w, h] = button.get_size();
            setScale([button], 1 + pressGrow(w, h) * p);
            if (p > 0)
                button.set_style(`background-color: rgba(255, 255, 255, ${(0.12 + FB.pressTintBoost * p).toFixed(3)}) !important;`);
            else
                button.set_style(null);
        }, `press:button:${button.style_class}`);
        bindPress(button, this._press);
        journal.add(() => {
            this._press.destroy();
            button.disconnectObject(this._press);
            button.set_pivot_point(0, 0);
            button.scale_x = 1;
            button.scale_y = 1;
            button.set_style(null);
        });
    }

    get p() {
        return this._press.p;
    }

    reset() {
        this._press.tween.set(0);
    }

    snapshot() {
        return {pressP: this._press.p, scale: this._button.scale_x};
    }
}

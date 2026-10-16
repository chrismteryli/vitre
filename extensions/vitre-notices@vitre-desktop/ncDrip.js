/* Notification Center side of the liquid drip (plan A17): the adapter the shared controller (liquidDrip.js)
 * drives. Pieces are the notification cards (each with its own glass plate) and the widgets (calendar,
 * clocks, weather: opaque dark surfaces of their own); the pill is the clock in the top bar. During the drip
 * the cards' glass and every piece's content are hidden and the field draws the glass; each piece hands over
 * as it settles. begin() remembers every opacity, end() puts exactly that back. */
import {op255, DRIP} from './liquidDrip.js';
import {GLASS_FINISH} from './glass.js';
import {NCGEO} from './helpers.js';

const PILL_H = 21;           // the top-bar highlight pill used by Control Center (18.5 pt x 1.15)
const PILL_PAD = 6;          // the pill sticks out of the clock's text by this much on each side

export class NCDripAdapter {
    constructor(ext) {
        this._ext = ext;
        this.finish = GLASS_FINISH;
        this.handoffMs = DRIP.handoffMs;     // the field fades out over this long after the geometry is done (no rim step at the end)
        this.allocCount = 0;
        this._allocAt = -1;
        this._saved = null;
        this._lifetimes = new Map();
        this._widgetsPending = false;
        this._handles = new Map();
        this._ids = new WeakMap();
        this._nextId = 1;
    }

    _idOf(actor) {
        let id = this._ids.get(actor);
        if (!id) {
            id = `nc${this._nextId++}`;
            this._ids.set(actor, id);
        }
        return id;
    }

    _collect() {
        const ext = this._ext;
        const out = [];
        for (const [message, entry] of ext._plates ?? []) {
            if (!message.visible || !message.get_stage())
                continue;
            const children = entry.plate.get_children();
            // a message lower in a collapsed stack sits behind the top card: its glass edge is part of the drip,
            // its content stays hidden until the end (at rest the top card's glass covers it)
            const covered = message.has_style_pseudo_class('second-in-stack') || message.has_style_pseudo_class('lower-in-stack');
            out.push({id: this._idOf(message), actor: message, radius: NCGEO.cardRadius, layer: entry.layer, covered,
                vbox: children.find(c => c._plateRole === 'content'), rim: children.find(c => c._plateRole === 'rim')});
        }
        const card = ext._calendarCard;
        if (card && card.visible)
            out.push({id: this._idOf(card), actor: card, radius: NCGEO.widgetRadius, solid: true});
        for (const row of ext._widgetsBox?.get_children() ?? []) {
            if (!row.visible)
                continue;
            for (const widget of row.get_children()) {
                if (widget.visible)
                    out.push({id: this._idOf(widget), actor: widget, radius: NCGEO.widgetRadius, solid: true});
            }
        }
        return out;
    }

    // ---- geometry --------------------------------------------------------------------------------------

    // the source pill is the clock: when it is not on screen (panel hidden) there is nothing to drip from, and the surface is
    // handed over at once instead of waiting out the geometry timeout invisible
    canDrip() {
        const native = this._ext._native;
        return Boolean((native?.dateMenu?._clockDisplay ?? native?.date)?.mapped);
    }

    geometry(rest = false) {
        const ext = this._ext;
        const native = ext._native;
        if (!native || !ext._outer)
            return null;
        if (!rest && this.allocCount <= this._allocAt)
            return null;
        const [vx, vy] = ext._outer.get_transformed_position();
        const [vw, vh] = ext._outer.get_transformed_size();
        if (![vx, vy, vw, vh].every(Number.isFinite) || vw < 1)
            return null;
        // the column's scroll view clips at its box: every piece is its visible part
        const view = {x0: vx, y0: vy, x1: vx + vw, y1: vy + vh};
        const rects = [];
        for (const h of this._collect()) {
            const [x, y] = h.actor.get_transformed_position();
            const [w, hgt] = h.actor.get_transformed_size();
            if (![x, y, w, hgt].every(Number.isFinite) || w < 1 || hgt < 1)
                continue;
            const x0 = Math.max(x, view.x0);
            const y0 = Math.max(y, view.y0);
            const x1 = Math.min(x + w, view.x1);
            const y1 = Math.min(y + hgt, view.y1);
            if (x1 - x0 < 4 || y1 - y0 < 4)
                continue;
            rects.push({id: h.id, solid: Boolean(h.solid), x: x0, y: y0, w: x1 - x0, h: y1 - y0, r: Math.min(h.radius, (x1 - x0) / 2, (y1 - y0) / 2)});
        }
        if (!rects.length)
            return null;
        // rows: pieces whose tops are within 4 px share a row
        rects.sort((a, b) => a.y - b.y || a.x - b.x);
        let row = -1;
        let lastY = -1e9;
        for (const r of rects) {
            if (r.y - lastY > 4) {
                row++;
                lastY = r.y;
            }
            r.row = row;
        }
        const clock = native.dateMenu._clockDisplay ?? native.date;
        if (!clock?.mapped)
            return null;
        const [cx, cy] = clock.get_transformed_position();
        const [cw, ch] = clock.get_transformed_size();
        if (![cx, cy, cw, ch].every(Number.isFinite))
            return null;
        const pill = {x: cx - PILL_PAD, y: cy + (ch - PILL_H) / 2, w: cw + 2 * PILL_PAD, h: PILL_H, keep: false};
        return {pill, pieces: rects};
    }

    maskActor() {
        return this._ext._column ?? null;
    }

    // ---- take over / hand back -------------------------------------------------------------------------

    // Native open-state/weather/location signals can rebuild widgets while an opening or
    // closing field still owns them. Keep the existing actors until handback, then render
    // the latest native data once; a replacement must never flash outside the held field.
    deferWidgets() {
        if (!this._saved)
            return false;
        this._widgetsPending = true;
        return true;
    }

    _observe(actor) {
        if (!actor)
            return null;
        let life = this._lifetimes.get(actor);
        if (!life) {
            life = {actor, alive: true, id: 0};
            life.id = actor.connect('destroy', () => {
                life.alive = false;
            });
            this._lifetimes.set(actor, life);
        }
        return life;
    }

    begin() {
        if (this._saved)
            return;
        this._allocAt = this.allocCount;
        this._handles = new Map();
        const saved = [];
        for (const h of this._collect()) {
            // GJS may warn and continue instead of throwing on a disposed GObject.
            // Track destruction while the objects are alive; try/catch cannot guard it.
            h.life = {actor: this._observe(h.actor), layer: this._observe(h.layer?.actor),
                rim: this._observe(h.rim), vbox: this._observe(h.vbox)};
            this._handles.set(h.id, h);
            const rec = {h, actorOp: h.actor.opacity, layerOp: h.layer?.actor.opacity, rimOp: h.rim?.opacity, vboxOp: h.vbox?.opacity};
            saved.push(rec);
            if (h.layer) {
                h.layer.actor.opacity = 0;
                if (h.rim)
                    h.rim.opacity = 0;
                if (h.vbox)
                    h.vbox.opacity = 0;
            } else {
                h.actor.opacity = 0;
            }
        }
        this._saved = saved;
    }

    setPiece(id, {real, content, clip}) {
        const h = this._handles.get(id);
        if (!h?.life.actor.alive)
            return;
        if (h.layer) {
            if (h.life.layer?.alive)
                h.layer.actor.opacity = op255(real);
            if (h.life.rim?.alive)
                h.rim.opacity = op255(real);
            if (h.life.vbox?.alive)
                h.vbox.opacity = h.covered ? 0 : op255(content);
        } else {
            h.actor.opacity = op255(content);
        }
    }

    end() {
        const saved = this._saved;
        this._saved = null;
        for (const rec of saved ?? []) {
            const {h} = rec;
            if (h.layer) {
                if (h.life.layer?.alive)
                    h.layer.actor.opacity = rec.layerOp;
                if (h.life.rim?.alive)
                    h.rim.opacity = rec.rimOp;
                if (h.life.vbox?.alive)
                    h.vbox.opacity = rec.vboxOp;
            } else if (h.life.actor.alive) {
                h.actor.opacity = rec.actorOp;
            }
        }
        for (const life of this._lifetimes.values()) {
            if (life.alive)
                life.actor.disconnect(life.id);
        }
        this._lifetimes.clear();
        this._handles.clear();
        const pending = this._widgetsPending;
        this._widgetsPending = false;
        if (pending && this._ext._active)
            this._ext._updateWidgets();
    }
}

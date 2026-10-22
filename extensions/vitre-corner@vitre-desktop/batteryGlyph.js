/* The capsule's battery, drawn on the monitor's device-pixel grid.
 *
 * The symbolic icon theme's battery icons (what the top bar shows) are 16 px squares: at 1.5x their charging bolt sits
 * inside the fill with a quarter-pixel gap, and in the rig the charging and the discharging capsule had the same pixels at
 * 3x. This glyph keeps the theme's language (an outlined body, a nub, a fill that follows the level; the theme's success
 * colour for a battery on external power and its error colour for a low one, from the same St icon colours that recolour
 * the top bar's symbolic icons) and makes the state unmistakable at 1.5x:
 *   on battery      white fill to the level; under 20 % (the theme's red levels) the fill is the error colour
 *   charging        success-coloured fill and a white bolt across the body, cut free of the fill by a clear gap
 *   charged         the same with a full fill (on power, nothing left to charge)
 *   plugged in      success-coloured fill and a white plug: on power but held, not charging (a charge limit)
 * Every edge that is straight sits on whole device pixels at 1x, 1.5x and 2x; only the bolt's slants are antialiased.
 * Colours: the widget's CSS colour for the outline, the fill and the marks; success and error from St's icon colours. */
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'cairo';

export const LOW_PERCENT = 20;      // under this, on battery, the fill takes the error colour (the theme's red levels are 0 to 19)

// St's own defaults, used only if the theme node cannot be read
const FALLBACK = {success: [0x4e / 255, 0x9a / 255, 0x06 / 255, 1], error: [0xcc / 255, 0, 0, 1]};
// the bolt in a unit box: top tip, the left wing, the notch, the bottom tip, the right wing, the notch
const BOLT = [[0.62, 0.00], [0.02, 0.60], [0.45, 0.60], [0.32, 1.00], [0.98, 0.38], [0.55, 0.38]];

let warned = false;

const rgba = c => c ? [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255] : null;

function roundRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// the bolt or the plug, `h` device px tall, centred on (cx, cy)
function markPath(cr, kind, cx, cy, h) {
    cr.newPath();
    if (kind === 'bolt') {
        const w = h * 0.64;
        BOLT.forEach(([px, py], i) => {
            const x = cx - w / 2 + px * w, y = cy - h / 2 + py * h;
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        });
        cr.closePath();
        return;
    }
    // the plug, upright: two prongs, the head, the cord (15 units tall)
    const u = h / 15;
    const top = cy - h / 2;
    cr.rectangle(cx - 1.5 * u - 2 * u, top, 2 * u, 5 * u);
    cr.rectangle(cx + 1.5 * u, top, 2 * u, 5 * u);
    roundRect(cr, cx - 4.5 * u, top + 4 * u, 9 * u, 6 * u, 2 * u);
    cr.rectangle(cx - 1.5 * u, top + 9 * u, 3 * u, 6 * u);
}

export const BatteryGlyph = GObject.registerClass(
class BatteryGlyph extends St.DrawingArea {
    _init(params = {}) {
        super._init({reactive: false, ...params});
        this._state = {level: 0, power: null, low: false};
        this._colorsUsed = null;
        this.connect('repaint', () => {
            try {
                this._draw();
            } catch (e) {
                if (!warned) {
                    warned = true;
                    console.warn(`Vitre Corner: the battery glyph could not be drawn (${e.message})`);
                }
            }
        });
        this.connect('style-changed', () => this.queue_repaint());
        try {
            this.connect('resource-scale-changed', () => this.queue_repaint());
        } catch (_e) {
            // St redraws on a scale change by itself
        }
    }

    // level 0..1; power null (on battery) | 'charging' | 'charged' | 'plugged'; low: on battery under LOW_PERCENT
    setState({level = 0, power = null, low = false} = {}) {
        const next = {level: Math.max(0, Math.min(1, Number(level) || 0)), power: power ?? null, low: Boolean(low) && !power};
        const s = this._state;
        if (s.level === next.level && s.power === next.power && s.low === next.low)
            return;
        this._state = next;
        this.queue_repaint();
    }

    // rig: what is drawn
    get state() {
        return {...this._state, colors: this._colorsUsed};
    }

    _colors() {
        const node = this.get_theme_node();
        const fg = rgba(node.get_foreground_color()) ?? [1, 1, 1, 1];
        let success = null, error = null;
        try {
            const icon = node.get_icon_colors();
            success = rgba(icon?.success);
            error = rgba(icon?.error);
        } catch (_e) {
            // an St without icon colours: its own defaults
        }
        return {fg, success: success ?? FALLBACK.success, error: error ?? FALLBACK.error};
    }

    _draw() {
        const cr = this.get_context();
        try {
            const [sw] = this.get_surface_size();
            const s = this.get_resource_scale() || 1;
            const devW = Math.round(this.width * s);
            const devH = Math.round(this.height * s);
            if (!(sw > 0) || !(devW > 0) || !(devH > 0))
                return;
            // draw in device pixels whatever the surface's own scale
            const u = sw / devW;
            cr.scale(u, u);
            const {level, power, low} = this._state;
            const col = this._colors();
            this._colorsUsed = {fg: col.fg.map(v => Math.round(v * 255)), success: col.success.map(v => Math.round(v * 255)),
                error: col.error.map(v => Math.round(v * 255))};
            const lw = Math.max(1, Math.round(s));                // the outline: 1 px, on whole device px
            const gap = Math.max(1, Math.round(0.75 * s));        // outline to fill
            const nubGap = Math.max(1, Math.round(0.6 * s));
            const nubW = Math.max(2, Math.round(1.4 * s));
            const BW = devW - nubGap - nubW;
            const BH = Math.min(devH, Math.round(11.5 * s));
            let nubH = Math.round(4.5 * s);
            if ((BH - nubH) % 2)
                nubH++;                                           // centred on whole pixels
            const y0 = Math.round((devH - BH) / 2);
            const r = Math.round(3.3 * s);
            // body and nub
            cr.setSourceRGBA(...col.fg);
            cr.setLineWidth(lw);
            roundRect(cr, lw / 2, y0 + lw / 2, BW - lw, BH - lw, r - lw / 2);
            cr.stroke();
            roundRect(cr, BW + nubGap, y0 + (BH - nubH) / 2, nubW, nubH, nubW / 2);
            cr.fill();
            // the fill, with the mark cut free of it
            const ix = lw + gap, iy = y0 + lw + gap;
            const iw = BW - 2 * (lw + gap), ih = BH - 2 * (lw + gap);
            let fw = Math.round(iw * level);
            if (level > 0)
                fw = Math.max(fw, Math.max(2, Math.round(1.4 * s)));
            const kind = power === 'plugged' ? 'plug' : power ? 'bolt' : null;
            const mh = BH - 2 * lw + Math.round(s);
            const cx = BW / 2, cy = y0 + BH / 2;
            if (fw > 0) {
                cr.pushGroup();
                cr.setSourceRGBA(...(power ? col.success : low ? col.error : col.fg));
                roundRect(cr, ix, iy, fw, ih, Math.max(1, r - lw - gap));
                cr.fill();
                if (kind) {
                    cr.setOperator(Cairo.Operator.CLEAR);
                    markPath(cr, kind, cx, cy, mh);
                    cr.setLineWidth(2 * Math.max(1, Math.round(s)));
                    cr.setLineJoin(Cairo.LineJoin.ROUND);
                    cr.strokePreserve();
                    cr.fill();
                    cr.setOperator(Cairo.Operator.OVER);
                }
                cr.popGroupToSource();
                cr.paint();
            }
            if (kind) {
                cr.setSourceRGBA(...col.fg);
                markPath(cr, kind, cx, cy, mh);
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }
});

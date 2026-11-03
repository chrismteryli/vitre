/* The pour (liquid v3): the glass that leaves a top-bar button (or a Dock icon) and becomes the surface, as springs.
 * Pure math, no GI imports (node loads it for the unit tests). One file for every surface that pours: menus, Control
 * Center, Notification Center, the volume / brightness capsule, the Dock's menus and stacks, the fullscreen corner
 * capsule. It is carried byte-identical by those extensions (tools/check-engine.sh), with liquid.js beside it.
 *
 * ONE clear-glass shape, rendered as a signed-distance field (smooth minimum of rounded boxes): shape 0 is the source
 * pill (the button's highlight), shape 1 (and 2 for multi-piece surfaces) are unused slots kept for the field's layout,
 * then one rounded box per piece (the menu, each Control Center module, each Notification Center card).
 *
 * Every piece is four edge springs (liquid.js, role 'pour', feel A Viscous). Opening, the far edges lead and the edge at
 * the button trails on the same spring x viscosity: the glass stretches with speed and relaxes on its own (no time
 * delay). Closing, the springs are retargeted home with the exit parameters (response x 0.8, damping >= 0.94, never
 * bouncing): the edge at the button leads and the far edge is pulled after it. Retargeting keeps velocity, so an open
 * can be reversed mid-flight, a surface can change size while it pours, and one surface can flow sideways into another
 * (the body is handed over with its velocities). Content, the field's glass and the hand-over to the surface's own
 * glass are Fade springs (critically damped, never past the target). Reduced motion: a 160 ms cross-fade in place.
 *
 * Coordinates: stage logical px, y down. A piece is {x, y, w, h, r} (top-left, full sizes); a shape is {x, y, w, h, r}
 * (centre, HALF sizes, corner radius).
 */
import {Spring, Fade, role, feel, REDUCED, EPS_PX, EPS_OPACITY} from './liquid.js';

// Look and layout constants (no durations: the motion is the springs').
export const DRIP = {
    k0: 3,                  // smooth-union softness at rest (px): no blending between shapes more than this apart
    kStart: 1.1,            // softness with the button while the glass leaves it, x the button's height; melts to k0 as it arrives
    pillGoneHh: 4.0,        // a button without a highlight of its own (keep = false) is removed below this half height (px)
    fromW: 0.6,             // the glass leaves from this much of the button's width ...
    fromH: 0.5,             // ... and height, at its far-side centre
    staggerPerPx: 0.12,     // multi-piece: a tile starts this many ms later per px from the button (it pours into nearer tiles first) ...
    staggerMaxMs: 70,       // ... at most this much later
    contentFrom: 0.45,      // content fades in once every piece is this far along
    realFrom: 0.5,          // hand-over: the field fades out once the surface's own glass is this far in
    closeDone: 0.995,       // a close is done when every piece is this close to home (the remaining glass is under the button)
    handoffMs: 40,          // kept for the adapters' API: > 0 means the surface's own glass differs from the field's (hand-over)
    switchOpenSpeed: 1.5,   // flags kept for the callers: an open / close with these values is one top-bar pop-out flowing
    switchCloseScale: 0.8,  // ... into another (liquidDrip.js hands the glass body over)
};

// content leaving: faster than the fade role, as the lab's menus (r 0.12, critically damped)
export const CONTENT_OUT = {r: 0.12, z: 1};

export const clamp01 = v => Math.min(1, Math.max(0, v));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, s) => a + (b - a) * s;
// a mapping of a value onto 0..1 with soft ends (used to read a look off the springs' state, never as a time curve)
export const smoothstep = (a, b, v) => {
    const s = clamp01((v - a) / (b - a));
    return s * s * (3 - 2 * s);
};

const EDGES = ['top', 'bottom', 'left', 'right'];
const EMPTY = {x: -10000, y: -10000, w: 0, h: 0, r: 0};
const edgesOf = r => ({top: r.y, bottom: r.y + r.h, left: r.x, right: r.x + r.w});

// the box the glass leaves from: fromW x fromH of the button, at its centre (the far side of a box that small is inside it)
export function sourceBox(pill) {
    const w = pill.w * DRIP.fromW, h = pill.h * DRIP.fromH;
    return {x: pill.x + pill.w / 2 - w / 2, y: pill.y + pill.h / 2 - h / 2, w, h, r: h / 2};
}

export class Pour {
    // geom = {pill: {x, y, w, h, keep}, pieces: [{id, x, y, w, h, r, row}]}; opts: {handoff (bool), reduced (bool), inherit}
    //   inherit: {box: {x, y, w, h}, v: {top, bottom, left, right}} a glass body handed over by another surface (sideways flow)
    constructor(geom, {handoff = false, reduced = false, inherit = null} = {}) {
        this.pill = {...geom.pill};
        this.ph = this.pill.h;
        this.handoff = handoff;
        this.reduced = reduced;
        this.from = sourceBox(this.pill);
        this.multi = geom.pieces.length > 1;
        this.pieceOffset = this.multi ? 3 : 2;
        this.nShapes = geom.pieces.length + this.pieceOffset;
        const start = inherit?.box ?? this.from;
        const cx = this.pill.x + this.pill.w / 2, cy = this.pill.y + this.pill.h / 2;
        this.pieces = geom.pieces.map(p => {
            const e = edgesOf(start);
            const s = {};
            for (const k of EDGES) {
                s[k] = new Spring(e[k], role('pour'), EPS_PX);
                s[k].v = inherit?.v?.[k] ?? 0;
            }
            // the edge that faces the button is the near edge (it trails on the way out and leads on the way home)
            const below = p.y + p.h / 2 >= cy;
            const stagger = this.multi
                ? Math.min(DRIP.staggerMaxMs, Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - (below ? this.pill.y + this.pill.h : this.pill.y)) * DRIP.staggerPerPx) / 1000
                : 0;
            return {id: p.id, rect: {...p}, s, near: below ? 'top' : 'bottom', far: below ? 'bottom' : 'top', stagger, wait: 0,
                begun: false, r0: start.r ?? this.from.r};
        });
        // inherit: the body arrives already lit and in front: the field shows at once, content waits for the pour
        this.field = new Fade(inherit ? 1 : 0, role('fade'), EPS_OPACITY);
        this.content = new Fade(0, role('fade'), EPS_OPACITY);
        this.real = new Fade(0, role('fade'), EPS_OPACITY);
        this.mode = 'idle';         // 'opening' | 'open' | 'closing' | 'closed'
        this._homeFrom = null;
        this.t = 0;
    }

    // ---- commands ----------------------------------------------------------------------------------------------------

    open() {
        this.mode = 'opening';
        if (this.reduced) {
            // 160 ms cross-fade in place: the pieces sit at their rest, the surface's own glass and its content fade in together
            for (const p of this.pieces) {
                this._snapPiece(p, p.rect);
                p.begun = true;
            }
            this.field.snap(0);
            this.real.set(1, REDUCED);
            this.content.set(1, REDUCED);
            return;
        }
        const lead = role('pour'), trail = role('pour', {trail: true});
        for (const p of this.pieces) {
            const e = edgesOf(p.rect);
            p.go = () => {
                p.begun = true;
                for (const k of EDGES)
                    p.s[k].set(e[k], k === p.near ? trail : lead);
            };
            if (p.begun || p.stagger <= 0)
                p.go();
            else
                p.wait = p.stagger;
        }
        this.field.set(1, role('fade'));
        this.real.set(0, role('fade', {exit: true}));
        this._homeFrom = null;
    }

    // home: the glass goes back into the button. From rest (a settled surface) the field takes over the surface's own glass
    // at its exact rectangles first (identical looks: the swap is invisible).
    close() {
        if (this.mode === 'open' || this.mode === 'idle') {
            for (const p of this.pieces) {
                this._snapPiece(p, p.rect);
                p.begun = true;
            }
            if (!this.reduced) {
                this.field.snap(1);
                this.real.snap(0);
            }
            this.content.snap(1);
        }
        this.mode = 'closing';
        if (this.reduced) {
            this.field.snap(0);
            this.real.set(0, REDUCED);
            this.content.set(0, REDUCED);
            return;
        }
        const lead = role('pour', {exit: true});
        const trail = {r: lead.r * feel().visc, z: lead.z};
        const home = edgesOf(this.from);
        for (const p of this.pieces) {
            p.wait = 0;
            p.go = null;
            p.begun = true;
            // the edge at the button leads, the far edge (and the width) is pulled after it
            for (const k of EDGES)
                p.s[k].set(home[k], k === p.near ? lead : trail);
        }
        this.content.set(0, CONTENT_OUT);
        this.real.snap(0);
        this.field.set(1, role('fade'));
        this._homeFrom = this.pieces.map(p => ({...this._edges(p)}));
    }

    // the surface's rectangles moved while it pours (a widget that loads late): the springs take the new targets, keeping speed
    retarget(rects) {
        if (this.mode !== 'opening')
            return;
        const byId = new Map(rects.map(r => [r.id, r]));
        for (const p of this.pieces) {
            const t = byId.get(p.id);
            if (!t || ![t.x, t.y, t.w, t.h, t.r].every(Number.isFinite) || t.w < 1 || t.h < 1)
                continue;
            p.rect = {...p.rect, x: t.x, y: t.y, w: t.w, h: t.h, r: t.r};
            if (p.begun) {
                const e = edgesOf(p.rect);
                for (const k of EDGES)
                    p.s[k].set(e[k]);
            }
        }
    }

    // the glass body as it is now (union of the pieces) with its edge velocities: what another surface takes over
    body() {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const v = {top: 0, bottom: 0, left: 0, right: 0};
        for (const p of this.pieces) {
            const e = this._edges(p);
            x0 = Math.min(x0, e.left);
            x1 = Math.max(x1, e.right);
            y0 = Math.min(y0, e.top);
            y1 = Math.max(y1, e.bottom);
            for (const k of EDGES)
                v[k] += p.s[k].v / this.pieces.length;
        }
        if (!Number.isFinite(x0))
            return null;
        const r = this.pieces.length ? this._radius(this.pieces[0]) : this.from.r;
        return {box: {x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), r}, v};
    }

    // ---- stepping ----------------------------------------------------------------------------------------------------

    step(dt) {
        this.t += dt;
        for (const p of this.pieces) {
            if (p.go && !p.begun) {
                p.wait -= dt;
                if (p.wait <= 0)
                    p.go();
            }
            for (const k of EDGES)
                p.s[k].step(dt);
        }
        const least = this.openness();
        if (this.mode === 'opening') {
            if (least >= DRIP.contentFrom || this.reduced)
                this.content.set(1);
            if (!this.reduced && this.geometryRest) {
                // the hand-over: the surface's own glass fades in on the field, then the field fades out under it
                if (!this.handoff) {
                    this.real.snap(1);
                    this.field.snap(0);
                } else {
                    this.real.set(1, role('fade'));
                    if (this.real.x >= DRIP.realFrom)
                        this.field.set(0, role('fade', {exit: true}));
                }
            }
        }
        this.field.step(dt);
        this.content.step(dt);
        this.real.step(dt);
        if (this.mode === 'opening' && this.geometryRest && this.content.rest && this.real.rest && this.field.rest &&
            this.real.x === 1 && this.content.x === 1)
            this.mode = 'open';
        if (this.mode === 'closing' && this.content.rest && (this.reduced ? this.real.rest : this.homeProgress() >= DRIP.closeDone))
            this.mode = 'closed';
        return this.frame();
    }

    get geometryRest() {
        for (const p of this.pieces) {
            if (!p.begun)
                return false;
            for (const k of EDGES) {
                if (!p.s[k].rest)
                    return false;
            }
        }
        return true;
    }

    get moving() {
        return this.mode === 'opening' || this.mode === 'closing';
    }

    // how far the least advanced piece is from the source box toward its rectangle (0 at the button, 1 at rest), read on its far edge
    openness() {
        let least = Infinity;
        for (const p of this.pieces)
            least = Math.min(least, this._open(p));
        return Number.isFinite(least) ? least : 1;
    }

    _open(p) {
        const a = edgesOf(this.from)[p.far], b = edgesOf(p.rect)[p.far];
        if (Math.abs(b - a) < 1e-6)
            return 1;
        return (p.s[p.far].x - a) / (b - a);
    }

    // a close: the share of the way home covered by every edge (the lab's Shape.progress)
    homeProgress() {
        if (!this._homeFrom)
            return 1;
        const home = edgesOf(this.from);
        let d0 = 0, d = 0;
        this.pieces.forEach((p, i) => {
            const e0 = this._homeFrom[i];
            for (const k of EDGES) {
                d0 += Math.abs(home[k] - e0[k]);
                d += Math.abs(home[k] - p.s[k].x);
            }
        });
        return d0 < 1e-6 ? 1 : 1 - d / d0;
    }

    _edges(p) {
        return {top: p.s.top.x, bottom: p.s.bottom.x, left: p.s.left.x, right: p.s.right.x};
    }

    _snapPiece(p, r) {
        const e = edgesOf(r);
        for (const k of EDGES)
            p.s[k].snap(e[k]);
    }

    _radius(p) {
        return lerp(p.r0, p.rect.r, clamp01(this._open(p)));
    }

    // ---- the frame the controller draws -----------------------------------------------------------------------------

    frame() {
        const pill = this.pill;
        const bodies = [];
        const out = [];
        let doneCount = 0;
        const least = clamp01(this.openness());
        for (const p of this.pieces) {
            const e = this._edges(p);
            const left = Math.min(e.left, e.right), right = Math.max(e.left, e.right);
            const top = Math.min(e.top, e.bottom), bottom = Math.max(e.top, e.bottom);
            const hw = Math.max(0, (right - left) / 2), hh = Math.max(0, (bottom - top) / 2);
            const r = Math.max(0, Math.min(this._radius(p), hw, hh));
            const shape = this.reduced || this.mode === 'closed' ? {...EMPTY} : {x: (left + right) / 2, y: (top + bottom) / 2, w: hw, h: hh, r};
            bodies.push(shape);
            const done = this.mode === 'open';
            if (done)
                doneCount++;
            out.push({id: p.id, shape, e: this._open(p), done, started: p.begun || this.reduced, contentAlpha: this.content.x,
                real: this.real.x, clip: null, bloomU: clamp01(this._open(p))});
        }
        // the button: kept when it has a highlight of its own, else it thins away upward as the glass leaves it
        let pillHh = pill.h / 2, pillCy = pill.y + pill.h / 2;
        if (!pill.keep) {
            const f = smoothstep(0.25, 0.7, least);
            pillHh *= 1 - f;
            pillCy -= pill.h * 0.5 * f;
        }
        const pillShape = this.reduced || (!pill.keep && pillHh < DRIP.pillGoneHh) ? {...EMPTY}
            : {x: pill.x + pill.w / 2, y: pillCy, w: pill.w / 2, h: pillHh, r: Math.min(pill.w / 2, pillHh)};
        const shapes = [pillShape, {...EMPTY}];
        if (this.multi)
            shapes.push({...EMPTY});
        shapes.push(...bodies);
        return {
            shapes, k: lerp(DRIP.kStart * this.ph, DRIP.k0, smoothstep(0.15, 1, least)),
            fieldAlpha: this.reduced ? 0 : this.field.x,
            boost: 1 - smoothstep(0.6, 0.98, least),        // the glass is lit while it moves (liquidDrip _boost)
            pieces: out, allDone: out.length > 0 && doneCount === out.length, mode: this.mode, openness: least,
            drop: bodies[0] ?? {...EMPTY}, carrier: this.multi ? -1 : 0,
        };
    }
}

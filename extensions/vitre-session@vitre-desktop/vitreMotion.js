/* Vitre lock-screen intro and session dialogs (liquid v3): the card's glass stretches out of its source (the mark at the
 * top of the lock screen, or a thin glass bar under the top bar for the log-out / session dialogs) and stays connected
 * until it arrives, as the top-bar menus pour (dripMotion.js). Pure math on liquid.js, no GI imports: node loads it.
 *
 * The card is four edge springs on the 'pour' role: the edges away from the source lead, the edge at the source trails on
 * the same spring x viscosity (it stretches with speed and relaxes on its own; no time delay). The source's own glass gives
 * way as the card arrives. A close retargets the same springs home with the exit parameters (response x 0.8, damping >=
 * 0.94): the edge at the source leads, the far edge is pulled after it. A reopen turns them around from where they are.
 * Content and the field's glass are Fade springs (never past the target). No durations, no land blend: a spring rests
 * when its remaining step is under a quarter pixel.
 *
 * Coordinates: stage logical px, y down. A shape is {x, y, w, h, r}: centre, HALF sizes, corner radius (the convention of
 * the glass field shader).
 */
import {Spring, Fade, role, feel, squash, EPS_PX, EPS_OPACITY} from './liquid.js';
import {Shape, geomOf} from './liquidShape.js';

export const clamp01 = v => Math.min(1, Math.max(0, v));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, s) => a + (b - a) * s;
// a mapping of a spring's state onto 0..1 with soft ends (a look, never a time curve)
export const smoothstep = (a, b, v) => {
    const s = clamp01((v - a) / (b - a));
    return s * s * (3 - 2 * s);
};

// The brand kit's tokens.json is still read (identity/brand/tokens.json, shipped in assets/) for the pulse ring's start
// scale; the drop story it timed (fall, squash keys) is not used by the stretch.
export const FALLBACK_TOKENS = {intro: {landing: {rippleRing1: {scale: [0.42, 1.25]}}}};

export function motionFromTokens(tokens) {
    const ring = tokens?.intro?.landing?.rippleRing1 ?? FALLBACK_TOKENS.intro.landing.rippleRing1;
    return {ring: {s0: ring.scale?.[0] ?? 0.42}};
}

export const VITRE = {
    fromW: 0.7,             // the glass leaves from this much of the source's width ...
    fromH: 0.6,             // ... and height, at its far side
    kStart: 22,             // smooth-union softness with the source while the glass leaves it (px) ...
    kEnd: 4,                // ... and once the card is there
    contentFrom: 0.78,      // avatar, name, the dialog's content: in once the card is this far along
    away: [0.55, 0.95],     // the source's glass gives way between these fractions of the near edge's travel
    closeDone: 0.995,       // a close is done when this close to home (the rest is under the source)
    fieldHold: false,       // keep the field's glass after the card is there (the dialogs: their card is drawn by the sheet)
};

// content leaving: as the menus' (dripMotion.js CONTENT_OUT)
const CONTENT_OUT = {r: 0.12, z: 1};

// Surface presets (options override VITRE)
export const LOCK_OPTS = {};
export const END_OPTS = {fieldHold: true, tintFrom: 0.24, tintTo: 0.46};

const EDGES = ['top', 'bottom', 'left', 'right'];
const edgesOf = r => ({top: r.y, bottom: r.y + r.h, left: r.x, right: r.x + r.w});

// geom = {source: {cx, cy, r, bar?: {x, y, w, h}}, landing: {x, y, w, h}, card: {x, y, w, h, r}} (x, y = top-left)
export class SessionStretch {
    constructor(geom, M, opts = {}) {
        this.K = {...VITRE, ...opts};
        this.M = M ?? motionFromTokens(null);
        this._geom(geom);
        const e = edgesOf(this.from);
        this.s = {};
        for (const k of EDGES)
            this.s[k] = new Spring(e[k], role('pour'), EPS_PX);
        this.content = new Fade(0, role('fade'), EPS_OPACITY);
        this.field = new Fade(0, role('fade'), EPS_OPACITY);
        this.mode = 'idle';         // 'opening' | 'open' | 'closing' | 'closed'
        this.t = 0;                 // ms of motion time stepped so far
        this._home = null;
        this.totalMs = 0;           // kept for callers that read it (a spring has no length; 0 = unknown)
    }

    _geom(geom) {
        const {source, landing, card} = geom;
        this.source = source;
        this.bar = source.bar ?? null;
        this.landing = landing;
        // the card never shrinks below the landing rectangle it grows from
        const c = {x: Math.min(card.x, landing.x), y: Math.min(card.y, landing.y), r: card.r};
        c.w = Math.max(card.x + card.w, landing.x + landing.w) - c.x;
        c.h = Math.max(card.y + card.h, landing.y + landing.h) - c.y;
        this.card = c;
        const src = this.bar ? {...this.bar} : {x: source.cx - source.r, y: source.cy - source.r, w: 2 * source.r, h: 2 * source.r};
        this.src = src;
        const scx = src.x + src.w / 2;
        this.from = {x: scx - src.w * this.K.fromW / 2, y: src.y + src.h * (1 - this.K.fromH), w: src.w * this.K.fromW, h: src.h * this.K.fromH};
        const below = c.y + c.h / 2 >= src.y + src.h / 2;
        this.near = below ? 'top' : 'bottom';
        this.far = below ? 'bottom' : 'top';
    }

    open() {
        const lead = role('pour'), trail = role('pour', {trail: true});
        const e = edgesOf(this.card);
        for (const k of EDGES)
            this.s[k].set(e[k], k === this.near ? trail : lead);
        this.field.set(1, role('fade'));
        this.mode = 'opening';
        this._home = null;
    }

    // at rest on the card at once (a refit while the dialog is open)
    settle() {
        const e = edgesOf(this.card);
        for (const k of EDGES)
            this.s[k].snap(e[k]);
        this.content.snap(1);
        this.field.snap(this.K.fieldHold ? 1 : 0);
        this.mode = 'open';
        return this.frame();
    }

    // from rest the springs start at the card (the sheet draws it already)
    close() {
        if (this.mode === 'open' || this.mode === 'idle') {
            const e = edgesOf(this.card);
            for (const k of EDGES)
                this.s[k].snap(e[k]);
            this.content.snap(1);
            this.field.snap(1);
        }
        const lead = role('pour', {exit: true});
        const trail = {r: lead.r * feel().visc, z: lead.z};
        const home = edgesOf(this.from);
        for (const k of EDGES)
            this.s[k].set(home[k], k === this.near ? lead : trail);
        this.content.set(0, CONTENT_OUT);
        this.field.set(1, role('fade'));
        this._home = edgesOf(this._box());
        this.mode = 'closing';
    }

    // the surface's real geometry moved (the end-session lists arrived, the lock stack finished its placement): the springs
    // take the new targets with their speed
    retarget(geom) {
        this._geom(geom);
        if (this.mode === 'opening' || this.mode === 'open') {
            const e = edgesOf(this.card);
            for (const k of EDGES)
                this.s[k].set(e[k]);
        }
    }

    // step to motion time tMs (ms since the start); a time before the last step does nothing
    advance(tMs) {
        const dt = Math.max(0, tMs - this.t) / 1000;
        this.t = Math.max(this.t, tMs);
        return this.step(dt);
    }

    step(dt) {
        for (const k of EDGES)
            this.s[k].step(dt);
        if (this.mode === 'opening') {
            if (Math.min(this._prog(this.far), this._prog(this.near)) >= this.K.contentFrom)
                this.content.set(1, role('fade'));
            if (this.geometryRest && !this.K.fieldHold)
                this.field.set(0, role('fade', {exit: true}));
        }
        this.content.step(dt);
        this.field.step(dt);
        if (this.mode === 'opening' && this.geometryRest && this.content.rest && this.content.x === 1 &&
            (this.K.fieldHold || (this.field.rest && this.field.x === 0)))
            this.mode = 'open';
        if (this.mode === 'closing' && this.content.rest && this.homeProgress() >= this.K.closeDone)
            this.mode = 'closed';
        return this.frame();
    }

    get geometryRest() {
        return EDGES.every(k => this.s[k].rest);
    }

    _prog(k) {
        const a = edgesOf(this.from)[k], b = edgesOf(this.card)[k];
        return Math.abs(b - a) < 1e-6 ? 1 : (this.s[k].x - a) / (b - a);
    }

    _box() {
        const t = this.s.top.x, b = this.s.bottom.x, l = this.s.left.x, r = this.s.right.x;
        return {x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t)};
    }

    homeProgress() {
        if (!this._home)
            return 1;
        const home = edgesOf(this.from);
        let d0 = 0, d = 0;
        for (const k of EDGES) {
            d0 += Math.abs(home[k] - this._home[k]);
            d += Math.abs(home[k] - this.s[k].x);
        }
        return d0 < 1e-6 ? 1 : 1 - d / d0;
    }

    frame() {
        const K = this.K;
        const src = this.src;
        const scx = src.x + src.w / 2;
        const far = clamp01(this._prog(this.far)), near = clamp01(this._prog(this.near));
        const b = this._box();
        const hw = b.w / 2, hh = b.h / 2;
        const started = this.mode !== 'idle';
        const card = started && this.mode !== 'closed'
            ? {x: b.x + hw, y: b.y + hh, w: hw, h: hh, r: Math.max(0, Math.min(lerp(Math.min(src.w, src.h) / 2, this.card.r, far), hw, hh))}
            : {x: scx, y: src.y + src.h / 2, w: 0, h: 0, r: 0};
        // the source's own glass: present from the first frame, gives way as the card arrives
        const away = smoothstep(K.away[0], K.away[1], near);
        const sw = src.w / 2 * (1 - away), sh = src.h / 2 * (1 - away);
        const source = {x: scx, y: src.y + src.h / 2, w: sw, h: Math.min(sh, sw), r: Math.min(sh, sw)};
        const thread = {x: scx, y: src.y, w: 0, h: 0, r: 0};
        const shapes = [card, source, thread];
        if (this.bar)
            shapes.push({x: scx, y: src.y + src.h / 2, w: 0, h: 0, r: 0});
        const blend = smoothstep(0, 1, far);
        return {t: this.t, phase: started ? 'bloom' : 'bud', shapes, k: lerp(K.kStart, K.kEnd, smoothstep(0.2, 1, near)),
            fieldAlpha: this.field.x, cardHidden: !(this.geometryRest && this.mode !== 'closing' && this.mode !== 'idle'),
            contentAlpha: this.content.x, ring: {alpha: 0, scale: this.M.ring?.s0 ?? 0.42}, markScale: 1,
            tint: K.tintFrom === undefined ? undefined : lerp(K.tintFrom, K.tintTo, blend), tintBlend: blend,
            done: this.mode === 'open' || this.mode === 'closed', mode: this.mode};
    }
}

// the end-session dialog and the other session dialogs
export function dropContext(geom, M, opts = {}) {
    return new SessionStretch(geom, M, opts);
}

// the lock screen: the mark, the password capsule, the unlock card (the intro starts at once)
export function lockIntroContext(geom, M) {
    const {mark, capsule, card} = geom;
    const ctx = new SessionStretch({source: {cx: mark.cx, cy: mark.cy, r: mark.r}, landing: capsule, card}, M, LOCK_OPTS);
    ctx.open();
    return ctx;
}

// The surface's real geometry moved while the stretch runs: the springs take it over (speed kept). Returns ctx.
export function retargetContext(ctx, next) {
    ctx.retarget({source: next.source, landing: next.landing, card: next.card});
    return ctx;
}

// Do two cards differ (position or size) by more than eps px?
export function cardMoved(a, b, eps = 0.5) {
    return Math.abs(a.x - b.x) > eps || Math.abs(a.y - b.y) > eps || Math.abs(a.w - b.w) > eps || Math.abs(a.h - b.h) > eps;
}

// the lock screen's frame at t ms since the intro started (steps the springs to t)
export function lockIntroFrame(ctx, t) {
    return ctx.advance(t);
}

// the frame of a context as it is (no stepping)
export function dropFrame(ctx) {
    return ctx.frame();
}

// ---- Motion Lab 2: the session's bead ----------------------------------------------------------------------------------
// The lock prompt, the unlock and the end of the session tell one story with one bead of glass:
//   drop()   the bead lets go of the bar and falls under gravity (liquid.js FEELS gravity); its impact on the landing point
//            kicks its squash spring (from the impact speed, area kept) and starts a ring on the pour spring; 0.12 s later
//            it blooms into the card (the lab's Shape on 'pour', the widths and the top leading out of the bead) and is
//            absorbed into it on the fade exit spring; the card's content fades in once the glass is 55 % of the way.
//   drain()  the content goes on {r: 0.1, z: 1}, the card drains back into a bead on the pour exit spring; the bead rises
//            into the bar on the pour exit spring (stretched by its speed) and is absorbed on the fade exit spring.
// Coordinates: stage px. geom = {cx (the drop line), barY (where the bead leaves and goes back), land (where it lands),
// card: {x, y, w, h, r}, scale (stage px per logical px: gravity is in logical px)}. frame().shapes are the glass field's {x, y, w, h, r} (centre, HALF sizes, corner radius).
export const BEAD = {
    r: 9,                   // the bead's radius (px)
    from: 0.2,              // its scale as it lets go of the bar
    impact: 0.0045,         // squash kick per px/s of impact speed, x (0.4 + volume)
    squash: 0.08,           // squash per unit of the kick spring
    bloomAfter: 0.12,       // s from the impact to the bloom
    contentFrom: 0.55,
    contentOut: {r: 0.1, z: 1},
    risen: 2,               // px from the bar: the bead is in it
    drained: 0.97,          // progress at which the card is a bead again
    k: 10,                  // smooth-union softness of the bead and the card
};

export class BeadStory {
    constructor(geom) {
        this.geom = geom;
        this.sh = new Shape(EPS_PX);
        this.by = new Spring(geom.barY, role('pour'), EPS_PX);    // the bead's centre y
        this.bs = new Spring(0, role('bead'), 1e-3);               // its scale (0 = gone)
        this.bq = new Spring(0, role('bead'), 1e-3);               // its squash
        this.rr = new Spring(0, role('pour'), 1e-3);               // the ring, 0 .. 1
        this.content = new Fade(0, role('fade'), EPS_OPACITY);
        this.field = new Fade(1, role('fade'), EPS_OPACITY);       // the glass field (the card's own glass takes over at rest)
        this.fall = null;           // {y, v} while it falls
        this.bloomIn = -1;          // s left until the bloom (after the impact)
        this.after = null;          // 'bloom' (content waits for 55 %) | 'rise' (waits for the drain)
        this.rising = false;
        this.mode = 'idle';         // idle | falling | landed | blooming | open | draining | rising | absorbing | closed
        this.t = 0;
        this.impact = 0;
    }

    _beadGeom(y, s = 1) {
        const r = BEAD.r * s;
        return {tY: y - r, bY: y + r, tCx: this.geom.cx, bCx: this.geom.cx, tHw: r, bHw: r};
    }

    drop(fromY = this.geom.barY, startScale = BEAD.from) {
        this.by.snap(fromY);
        this.bs.snap(startScale).set(1, role('bead'));
        this.fall = {y: fromY, v: 0};
        this.sh.hidden = true;
        this.content.snap(0);
        this.field.snap(1);
        this.mode = 'falling';
    }

    _bloom() {
        this.sh.snapTo(this._beadGeom(this.geom.land, Math.max(0.3, this.bs.x)));
        this.sh.go(geomOf(this.geom.card), role('pour'), role('pour', {trail: true}), false, true);
        this.bs.set(0, role('fade', {exit: true}));            // the bead is absorbed into the card it becomes
        this.after = 'bloom';
        this.mode = 'blooming';
    }

    // from the card at rest (or from wherever the bloom is): back into a bead, up into the bar, absorbed
    drain() {
        if (this.mode === 'idle' || this.mode === 'open' || this.sh.hidden) {
            this.sh.snapTo(geomOf(this.geom.card));
            this.content.snap(1);
        }
        this.fall = null;
        this.bloomIn = -1;
        this.field.set(1, role('fade'));
        this.content.set(0, BEAD.contentOut);
        const pe = role('pour', {exit: true});
        this.sh.go(this._beadGeom(this.geom.land), pe, {r: pe.r * feel().visc, z: pe.z}, true, true);
        this.after = 'rise';
        this.mode = 'draining';
    }

    // the card's rectangle moved (a late relayout): the springs take it with their speed
    retarget(geom) {
        this.geom = {...this.geom, ...geom};
        if (this.mode === 'blooming' || this.mode === 'open')
            this.sh.retarget(geomOf(this.geom.card));
    }

    advance(tMs) {
        const dt = Math.max(0, tMs - this.t * 1000) / 1000;
        return this.step(dt);
    }

    step(dt) {
        this.t += dt;
        const vol = feel().volume;
        if (this.fall) {
            this.fall.v += feel().gravity * (this.geom.scale ?? 1) * dt;      // px/s^2 in logical px
            this.fall.y += this.fall.v * dt;
            if (this.fall.y >= this.geom.land) {
                this.impact = this.fall.v;
                this.by.snap(this.geom.land);
                this.bq.p = role('bead');
                this.bq.kick(-this.impact * BEAD.impact * (0.4 + vol));
                this.rr.snap(0).set(1, role('pour'));
                this.fall = null;
                this.bloomIn = BEAD.bloomAfter;
                this.mode = 'landed';
            } else {
                this.by.snap(this.fall.y);
            }
        } else if (this.bloomIn >= 0) {
            this.bloomIn -= dt;
            if (this.bloomIn < 0)
                this._bloom();
        }
        for (const s of [this.by, this.bs, this.bq, this.rr])
            s.step(dt);
        this.sh.step(dt);
        if (this.after === 'bloom' && this.sh.progress() > BEAD.contentFrom) {
            this.content.set(1, role('fade'));
            this.after = null;
        }
        if (this.after === 'rise' && (this.sh.rest || this.sh.progress() > BEAD.drained)) {
            this.sh.hidden = true;
            this.by.snap(this.geom.land);
            this.bs.snap(1);
            this.rising = true;
            this.by.set(this.geom.barY, role('pour', {exit: true}));
            this.after = null;
            this.mode = 'rising';
        }
        if (this.rising && Math.abs(this.by.x - this.geom.barY) < BEAD.risen) {
            this.bs.set(0, role('fade', {exit: true}));
            this.rising = false;
            this.mode = 'absorbing';
        }
        // the bloom has settled: the card's own glass takes over, the field goes
        if (this.mode === 'blooming' && this.sh.rest && this.content.rest && this.content.x === 1 && this.bs.rest) {
            this.field.set(0, role('fade', {exit: true}));
            this.mode = 'open';
        }
        if (this.mode === 'absorbing' && this.bs.rest && this.bs.x === 0)
            this.mode = 'closed';
        this.content.step(dt);
        this.field.step(dt);
        return this.frame();
    }

    get done() {
        return (this.mode === 'open' && this.field.rest && this.field.x === 0) || this.mode === 'closed';
    }

    frame() {
        const vol = feel().volume;
        const q = squash(this.bq.x * BEAD.squash, Math.max(0.5, vol));
        const st = this.rising ? squash(Math.min(0.3, Math.abs(this.by.v) / 1800), vol) : {along: 1, across: 1};
        const s = Math.max(0, this.bs.x);
        const bw = BEAD.r * s * q.across * st.across, bh = BEAD.r * s * q.along * st.along;
        const bead = {x: this.geom.cx, y: this.by.x, w: bw, h: bh, r: Math.min(bw, bh)};
        let card = {x: this.geom.cx, y: this.geom.land, w: 0, h: 0, r: 0};
        if (!this.sh.hidden) {
            const b = this.sh.box();
            const hw = b.w / 2, hh = b.h / 2;
            card = {x: b.x + hw, y: b.y + hh, w: hw, h: hh, r: Math.min(this.geom.card.r ?? 36, hw, hh)};
        }
        const rr = this.rr.x;
        const settled = this.mode === 'open' || (this.mode === 'blooming' && this.sh.rest);
        return {
            t: this.t * 1000, mode: this.mode, shapes: [card, bead], k: BEAD.k,
            fieldAlpha: this.field.x, contentAlpha: Math.min(1, Math.max(0, this.content.x)),
            ring: {alpha: rr > 0 && rr < 1.2 ? (1 - Math.min(1, Math.max(0, rr))) * 0.8 : 0, scale: 0.3 + 0.9 * rr},
            cardHidden: !settled, beadY: this.by.x, beadScale: s, impact: this.impact,
            progress: this.sh.hidden ? 0 : this.sh.progress(), done: this.done,
        };
    }
}

/* "Liquid drip" motion (plan A17), as pure functions of time. No GI imports: node loads this file for the
 * unit tests (rig/work/a17/tests) and the design preview (tools/preview.mjs); the shell loads the same file.
 *
 * ONE clear-glass shape, rendered as a signed-distance field (smooth minimum of rounded boxes):
 *   shape 0   the source pill (the top-bar item highlight)
 *   shape 1   the thread: a thin box hanging from the pill into the drop (the neck)
 *   shape 2.. the pieces (one for a single-piece surface; every Control Center module / Notification
 *             Center card for a multi-piece one). Until pinch-off all pieces are the SAME drop, so the
 *             field is one connected shape; after pinch-off each piece blooms from the drop to its own
 *             final rectangle, top row first (the lobe split of A11), and they separate by themselves.
 *
 * This is Vitre's own design (the reference design has nothing like it): none of these numbers is measured from
 * the reference. Every constant is in the DRIP table below so it can be retuned in one place. All times are ms of
 * the "open timeline" tau (0 = the pill alone, openMs = at rest). Close plays the open timeline BACKWARDS
 * (tau goes from where it is to 0), so the retract is exactly the mirror of the drip and a reversal
 * mid-flight is continuous by construction.
 *
 * Coordinates: stage logical px, y down. A shape is {x, y, w, h, r}: centre, HALF sizes, corner radius.
 */

export const DRIP = {
    // ---- timeline (ms) ----------------------------------------------------------------------------
    openMs: 360,            // open timeline length (plan: ~360 ms)
    pullEndMs: 110,         // 0..110   the pill's bottom edge pulls down into a drop, a neck forms
    pinchMs: 230,           // 110..230 the drop travels to the panel's top-centre and swells; 230 = pinch-off
    closeMs: 240,           // close, from fully open (plan: ~240 ms); a close from tau < openMs is proportionally shorter
    closeMinFraction: 0.30, // ... but never shorter than this fraction of closeMs
    contentOutMs: 80,       // close: content fades out in the first 80 ms
    switchCloseScale: 0.7,  // close while another top-bar pop-out opens: 0.7 x the duration
    contentStartMs: 220,    // open: content alpha 0 -> 1 between these two times (it is also clipped to the glass)
    contentEndMs: 360,
    fieldFadeInMs: 28,      // the field's glass fades in over the pill during the first ms (the CSS highlight is already on)
    // ---- multi-piece (Control Center modules, Notification Center cards) -----------------------------
    rowDelayMs: 12,         // each row of pieces starts blooming this much later than the row above
    multiMaxMs: 450,        // the whole multi-piece open is at most this long
    // ---- bloom --------------------------------------------------------------------------------------
    bloomOvershoot: 0.017,  // far edges overshoot the final rectangle by this fraction, then settle (the VitreSearch split's +1.7 %)
    bloomPeakAt: 0.72,      // where in the bloom (0..1) the overshoot peaks
    // ---- pill ---------------------------------------------------------------------------------------
    pillRebound: 0.015,     // after pinch-off the pill springs back +1.5 % (size) and settles
    pillReboundMs: 70,
    pillFadeMs: 70,         // a pill with no highlight of its own (keep = false) shrinks away this fast after the rebound
    // ---- drop and neck (relative to the pill height ph) ------------------------------------------
    k0: 3,                  // smooth-union softness at rest (px): no blending between shapes more than this apart
    kPeak: 1.15,            // softness at the neck's longest, x ph
    kPeakAtMs: 170,
    kEndMs: 244,            // the neck's softness has fallen to the split softness here (the snap)
    kSplit: 0.45,           // multi-piece only: softness while the pieces separate (rounds their creases, makes necks), x ph
    kSplitEndMs: 120,       // ... falls back to k0 over this long before the end of the open
    bulbHw: 0.46,           // half width of the first bulb, x ph (t = pullEndMs)
    bulbHh: 0.56,           // half height of the first bulb, x ph
    bulbBelow: 0.34,        // the bulb's centre hangs this far (x ph) below the pill's bottom edge at pullEndMs
    threadHw0: 0.45,        // thread half width, x ph, at its thickest (t = pullEndMs)
    threadHw1: 0.10,        // ... at its thinnest, just before the break
    threadBreakMs: 232,     // the thread's half width reaches 0 here
    dropEndW: 0.34,         // the drop at pinch-off: width = this x panel width ...
    dropEndWMin: 3.2,       // ... clamped to [min, max] x ph
    dropEndWMax: 5.2,
    dropEndH: 0.30,         // ... height = this x panel height
    dropEndHMin: 2.0,
    dropEndHMax: 3.0,
    minGap: 0.9,            // the drop's top edge never starts closer than this x ph below the pill's bottom edge
    // ---- glass finishes (field), chosen per surface by the caller; see GLASS_FINISHES -----------------
    handoffMs: 40,          // single-piece surfaces whose real glass differs (Liquid Glass menus) crossfade over this
    // ---- measurement helpers ----------------------------------------------------------------------
    clipInset: 1,           // content is clipped to the piece's rectangle shrunk by this + 0.3 x radius
};

export const clamp01 = v => Math.min(1, Math.max(0, v));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, s) => a + (b - a) * s;
export const smoothstep = (a, b, v) => {
    const s = clamp01((v - a) / (b - a));
    return s * s * (3 - 2 * s);
};
export const easeOutCubic = u => 1 - Math.pow(1 - clamp01(u), 3);
export const easeInOutCubic = u => {
    u = clamp01(u);
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
};
export const easeInOutQuad = u => {
    u = clamp01(u);
    return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
};

// ---------------------------------------------------------------------------------------------------------
// Bloom curve E(u), u in [0, 1] over the bloom of one piece: 0 -> 1 with a small overshoot that settles.
// base = ease-out cubic; bump = A * sin^2 over the last part of the curve, A chosen so the peak is exactly
// 1 + bloomOvershoot. E(0) = 0, E(1) = 1, E'(1) = 0.
const _bloom = {key: '', amp: 0};
function bloomShape(u, amp) {
    const lo = Math.max(0, 2 * DRIP.bloomPeakAt - 1);   // the sin^2 bump spans [lo, 1] and peaks near `bloomPeakAt`
    const v = clamp01((u - lo) / (1 - lo));
    const bump = u <= lo ? 0 : Math.pow(Math.sin(Math.PI * v), 2);
    return easeOutCubic(u) + amp * bump;
}

// amplitude of the bump such that the curve's maximum is exactly 1 + bloomOvershoot (found once, by bisection)
function bloomAmp() {
    const key = `${DRIP.bloomOvershoot}|${DRIP.bloomPeakAt}`;
    if (_bloom.key === key)
        return _bloom.amp;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        let peak = 0;
        for (let j = 0; j <= 400; j++)
            peak = Math.max(peak, bloomShape(j / 400, mid));
        if (peak < 1 + DRIP.bloomOvershoot)
            lo = mid;
        else
            hi = mid;
    }
    _bloom.key = key;
    _bloom.amp = (lo + hi) / 2;
    return _bloom.amp;
}

export function bloomCurve(u) {
    u = clamp01(u);
    return bloomShape(u, bloomAmp());
}

// ---------------------------------------------------------------------------------------------------------
// Context: everything that does not change while one drip runs.
//   geom = {pill: {x, y, w, h, keep}, pieces: [{id, x, y, w, h, r, row}]}   (x, y = top-left, w, h = full sizes)
// Returns the precomputed frame function inputs.
export function buildContext(geom) {
    const pill = geom.pill;
    const ph = pill.h;
    const pieces = geom.pieces.map(p => ({...p}));
    // the cluster rectangle
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pieces) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + p.w);
        y1 = Math.max(y1, p.y + p.h);
    }
    if (pieces.length === 0) {
        x0 = pill.x;
        x1 = pill.x + pill.w;
        y0 = pill.y + pill.h + 8;
        y1 = y0 + 8;
    }
    const R = {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
    // the drop at pinch-off: a rounded box hanging from the cluster's top edge
    const dw = clamp(R.w * DRIP.dropEndW, DRIP.dropEndWMin * ph, DRIP.dropEndWMax * ph);
    const dh = clamp(R.h * DRIP.dropEndH, DRIP.dropEndHMin * ph, DRIP.dropEndHMax * ph);
    const dropHw = Math.min(dw, R.w) / 2;
    const dropHh = Math.min(dh, Math.max(R.h * 0.9, 1)) / 2;
    // where the drop lands: under the pill, kept inside the cluster
    const pillCx = pill.x + pill.w / 2;
    const px = clamp(pillCx, R.x + dropHw, R.x + R.w - dropHw);
    const pillBottom = pill.y + pill.h;
    const dropTopEnd = Math.max(R.y, pillBottom + DRIP.minGap * ph);
    const bulbCx = clamp(pillCx, pill.x + pill.w * 0.3, pill.x + pill.w * 0.7);
    // the thread hangs from a point inside the pill and must end inside the drop
    const threadX = clamp(bulbCx, px - dropHw * 0.8, px + dropHw * 0.8);
    // rows -> delays
    const maxRow = pieces.reduce((m, p) => Math.max(m, p.row ?? 0), 0);
    const multi = pieces.length > 1;
    let rowDelay = multi ? DRIP.rowDelayMs : 0;
    if (multi && maxRow > 0)
        rowDelay = Math.min(rowDelay, (DRIP.multiMaxMs - DRIP.openMs) / maxRow);
    const bloomMs = DRIP.openMs - DRIP.pinchMs;
    const delays = pieces.map(p => (p.row ?? 0) * rowDelay);
    const totalMs = DRIP.openMs + (multi ? maxRow * rowDelay : 0);
    return {geom, pill, ph, pieces, R, dropHw, dropHh, px, dropTopEnd, pillBottom, bulbCx, threadX, delays, bloomMs,
        totalMs, multi, rowDelay};
}

// The first bulb and the drop at pinch-off share one parametrization: centre, half sizes, round.
function dropAt(ctx, tau) {
    const {ph, pill, bulbCx, px, dropTopEnd, dropHw, dropHh, pillBottom} = ctx;
    const pillCy = pill.y + pill.h / 2;
    // pull: 0 .. pullEndMs, a point inside the pill grows into the bulb that hangs below it
    const pu = easeOutCubic(tau / DRIP.pullEndMs);
    const bulbHw = DRIP.bulbHw * ph;
    const bulbHh = DRIP.bulbHh * ph;
    const bulbCy = pillBottom + DRIP.bulbBelow * ph;
    if (tau <= DRIP.pullEndMs) {
        return {x: bulbCx, y: lerp(pillCy, bulbCy, pu), w: bulbHw * pu, h: bulbHh * pu,
            r: Math.min(bulbHw, bulbHh) * pu};
    }
    // travel: pullEndMs .. pinchMs, the bulb swells and slides to the landing point
    const s = tau >= DRIP.pinchMs ? 1 : easeInOutCubic((tau - DRIP.pullEndMs) / (DRIP.pinchMs - DRIP.pullEndMs));
    const endCy = dropTopEnd + dropHh;
    const w = lerp(bulbHw, dropHw, s);
    const h = lerp(bulbHh, dropHh, s);
    return {x: lerp(bulbCx, px, s), y: lerp(bulbCy, endCy, s), w, h, r: Math.min(w, h)};
}

function softness(tau, ph, multi, totalMs) {
    if (tau <= 0)
        return DRIP.k0;
    const split = multi ? DRIP.kSplit * ph : DRIP.k0;
    const peak = DRIP.kPeak * ph;
    if (tau <= DRIP.kPeakAtMs)
        return lerp(DRIP.k0, peak, easeOutCubic(tau / DRIP.kPeakAtMs));
    if (tau >= DRIP.kEndMs)
        return lerp(split, DRIP.k0, smoothstep(totalMs - DRIP.kSplitEndMs, totalMs - 20, tau));
    // fall quickly (a snap), faster than it rose
    return lerp(peak, split, smoothstep(DRIP.kPeakAtMs, DRIP.kEndMs, tau));
}

// Content alpha for a piece at tau (open direction): ramps between contentStartMs and contentEndMs (+ its delay).
export function contentAlphaOpen(tau, delay) {
    return smoothstep(DRIP.contentStartMs + delay, DRIP.contentEndMs + delay, tau);
}

// Fully evaluated frame at open-timeline position tau.
// The pieces that have not started to bloom yet are zero-size points at the drop's centre, except the
// "carrier": the piece that starts last carries the drop itself, so before and during the cascade there is
// exactly one drop (stacking identical shapes would swell the smooth union by up to k).
export function frameAt(ctx, tau) {
    const {ph, pill, pieces, delays, bloomMs} = ctx;
    const t = Math.max(0, tau);
    const drop = dropAt(ctx, Math.min(t, DRIP.pinchMs));
    const shapes = [];
    // 0: pill, with the rebound after pinch-off and (keep = false) the shrink-away after it
    const reb = t <= DRIP.pinchMs ? 0
        : DRIP.pillRebound * Math.sin(Math.PI * clamp01((t - DRIP.pinchMs) / DRIP.pillReboundMs));
    const pillScale = 1 + reb;
    let pillHw = pill.w / 2 * pillScale;
    let pillHh = pill.h / 2 * pillScale;
    if (!pill.keep) {
        // no highlight of its own: the pill narrows to a circle, then the circle shrinks away
        const f = smoothstep(DRIP.pinchMs + DRIP.pillReboundMs, DRIP.pinchMs + DRIP.pillReboundMs + DRIP.pillFadeMs, t);
        const a = clamp01(f / 0.55);
        const b = clamp01((f - 0.55) / 0.45);
        pillHw = lerp(pillHw, pillHh, easeInOutQuad(a)) * (1 - b);
        pillHh = pillHh * (1 - b);
    }
    shapes.push({x: pill.x + pill.w / 2, y: pill.y + pill.h / 2, w: pillHw, h: pillHh, r: Math.min(pillHw, pillHh)});
    // 1: thread, from inside the pill down into the drop; thins and breaks
    let thread = {x: drop.x, y: drop.y, w: 0, h: 0, r: 0};
    if (t > 0 && t < DRIP.threadBreakMs) {
        const tw = t <= DRIP.pullEndMs
            ? DRIP.threadHw0 * ph * easeOutCubic(t / DRIP.pullEndMs)
            : lerp(DRIP.threadHw0, DRIP.threadHw1, smoothstep(DRIP.pullEndMs, DRIP.threadBreakMs, t)) * ph;
        const topY = pill.y + pill.h * 0.5;
        const botY = drop.y;
        if (botY > topY && tw > 0.05)
            thread = {x: ctx.threadX, y: (topY + botY) / 2, w: tw, h: (botY - topY) / 2, r: tw};
    }
    shapes.push(thread);
    // 2..: pieces
    const outPieces = [];
    const dropFinal = dropAt(ctx, DRIP.pinchMs);
    const dropBox = {l: dropFinal.x - dropFinal.w, r: dropFinal.x + dropFinal.w, t: dropFinal.y - dropFinal.h, b: dropFinal.y + dropFinal.h};
    let carrier = 0;
    for (let i = 0; i < pieces.length; i++) {
        if (delays[i] >= delays[carrier])
            carrier = i;
    }
    let doneCount = 0;
    for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        const d = delays[i];
        const u = (t - DRIP.pinchMs - d) / bloomMs;
        let shape;
        let e = 0;
        if (t <= DRIP.pinchMs || u <= 0) {
            shape = i === carrier ? {...drop} : {x: drop.x, y: drop.y, w: 0, h: 0, r: 0};
        } else {
            e = bloomCurve(u);
            const l = lerp(dropBox.l, p.x, e);
            const r = lerp(dropBox.r, p.x + p.w, e);
            const tp = lerp(dropBox.t, p.y, e);
            const b = lerp(dropBox.b, p.y + p.h, e);
            const hw = Math.max(0, (r - l) / 2);
            const hh = Math.max(0, (b - tp) / 2);
            const rad = Math.min(lerp(Math.min(dropFinal.w, dropFinal.h), p.r, e), hw, hh);
            shape = {x: (l + r) / 2, y: (tp + b) / 2, w: hw, h: hh, r: Math.max(0, rad)};
        }
        const done = u >= 1;
        if (done)
            doneCount++;
        // the content clip: the piece's rectangle, shrunk so that every pixel of it is inside the rounded shape
        // (a piece that has not left the drop yet shows no content at all)
        const started = t > DRIP.pinchMs && u > 0;
        const inset = DRIP.clipInset + 0.2929 * shape.r;
        const clip = started ? {x: shape.x - shape.w + inset, y: shape.y - shape.h + inset,
            w: Math.max(0, 2 * shape.w - 2 * inset), h: Math.max(0, 2 * shape.h - 2 * inset)} : null;
        outPieces.push({id: p.id, shape, e, done, started, contentAlpha: contentAlphaOpen(t, d), clip, bloomU: clamp01(u)});
        shapes.push(shape);
    }
    const fieldAlpha = smoothstep(0, DRIP.fieldFadeInMs, t);
    return {tau: t, shapes, k: softness(t, ph, ctx.multi, ctx.totalMs), fieldAlpha, pieces: outPieces,
        allDone: pieces.length > 0 && doneCount === pieces.length, pinched: t >= DRIP.pinchMs, drop, carrier};
}

// ---------------------------------------------------------------------------------------------------------
// Playback state machine (pure, driven by a clock in ms): one `tau` position with a direction.
//   open():  tau runs forward at 1x from its current value to totalMs
//   close(): tau runs back to 0 over closeMs * clamp(tau / openMs) (ease in-out), content fades in contentOutMs
// The class holds no GI objects; the controller feeds it the clock.
export class DripClock {
    constructor(totalMs) {
        this.totalMs = totalMs;
        this.tau = 0;
        this.mode = 'idle';     // 'idle' | 'opening' | 'closing'
        this._t0 = 0;
        this._tau0 = 0;
        this._closeMs = 0;
        this._contentAtClose = 1;
        this._speed = 1;
        this.content = 0;       // content alpha ceiling state (closing only)
    }

    setTotal(ms) {
        this.totalMs = ms;
    }

    open(now) {
        this._tau0 = this.tau;
        this._t0 = now;
        this.mode = 'opening';
    }

    // scale: 1 for a normal close, DRIP.switchCloseScale when another pop-out takes over
    close(now, scale = 1, contentNow = 1) {
        this._tau0 = this.tau;
        this._t0 = now;
        this._closeMs = Math.max(1, DRIP.closeMs * Math.max(DRIP.closeMinFraction, Math.min(1, this.tau / DRIP.openMs)) * scale);
        this._contentAtClose = contentNow;
        this._contentOutMs = Math.max(1, DRIP.contentOutMs * scale);
        this.mode = 'closing';
    }

    // advance to clock time `now`; returns {tau, finished}
    update(now) {
        if (this.mode === 'opening') {
            const tau = this._tau0 + (now - this._t0);
            if (tau >= this.totalMs) {
                this.tau = this.totalMs;
                this.mode = 'idle';
                return {tau: this.tau, finished: 'open'};
            }
            this.tau = tau;
            return {tau, finished: null};
        }
        if (this.mode === 'closing') {
            const p = (now - this._t0) / this._closeMs;
            if (p >= 1) {
                this.tau = 0;
                this.mode = 'idle';
                return {tau: 0, finished: 'close'};
            }
            this.tau = this._tau0 * (1 - easeInOutQuad(p));
            return {tau: this.tau, finished: null};
        }
        return {tau: this.tau, finished: null};
    }

    // Closing: the content ceiling at `now` (linear fade-out from what it was when the close started).
    contentCeiling(now) {
        if (this.mode !== 'closing')
            return 1;
        return this._contentAtClose * (1 - clamp01((now - this._t0) / this._contentOutMs));
    }
}

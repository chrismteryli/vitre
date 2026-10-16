/* "Liquid drip" motion (plan A17), as pure functions of time. No GI imports: node loads this file for the
 * unit tests (rig/work/rp-a17-fix/tests) and the CPU design preview (tools/mot.mjs); the shell loads the same file.
 *
 * ONE clear-glass shape, rendered as a signed-distance field (smooth minimum of rounded boxes):
 *   shape 0   the source pill (the top-bar item highlight)
 *   shape 1   the thread: a thin box hanging from the pill into the drop (the neck)
 *   shape 2   single-piece surfaces: the piece itself (the drop that blooms into the panel)
 *             multi-piece surfaces: the BLOB (the drop that blooms into one blob covering the whole cluster, then
 *             retreats from the top down and leaves the pieces behind)
 *   shape 3.. (multi-piece only) the pieces: every Control Center module / Notification Center card at its final
 *             rectangle. They appear the instant the blob covers them (nothing changes on screen) and are separated
 *             by the blob's retreat: the blob is convex and the pieces never move, so a gap is never enclosed (no
 *             pockets or islands), and the gaps open as the blob's dome edge sweeps through the channels.
 *
 * This is Vitre's own design (the reference design has nothing like it): none of these numbers is measured from the reference.
 * Every constant is in the DRIP table below so it can be retuned in one place. All times are ms of the "open
 * timeline" tau (0 = the pill alone, totalMs = at rest). Close plays the open timeline BACKWARDS (tau goes from
 * where it is to 0) through a time warp that spends the close's time where the picture changes (DripClock), so a
 * reversal mid-flight is continuous by construction.
 *
 * Coordinates: stage logical px, y down. A shape is {x, y, w, h, r}: centre, HALF sizes, corner radius.
 */

export const DRIP = {
    // ---- timeline (ms) ----------------------------------------------------------------------------
    openMs: 360,            // single-piece open timeline length (plan: ~360 ms)
    pullEndMs: 110,         // 0..110   the pill's bottom edge pulls down into a drop, a neck forms
    pinchMs: 230,           // 110..230 the drop travels to the panel's top-centre and swells; 230 = pinch-off
    closeMs: 240,           // close, from fully open (plan: ~240 ms); a close from tau < total is proportionally shorter
    closeMinFraction: 0.30, // ... but never shorter than this fraction of closeMs
    closeNubShare: 0.03,    // share of the close spent on the first 110 ms of tau (the pill's nub: barely visible)
    closeDropShare: 0.19,   // share spent retracting the drop (tau 110..230)
    closeRetreatShare: 0.38, // multi-piece: share spent on the blob's retreat (merging the pieces); the rest is the blob's collapse
    warpBlendMs: 130,       // the close's time warp blends its phases over this much tau (no jump in the retraction's speed)
    closeStartSpeed: 0.45,  // close starts / ends at this fraction of its average speed (the shape is not still while the content fades)
    contentOutMs: 80,       // close: content fades out in the first 80 ms
    switchCloseScale: 0.8,  // close while another top-bar pop-out opens: 0.8 x the duration (plan: 0.7; slower so the old surface is still there)
    switchOpenSpeed: 1.5,   // ... and the pop-out that opens in its place plays this much faster (at 1x its drop travelled for 130 ms with the old one gone)
    contentStartMs: 220,    // open: content alpha 0 -> 1 between these two times (it is also cut by the glass)
    contentEndMs: 360,
    fieldFadeInMs: 28,      // the field's glass fades in over the pill during the first ms (the CSS highlight is already on)
    // ---- multi-piece (Control Center modules, Notification Center cards) -----------------------------
    blobMs: 128,            // the blob blooms from the drop to the whole cluster over this long (single pieces: openMs - pinchMs)
    blobMargin: 3,          // the blob covers the cluster rectangle grown by this much: where its edge and a piece's edge are
                            // within the softness of each other the union swells (k/4), so the two must not coincide
    blobHoldMs: 4,          // the retreat starts this long after the blob has covered the cluster
    retreatMs: 128,         // the blob's retreat from the cluster's top edge down to the last row's centre line
    retreatEase: 0.55,      // the dome's start speed (fraction of its average) ...
    retreatEaseEnd: 0.28,   // ... and its end speed (the last row's bar thins slowly, over a few frames, before it breaks)
    domeFrac: 0.30,         // ... and how fast it rounds into a dome (fraction of the retreat)
    blobEndHw: 26,          // the blob is never wider (half width) than its half height plus this: it ends as a bar of this half length
    blobMinHh: 1.1,         // the blob's last thread breaks (it is removed) when its half thickness is below this
    blobRadius: 22,         // the blob's corner radius while it covers the cluster
    multiMaxMs: 450,        // the multi-piece motion (the drop to the last row's thread) is at most this long; the hand-over tail follows
    // ---- bloom --------------------------------------------------------------------------------------
    bloomOvershoot: 0.017,  // far edges overshoot the final rectangle by this fraction, then settle (the VitreSearch split's +1.7 %)
    bloomPeakAt: 0.72,      // where in the bloom (0..1) the overshoot peaks
    bloomStart: 0.20,       // default start speed of the bloom curve, fraction of its average (each surface computes its own)
    // ---- pill ---------------------------------------------------------------------------------------
    pillRebound: 0.015,     // after pinch-off the pill springs back +1.5 % (size) and settles
    pillReboundMs: 70,
    pillFadeDelayMs: 21,    // a pill with no highlight of its own (keep = false) starts to go away this long after the pinch-off ...
    pillFadeMs: 24,         // ... and is gone this fast (its bottom edge sweeps up through the clock's text in about one frame at 120 Hz: at 46 ms
                            // it was a bright flat sliver across the text for 3 to 4 frames)
    pillGoneHh: 4.0,        // ... and is removed when its half height is below this (px): thinner than that it is a hairline, not glass
    // ---- drop and neck (relative to the pill height ph) ------------------------------------------
    k0: 3,                  // smooth-union softness at rest (px): no blending between shapes more than this apart
    kPeak: 1.05,            // softness at the neck's longest, x ph
    kPeakAtMs: 150,
    kEndMs: 232,            // the neck's softness has fallen back to k0 here (a thread of a few px before the break)
    kSplit: 0.42,           // multi-piece only: softness while the blob retreats (fillets the notches), x ph
    bulbHw: 0.5,            // half width of the first bulb, x ph (t = pullEndMs)
    bulbHh: 0.68,           // half height of the first bulb, x ph
    bulbBornLow: 0.30,      // the bulb starts this far (x ph) below the pill's centre
    bulbBelow: 0.46,        // the bulb's centre hangs this far (x ph) below the pill's bottom edge at pullEndMs
    threadHw0: 0.45,        // thread half width, x ph, at its thickest (t = pullEndMs)
    threadThinMs: 176,      // the thread starts to thin here ...
    threadBreakMs: 232,     // ... and its half width reaches 0 here (the pinch-off)
    threadThinPow: 1.6,     // thinning curve exponent (slow, then fast)
    dropEndW: 0.34,         // the drop at pinch-off: width = this x panel width ...
    dropEndWMin: 3.2,       // ... clamped to [min, max] x ph
    dropEndWMax: 5.2,
    dropEndH: 0.30,         // ... height = this x panel height
    dropEndHMin: 2.0,
    dropEndHMax: 3.0,
    minGap: 0.9,            // the drop's top edge never starts closer than this x ph below the pill's bottom edge
    // ---- glass finishes (field), chosen per surface by the caller; see GLASS_FINISHES -----------------
    handoffMs: 40,          // surfaces whose real glass differs from the field's (menus, Control Center, Notification Center) crossfade over
                            // this long AFTER the geometry is done: the real glass fades in and then the field fades out (no step at the end)
    dropBoost: 0.25,        // the drop's glass finish (tint and rim) is this much stronger (x 1 + boost) while it is a drop: on a dark wall
    dropBoostFadeMs: 110,   // ... it is otherwise a hairline; the boost is gone this long after the pinch-off (the finished surface is untouched)
    // ---- measurement helpers ----------------------------------------------------------------------
    clipInset: 1,           // content is clipped to the piece's rectangle shrunk by this + 0.3 x radius
};

// B21 (2026-10-15, from the morph lab: he chose the fluid stretch): 'stretch' = the button's glass stretches into the
// surface on one spring and never detaches (STRETCH below); 'drip' = the drop above. Both feed the same controller and field.
export const STYLE = {name: 'stretch'};
export const STRETCH = {
    responseMs: 400,    // spring period (ms) ...
    damping: 0.86,      // ... and damping ratio: a ~1 % overshoot that settles
    lagMs: 34,          // the edge nearest the button follows the far edges by this much (the glass is pulled, not scaled)
    staggerPerPx: 0.12, // multi-piece: a tile this many ms later per px from the button (the glass pours into nearer tiles first)
    staggerMaxMs: 70,
    fromW: 0.6,         // the glass leaves from this much of the button's width ...
    fromH: 0.5,         // ... and height, at its bottom centre
    kStart: 1.1,        // union softness with the button at the start, x its height; melts to k0 as the glass arrives
    contentFrom: 0.45,  // content fades in from this far along
    settle: 0.004,      // the spring is done when within this of its target for good
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

// cubic Hermite between (t0, v0, slope d0) and (t1, v1, slope d1); slopes per ms
function hermite(t, t0, t1, v0, v1, d0, d1) {
    const h = t1 - t0;
    const s = clamp01((t - t0) / h);
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * h * d0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * h * d1;
}

// Three knots (tau 0, pullEnd, pinch) through values v = [v0, v1, v2], monotone, with the speed continuous at
// the middle knot (no stop between the pull and the travel): the interior slope is the harmonic mean of the two
// secants (Fritsch-Carlson), the end slopes are c0 x the first secant and c2 x the second secant.
function spline3(t, t0, t1, t2, v0, v1, v2, c0, c2) {
    const s1 = (v1 - v0) / (t1 - t0);
    const s2 = (v2 - v1) / (t2 - t1);
    let d1 = 0;
    if (s1 * s2 > 0) {
        const w1 = 2 * (t2 - t1) + (t1 - t0);
        const w2 = (t2 - t1) + 2 * (t1 - t0);
        d1 = (w1 + w2) / (w1 / s1 + w2 / s2);
    }
    const d0 = c0 * s1;
    const d2 = c2 * s2;
    if (t <= t1)
        return hermite(t, t0, t1, v0, v1, d0, d1);
    return hermite(t, t1, t2, v1, v2, d1, d2);
}

// ---------------------------------------------------------------------------------------------------------
// Bloom curve E(u), u in [0, 1] over the bloom of one piece (or of the blob): 0 -> 1 with a small overshoot that
// settles. base = ease-out cubic of a warped time that starts at e0 of its average speed (e0 is chosen per surface so
// that the bloom continues the drop's own speed at pinch-off instead of starting from a standstill or from a kick);
// bump = A * sin^2 over the last part of the curve, A chosen so the peak is exactly 1 + bloomOvershoot.
// E(0) = 0, E'(0) = e0, E(1) = 1, E'(1) = 0.
const _blooms = new Map();
function makeBloom(e0) {
    // the start speed is kept to 0.01 (invisible), so menus of similar sizes share one curve and the fit runs rarely
    e0 = Math.round(e0 * 100) / 100;
    const key = `${DRIP.bloomOvershoot}|${DRIP.bloomPeakAt}|${Math.round(e0 * 100)}`;
    const hit = _blooms.get(key);
    if (hit)
        return hit;
    const a = e0 / 3;
    const base = u => easeOutCubic(a * u + (1 - a) * u * u * u * (u * (6 * u - 15) + 10));
    const lo = Math.max(0, 2 * DRIP.bloomPeakAt - 1);   // the sin^2 bump spans [lo, 1] and peaks near `bloomPeakAt`
    const shape = (u, amp) => {
        const v = clamp01((u - lo) / (1 - lo));
        return base(u) + amp * (u <= lo ? 0 : Math.pow(Math.sin(Math.PI * v), 2));
    };
    // the curve's maximum for an amplitude: it lies in the bump's span [lo, 1]; a coarse scan, then a golden-section refine
    // around the best sample (B19: the full 301-sample scan per step cost a few ms the first time each menu size opened, a
    // dropped frame at the very start of the drip; this finds the same peak to < 1e-6 with ~1/6 of the evaluations)
    const peakOf = amp => {
        const N = 40;
        let bu = lo;
        let bv = -Infinity;
        for (let j = 0; j <= N; j++) {
            const u = lo + (1 - lo) * j / N;
            const v = shape(u, amp);
            if (v > bv) {
                bv = v;
                bu = u;
            }
        }
        let a = Math.max(lo, bu - (1 - lo) / N);
        let b = Math.min(1, bu + (1 - lo) / N);
        const g = (Math.sqrt(5) - 1) / 2;
        let c = b - g * (b - a);
        let d = a + g * (b - a);
        let fc = shape(c, amp);
        let fd = shape(d, amp);
        for (let k = 0; k < 24; k++) {
            if (fc > fd) {
                b = d;
                d = c;
                fd = fc;
                c = b - g * (b - a);
                fc = shape(c, amp);
            } else {
                a = c;
                c = d;
                fc = fd;
                d = a + g * (b - a);
                fd = shape(d, amp);
            }
        }
        return Math.max(bv, fc, fd, shape(1, amp));
    };
    let alo = 0;
    let ahi = 1;
    for (let i = 0; i < 30; i++) {
        const mid = (alo + ahi) / 2;
        if (peakOf(mid) < 1 + DRIP.bloomOvershoot)
            alo = mid;
        else
            ahi = mid;
    }
    const amp = (alo + ahi) / 2;
    const E = u => shape(clamp01(u), amp);
    let rlo = 0;
    let rhi = DRIP.bloomPeakAt;
    for (let i = 0; i < 40; i++) {
        const mid = (rlo + rhi) / 2;
        if (E(mid) < 1)
            rlo = mid;
        else
            rhi = mid;
    }
    const bloom = {E, reach: rhi, e0};
    _blooms.set(key, bloom);
    return bloom;
}

export function bloomCurve(u, e0 = DRIP.bloomStart) {
    return makeBloom(e0).E(u);
}

// ---------------------------------------------------------------------------------------------------------
function sdBox(px, py, s) {
    const qx = Math.abs(px - s.x) - (s.w - s.r);
    const qy = Math.abs(py - s.y) - (s.h - s.r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r;
}

// points on a rounded rectangle's outline (edge midpoints and corner-arc midpoints), pushed out by `off` px
function ringPoints(p, off) {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    const hw = p.w / 2;
    const hh = p.h / 2;
    const r = Math.min(p.r, hw, hh);
    const c = r * (1 - Math.SQRT1_2);
    const pts = [[cx, p.y - off], [cx, p.y + p.h + off], [p.x - off, cy], [p.x + p.w + off, cy]];
    const o = off * Math.SQRT1_2;
    pts.push([p.x + c - o, p.y + c - o], [p.x + p.w - c + o, p.y + c - o], [p.x + c - o, p.y + p.h - c + o], [p.x + p.w - c + o, p.y + p.h - c + o]);
    // quarter points along the long edges
    pts.push([p.x + hw * 0.5, p.y - off], [p.x + hw * 1.5, p.y - off], [p.x + hw * 0.5, p.y + p.h + off], [p.x + hw * 1.5, p.y + p.h + off]);
    return pts;
}

// ---------------------------------------------------------------------------------------------------------
// Context: everything that does not change while one drip runs.
//   geom = {pill: {x, y, w, h, keep}, pieces: [{id, x, y, w, h, r, row}]}   (x, y = top-left, w, h = full sizes)
// Returns the precomputed frame function inputs.
export function buildContext(geom, handoffMs = 0) {
    if (STYLE.name === 'stretch')
        return buildStretch(geom, handoffMs);
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
    const multi = pieces.length > 1;
    const ctx = {geom, pill, ph, pieces, R, dropHw, dropHh, px, dropTopEnd, pillBottom, bulbCx, threadX, multi, handoffMs,
        pieceOffset: multi ? 3 : 2, nShapes: pieces.length + (multi ? 3 : 2)};
    ctx.dropFinal = dropAt(ctx, DRIP.pinchMs);
    ctx.bloomMs = multi ? DRIP.blobMs : DRIP.openMs - DRIP.pinchMs;
    // the bloom starts at the speed the drop's bottom edge has at pinch-off (px per ms): E'(0) = v x bloomMs / travel
    {
        const d1 = ctx.dropFinal;
        const d0 = dropAt(ctx, DRIP.pinchMs - 2);
        const vBottom = Math.max(0, ((d1.y + d1.h) - (d0.y + d0.h)) / 2);
        const target = multi ? R.y + R.h + DRIP.blobMargin : R.y + R.h;
        const travel = Math.max(1, target - (d1.y + d1.h));
        ctx.e0 = clamp(vBottom * ctx.bloomMs / travel, 0.06, 0.7);
    }
    ctx.bloom = makeBloom(ctx.e0);
    if (!multi) {
        ctx.delays = pieces.map(() => 0);
        ctx.totalMs = DRIP.openMs;
        ctx.doneAt = pieces.map(() => DRIP.openMs);
        ctx.appearAt = pieces.map(() => DRIP.pinchMs);
        ctx.clockMs = ctx.totalMs + handoffMs;
        ctx.warp = makeWarp(handoffSegments([[DRIP.pullEndMs, DRIP.closeNubShare], [DRIP.pinchMs, DRIP.closeDropShare],
            [DRIP.openMs, 1 - DRIP.closeNubShare - DRIP.closeDropShare]], ctx.totalMs, handoffMs));
        return ctx;
    }
    // ---- multi-piece: the blob and its retreat ----------------------------------------------------------------
    ctx.reach = ctx.bloom.reach;
    const m = DRIP.blobMargin;
    ctx.RB = {x: R.x - m, y: R.y - m, w: R.w + 2 * m, h: R.h + 2 * m};
    ctx.rB0 = Math.min(DRIP.blobRadius, ...pieces.map(p => Math.min(p.r, p.w / 2, p.h / 2)));
    // the last row: pieces whose bottom edge is within 4 px of the cluster's bottom; the retreat ends on their centre line
    const last = pieces.filter(p => p.y + p.h >= y1 - 4);
    ctx.cyLast = last.reduce((a, p) => a + p.y + p.h / 2, 0) / last.length;
    ctx.lastTop = Math.min(...last.map(p => p.y));
    ctx.cx = R.x + R.w / 2;
    // a last row that does not span the cluster (Notification Center: the weather widget alone, at the left): the blob's
    // remnant ends on it, not in the empty space next to it
    ctx.cxLast = (Math.min(...last.map(p => p.x)) + Math.max(...last.map(p => p.x + p.w))) / 2;
    ctx.tR0 = DRIP.pinchMs + DRIP.blobMs * ctx.reach + DRIP.blobHoldMs;
    ctx.retreatMs = Math.min(DRIP.retreatMs, DRIP.multiMaxMs - ctx.tR0);       // the hand-over tail comes after the motion
    ctx.tR1 = ctx.tR0 + ctx.retreatMs;
    ctx.totalMs = ctx.tR1;
    // when does the apex pass each part of the cluster: precompute, per piece, the time its surroundings are free of the blob
    // (the surface's own glass takes over then), and the time the blob first covers it (it appears then)
    const step = 1;
    ctx.appearAt = pieces.map(() => ctx.tR0);
    ctx.doneAt = pieces.map(() => ctx.tR1);
    const rings = pieces.map(p => ringPoints(p, 0));
    const outs = pieces.map(p => ringPoints(p, 6));
    const appearDone = pieces.map(() => false);
    const doneDone = pieces.map(() => false);
    for (let t = DRIP.pinchMs; t <= ctx.tR1 + 0.001; t += step) {
        const b = blobAt(ctx, t);
        if (!b)
            continue;
        for (let i = 0; i < pieces.length; i++) {
            if (!appearDone[i] && rings[i].every(([x, y]) => sdBox(x, y, b) <= 0.35)) {
                appearDone[i] = true;
                ctx.appearAt[i] = t;
            }
            if (t >= ctx.tR0 && !doneDone[i] && outs[i].every(([x, y]) => sdBox(x, y, b) >= 0.5)) {
                doneDone[i] = true;
                ctx.doneAt[i] = t;
            }
        }
    }
    for (let i = 0; i < pieces.length; i++) {
        if (!appearDone[i])
            ctx.appearAt[i] = ctx.tR0;
        if (!doneDone[i])
            ctx.doneAt[i] = ctx.tR1;
        ctx.doneAt[i] = Math.min(ctx.doneAt[i], ctx.tR1);
    }
    const firstDone = Math.min(...ctx.doneAt);
    ctx.delays = ctx.doneAt.map(t => clamp((t - firstDone) * 0.45, 0, 60));
    const blobTau = ctx.tR0 - DRIP.pinchMs;
    ctx.clockMs = ctx.totalMs + handoffMs;
    ctx.warp = makeWarp(handoffSegments([
        [DRIP.pullEndMs, DRIP.closeNubShare],
        [DRIP.pinchMs, DRIP.closeDropShare],
        [ctx.tR0, 1 - DRIP.closeNubShare - DRIP.closeDropShare - DRIP.closeRetreatShare],
        [ctx.tR1, DRIP.closeRetreatShare]], ctx.totalMs, handoffMs));
    ctx.blobTau = blobTau;
    return ctx;
}

// the hand-over tail (the surface's own glass fading in after the geometry is done) is traversed at the very start of a close
function handoffSegments(segments, totalMs, handoffMs) {
    if (handoffMs <= 0)
        return segments;
    const share = clamp(handoffMs / DRIP.closeMs, 0, 0.2);
    return [...segments.map(([end, s]) => [end, s * (1 - share)]), [totalMs + handoffMs, share]];
}

// Time warp for the close: segments [[tauEnd, share of the close time], ...] (ascending tau). W(tau) is the share of the
// close that remains when the shape is at `tau`; the close clock moves W from W(tau0) to 0. The rate (close time per ms of
// tau) is piecewise constant in the segments and blended across each boundary over DRIP.warpBlendMs, so the picture's speed
// never jumps where two phases meet (a jump there shows as a hitch in the retraction).
function makeWarp(segments) {
    const STEP = 0.5;
    const edges = [0, ...segments.map(s => s[0])];
    const rates = segments.map((s, i) => s[1] / (s[0] - edges[i]));
    const end = edges[edges.length - 1];
    const h = DRIP.warpBlendMs / 2;
    const n = Math.ceil(end / STEP);
    const table = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 1; i <= n; i++) {
        const t = (i - 0.5) * STEP;
        let r = rates[0];
        for (let k = 1; k < rates.length; k++)
            r += (rates[k] - rates[k - 1]) * smoothstep(edges[k] - h, edges[k] + h, t);
        acc += r * STEP;
        table[i] = acc;
    }
    const total = acc;
    for (let i = 0; i <= n; i++)
        table[i] /= total;
    const W = tau => {
        if (tau <= 0)
            return 0;
        if (tau >= end)
            return 1;
        const f = tau / STEP;
        const i = Math.floor(f);
        return table[i] + (table[i + 1] - table[i]) * (f - i);
    };
    const inv = w => {
        if (w <= 0)
            return 0;
        if (w >= 1)
            return end;
        let lo = 0;
        let hi = n;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (table[mid] < w)
                lo = mid;
            else
                hi = mid;
        }
        const f = (w - table[lo]) / Math.max(1e-12, table[hi] - table[lo]);
        return (lo + f) * STEP;
    };
    return {W, inv, total: 1};
}

// The first bulb and the drop at pinch-off share one parametrization: centre, half sizes, round. Everything is a
// monotone spline through the bulb at pullEndMs, with the speed continuous there and speeding up into the pinch
// (the drop falls the way a drop does), so the drop never stands still between the pull and the travel.
function dropAt(ctx, tau) {
    const {ph, pill, bulbCx, px, dropTopEnd, dropHw, dropHh, pillBottom} = ctx;
    const pillCy = pill.y + pill.h / 2;
    const t = clamp(tau, 0, DRIP.pinchMs);
    const t1 = DRIP.pullEndMs;
    const t2 = DRIP.pinchMs;
    const bulbHw = DRIP.bulbHw * ph;
    const bulbHh = DRIP.bulbHh * ph;
    const bulbCy = pillBottom + DRIP.bulbBelow * ph;
    const endCy = dropTopEnd + dropHh;
    const w = spline3(t, 0, t1, t2, 0, bulbHw, dropHw, 1.6, 1.1);
    const h = spline3(t, 0, t1, t2, 0, bulbHh, dropHh, 1.9, 1.1);
    // the bulb is born low in the pill, so that its bottom edge is out of the pill within the first frames
    const y = spline3(t, 0, t1, t2, pillCy + DRIP.bulbBornLow * ph, bulbCy, endCy, 0.9, 1.5);
    const x = spline3(t, 0, t1, t2, bulbCx, lerp(bulbCx, px, 0.22), px, 0.6, 1.2);
    const ww = Math.max(0, w);
    const hh = Math.max(0, h);
    return {x, y, w: ww, h: hh, r: Math.min(ww, hh)};
}

function softness(ctx, tau) {
    const {ph, multi} = ctx;
    if (tau <= 0)
        return DRIP.k0;
    const peak = DRIP.kPeak * ph;
    if (tau <= DRIP.kPeakAtMs)
        return lerp(DRIP.k0, peak, easeOutCubic(tau / DRIP.kPeakAtMs));
    if (tau <= DRIP.kEndMs) {
        // fall quickly (a snap), faster than it rose: the neck is a thread of a few px before it breaks
        const s = smoothstep(DRIP.kPeakAtMs, DRIP.kEndMs, tau);
        return lerp(peak, DRIP.k0, s);
    }
    if (!multi)
        return DRIP.k0;
    // multi-piece: the blob's notches are filleted while it retreats; the last thread breaks cleanly
    const split = DRIP.kSplit * ph;
    const up = smoothstep(DRIP.pinchMs, ctx.tR0, tau);
    const down = smoothstep(ctx.tR1 - 0.12 * ctx.retreatMs, ctx.tR1, tau);
    return lerp(DRIP.k0, split, up) * (1 - down) + DRIP.k0 * down;
}

// Content alpha for a piece at tau (open direction): ramps between contentStartMs and contentEndMs (+ its delay).
export function contentAlphaOpen(tau, delay) {
    return smoothstep(DRIP.contentStartMs + delay, DRIP.contentEndMs + delay, tau);
}

// ---- the blob (multi-piece) ----------------------------------------------------------------------------
// bloom: tau in [pinch, pinch + blobMs] drop box -> cluster rectangle with E(u) (overshoot on the far edges);
// retreat: tau in [tR0, tR1] the dome edge sweeps from the cluster's top down to the last row's centre line, the
// bottom follows it up at the end, the blob thins to a bar and the bar to a thread, and the thread breaks.
function blobAt(ctx, tau) {
    const R = ctx.RB;
    const {dropFinal} = ctx;
    if (tau < DRIP.pinchMs)
        return null;
    const u = clamp01((tau - DRIP.pinchMs) / DRIP.blobMs);
    const e = ctx.bloom.E(u);
    const dl = dropFinal.x - dropFinal.w;
    const dr = dropFinal.x + dropFinal.w;
    const dt = dropFinal.y - dropFinal.h;
    const db = dropFinal.y + dropFinal.h;
    let l = lerp(dl, R.x, e);
    let r = lerp(dr, R.x + R.w, e);
    let t = lerp(dt, R.y, e);
    let b = lerp(db, R.y + R.h, e);
    let rad = lerp(Math.min(dropFinal.w, dropFinal.h), ctx.rB0, e);
    if (tau > ctx.tR0) {
        const rho = clamp01((tau - ctx.tR0) / ctx.retreatMs);
        // apex: starts and ends at retreatEase of its average speed
        const A = hermite(rho, 0, 1, 0, 1, DRIP.retreatEase, DRIP.retreatEaseEnd);
        const cy = ctx.cyLast;
        const topNow = t;
        t = lerp(topNow, cy, A);
        // the bottom edge follows once the apex has passed the last row's top edge
        const rhoB = clamp01((ctx.lastTop - R.y) / Math.max(1, cy - R.y));      // R = the blob's rectangle
        const bs = smoothstep(Math.min(0.97, rhoB * 0.97), 1, A);
        b = lerp(b, cy, bs);
        // half width: never more than blobEndHw longer than the blob is tall (smooth minimum), so the lower part of the retreat is a
        // round blob (short flat edges: no long flat seams as the edge passes a channel) that shrinks toward the last row's centre
        const hwb0 = (r - l) / 2;
        const cap = Math.max(0, (b - t) / 2) + DRIP.blobEndHw;
        const sm = 16;
        const dd = Math.abs(hwb0 - cap);
        const hwb = Math.min(hwb0, cap) - (dd < sm ? (sm - dd) * (sm - dd) / (4 * sm) : 0);
        // the centre drifts to the last row's centre as the blob shrinks (never out of the cluster's rectangle)
        const drift = smoothstep(0.35, 1, A) * clamp01((hwb0 - hwb) / 20);
        const cxb = clamp(lerp((l + r) / 2, ctx.cxLast, drift), R.x + hwb, R.x + R.w - hwb);
        l = cxb - hwb;
        r = cxb + hwb;
        // the dome: the corner radius grows to the half width
        const dome = smoothstep(0, DRIP.domeFrac, rho);
        rad = lerp(rad, (r - l) / 2, dome);
    }
    const hw = Math.max(0, (r - l) / 2);
    const hh = Math.max(0, (b - t) / 2);
    // the last thread of the bar breaks: below a pixel of thickness (or a few px of length) the blob is simply gone, never a dot
    if (hw < 0.5 || hh < DRIP.blobMinHh)
        return {x: (l + r) / 2, y: (t + b) / 2, w: 0, h: 0, r: 0};
    return {x: (l + r) / 2, y: (t + b) / 2, w: hw, h: hh, r: Math.max(0, Math.min(rad, hw, hh))};
}

// The field's share of the picture during the hand-over tail (tau from totalMs to totalMs + handoffMs): 1 while the geometry runs, then
// falling to 0 as the surface's own glass (which is fading in over the same time) takes over. 1 for a surface without a tail.
export function handoffFade(ctx, tau) {
    if (!(ctx.handoffMs > 0) || tau <= ctx.totalMs)
        return 1;
    return 1 - smoothstep(ctx.totalMs, ctx.totalMs + ctx.handoffMs, tau);
}

// How much the drop's finish is lifted at tau (1 = the full DRIP.dropBoost, 0 = the plain finish)
export function dropBoostAt(tau) {
    return 1 - smoothstep(DRIP.pinchMs, DRIP.pinchMs + DRIP.dropBoostFadeMs, tau);
}

// Fully evaluated frame at open-timeline position tau.
export function frameAt(ctx, tau) {
    if (ctx.style === 'stretch')
        return stretchFrameAt(ctx, tau);
    const {ph, pill, pieces} = ctx;
    const t = Math.max(0, tau);
    const drop = dropAt(ctx, Math.min(t, DRIP.pinchMs));
    const shapes = [];
    // 0: pill, with the rebound after pinch-off and (keep = false) the going-away after it
    const reb = t <= DRIP.pinchMs ? 0
        : DRIP.pillRebound * Math.sin(Math.PI * clamp01((t - DRIP.pinchMs) / DRIP.pillReboundMs));
    const pillScale = 1 + reb;
    let pillHw = pill.w / 2 * pillScale;
    let pillHh = pill.h / 2 * pillScale;
    let pillCy = pill.y + pill.h / 2;
    if (!pill.keep) {
        // no highlight of its own: it lifts off and thins out upward, away from the clock's text
        const f = smoothstep(DRIP.pinchMs + DRIP.pillFadeDelayMs, DRIP.pinchMs + DRIP.pillFadeDelayMs + DRIP.pillFadeMs, t);
        pillHh *= 1 - f;
        pillCy -= pill.h * 0.5 * f;
    }
    // a pill that has thinned to under a pixel is simply gone: a zero-height box is not nothing in the field (it is a hairline of
    // full width, a bright line through the clock's text for the rest of the open), so it is parked far away like an unused shape
    shapes.push(!pill.keep && pillHh < DRIP.pillGoneHh
        ? {x: -10000, y: -10000, w: 0, h: 0, r: 0}
        : {x: pill.x + pill.w / 2, y: pillCy, w: pillHw, h: pillHh, r: Math.min(pillHw, pillHh)});
    // 1: thread, from inside the pill down into the drop; thins and breaks
    let thread = {x: drop.x, y: drop.y, w: 0, h: 0, r: 0};
    if (t > 0 && t < DRIP.threadBreakMs) {
        let tw;
        if (t <= DRIP.pullEndMs)
            tw = DRIP.threadHw0 * ph * easeOutCubic(t / DRIP.pullEndMs);
        else if (t <= DRIP.threadThinMs)
            tw = DRIP.threadHw0 * ph;
        else
            tw = DRIP.threadHw0 * ph * Math.pow(1 - clamp01((t - DRIP.threadThinMs) / (DRIP.threadBreakMs - DRIP.threadThinMs)), DRIP.threadThinPow);
        const topY = pill.y + pill.h * 0.5;
        const botY = drop.y;
        if (botY > topY && tw > 0.03)
            thread = {x: ctx.threadX, y: (topY + botY) / 2, w: tw, h: (botY - topY) / 2, r: tw};
    }
    shapes.push(thread);
    const outPieces = [];
    let doneCount = 0;
    if (!ctx.multi) {
        // single piece: the drop blooms into the panel
        const p = pieces[0];
        const u = (t - DRIP.pinchMs) / ctx.bloomMs;
        let shape;
        let e = 0;
        if (t <= DRIP.pinchMs || u <= 0) {
            shape = {...drop};
        } else {
            e = ctx.bloom.E(u);
            const dropFinal = ctx.dropFinal;
            const l = lerp(dropFinal.x - dropFinal.w, p.x, e);
            const r = lerp(dropFinal.x + dropFinal.w, p.x + p.w, e);
            const tp = lerp(dropFinal.y - dropFinal.h, p.y, e);
            const b = lerp(dropFinal.y + dropFinal.h, p.y + p.h, e);
            const hw = Math.max(0, (r - l) / 2);
            const hh = Math.max(0, (b - tp) / 2);
            const rad = Math.min(lerp(Math.min(dropFinal.w, dropFinal.h), p.r, e), hw, hh);
            shape = {x: (l + r) / 2, y: (tp + b) / 2, w: hw, h: hh, r: Math.max(0, rad)};
        }
        const done = u >= 1;
        if (done)
            doneCount++;
        const started = t > DRIP.pinchMs && u > 0;
        outPieces.push({id: p.id, shape, e, done, started, contentAlpha: started ? contentAlphaOpen(t, 0) : 0, clip: null, bloomU: clamp01(u)});
        shapes.push(shape);
    } else {
        // multi-piece: shape 2 is the blob (the drop until pinch-off), then the pieces at their final rectangles
        const blob = t < DRIP.pinchMs ? {...drop} : blobAt(ctx, t);
        shapes.push(blob);
        for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i];
            const started = t >= ctx.appearAt[i];
            const done = t >= ctx.doneAt[i];
            if (done)
                doneCount++;
            const hw = p.w / 2;
            const hh = p.h / 2;
            const shape = started
                ? {x: p.x + hw, y: p.y + hh, w: hw, h: hh, r: Math.min(p.r, hw, hh)}
                : {x: blob.x, y: blob.y, w: 0, h: 0, r: 0};
            // the content ramp is a function of tau alone, not of the piece's start: the blob covers the cluster at tR0 and the pieces
            // start then or later, when the ramp is already well under way (a gate on `started` cut it: 0 -> 0.77 in one frame). The content
            // is cut by the glass (the mask), so it shows through the blob as the blob blooms over the cluster.
            outPieces.push({id: p.id, shape, e: started ? 1 : 0, done, started, contentAlpha: contentAlphaOpen(t, ctx.delays[i]), clip: null,
                bloomU: clamp01((t - ctx.appearAt[i]) / Math.max(1, ctx.doneAt[i] - ctx.appearAt[i]))});
            shapes.push(shape);
        }
    }
    const fieldAlpha = smoothstep(0, DRIP.fieldFadeInMs, t);
    return {tau: t, shapes, k: softness(ctx, t), fieldAlpha, boost: dropBoostAt(t), pieces: outPieces,
        allDone: pieces.length > 0 && doneCount === pieces.length, pinched: t >= DRIP.pinchMs, drop, carrier: ctx.multi ? -1 : 0};
}

// ---------------------------------------------------------------------------------------------------------
// The stretch (STYLE 'stretch'): a damped spring from 0 to 1; t in ms
function springAt(t, responseMs = STRETCH.responseMs, damping = STRETCH.damping) {
    if (t <= 0)
        return 0;
    const w0 = 2 * Math.PI / (responseMs / 1000);
    const ts = t / 1000;
    if (damping >= 1)
        return 1 - Math.exp(-w0 * ts) * (1 + w0 * ts);
    const wd = w0 * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * w0 * ts) * (Math.cos(wd * ts) + damping * w0 / wd * Math.sin(wd * ts));
}

let _springSettleMs = null;
function springSettleMs() {
    if (_springSettleMs === null) {
        let last = 0;
        for (let t = 0; t <= 3000; t += 1) {
            if (Math.abs(1 - springAt(t)) > STRETCH.settle)
                last = t;
        }
        _springSettleMs = last + 1;
    }
    return _springSettleMs;
}

function buildStretch(geom, handoffMs) {
    const pill = geom.pill;
    const ph = pill.h;
    const pieces = geom.pieces.map(p => ({...p}));
    const multi = pieces.length > 1;
    const cx = pill.x + pill.w / 2;
    const by = pill.y + pill.h;
    const stagger = pieces.map(p => multi
        ? Math.min(STRETCH.staggerMaxMs, Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - by) * STRETCH.staggerPerPx) : 0);
    const settle = springSettleMs();
    const doneAt = stagger.map(st => st + STRETCH.lagMs + settle);
    const totalMs = Math.max(...doneAt);
    const ctx = {style: 'stretch', geom, pill, ph, pieces, multi, handoffMs, stagger,
        pieceOffset: multi ? 3 : 2, nShapes: pieces.length + (multi ? 3 : 2),
        from: {x: cx - pill.w * STRETCH.fromW / 2, y: pill.y + pill.h * (1 - STRETCH.fromH) / 2 + pill.h * STRETCH.fromH / 2,
            w: pill.w * STRETCH.fromW, h: pill.h * STRETCH.fromH, r: pill.h * STRETCH.fromH / 2},
        totalMs, doneAt, appearAt: pieces.map(() => 0), delays: pieces.map(() => 0),
        retargetFrom: totalMs * 0.4};
    ctx.clockMs = totalMs + handoffMs;
    ctx.warp = makeWarp(handoffSegments([[totalMs, 1]], totalMs, handoffMs));
    return ctx;
}

function stretchFrameAt(ctx, tau) {
    const {pill, ph, pieces, multi, from} = ctx;
    const t = Math.max(0, tau);
    const empty = {x: -10000, y: -10000, w: 0, h: 0, r: 0};
    const bodies = [];
    const outPieces = [];
    let least = Infinity;
    let doneCount = 0;
    pieces.forEach((p, i) => {
        const st = ctx.stagger[i];
        // the last 80 ms ease the spring onto its exact target, so the surface's own glass takes over with no step
        const land = smoothstep(ctx.doneAt[i] - 80, ctx.doneAt[i], t);
        const far = springAt(t - st) + (1 - springAt(t - st)) * land;
        const near = springAt(t - st - STRETCH.lagMs) + (1 - springAt(t - st - STRETCH.lagMs)) * land;
        const side = (far + near) / 2;
        // far edges (the bottom, the sides) lead; the edge at the button follows
        const top = lerp(from.y, p.y, near);
        const bottom = lerp(from.y + from.h, p.y + p.h, far);
        const left = lerp(from.x, p.x, side);
        const right = lerp(from.x + from.w, p.x + p.w, side);
        const r = lerp(from.r, p.r, clamp01(far));
        const hw = Math.max(0, (right - left) / 2);
        const hh = Math.max(0, (bottom - top) / 2);
        const shape = t > 0 ? {x: (left + right) / 2, y: (top + bottom) / 2, w: hw, h: hh, r: Math.max(0, Math.min(r, hw, hh))} : {...empty};
        bodies.push(shape);
        least = Math.min(least, far);
        const done = t >= ctx.doneAt[i];
        if (done)
            doneCount++;
        outPieces.push({id: p.id, shape, e: far, done, started: t > 0, contentAlpha: smoothstep(STRETCH.contentFrom, 1, far), clip: null,
            bloomU: clamp01(far)});
    });
    // the button: kept when it has a highlight of its own, else it thins away upward as the glass leaves it
    let pillHh = pill.h / 2;
    let pillCy = pill.y + pill.h / 2;
    if (!pill.keep) {
        const f = smoothstep(0.25, 0.7, least);
        pillHh *= 1 - f;
        pillCy -= pill.h * 0.5 * f;
    }
    const pillShape = !pill.keep && pillHh < DRIP.pillGoneHh ? {...empty}
        : {x: pill.x + pill.w / 2, y: pillCy, w: pill.w / 2, h: pillHh, r: Math.min(pill.w / 2, pillHh)};
    const shapes = [pillShape, {...empty}];
    if (multi)
        shapes.push({...empty});
    shapes.push(...bodies);
    const k = lerp(STRETCH.kStart * ph, DRIP.k0, smoothstep(0.15, 1, clamp01(least)));
    return {tau: t, shapes, k, fieldAlpha: smoothstep(0, DRIP.fieldFadeInMs, t),
        boost: 1 - smoothstep(0.6, 0.98, clamp01(least)),      // the glass is lit while it moves (liquidDrip _boost)
        pieces: outPieces, allDone: pieces.length > 0 && doneCount === pieces.length, pinched: true, drop: bodies[0] ?? empty,
        carrier: multi ? -1 : 0};
}

// ---------------------------------------------------------------------------------------------------------
// Playback state machine (pure, driven by a clock in ms): one `tau` position with a direction.
//   open():  tau runs forward at 1x from its current value to totalMs
//   close(): tau runs back to 0 through the context's time warp (the close spends its time where the picture
//            changes: DRIP.closeDropShare on the drop, ...), eased so that it starts and ends at
//            DRIP.closeStartSpeed of its average speed; content fades in contentOutMs
// The class holds no GI objects; the controller feeds it the clock.
export class DripClock {
    constructor(totalMs, warp = null) {
        this.totalMs = totalMs;
        this.warp = warp;
        this.tau = 0;
        this.mode = 'idle';     // 'idle' | 'opening' | 'closing'
        this._t0 = 0;
        this._tau0 = 0;
        this._closeMs = 0;
        this._w0 = 0;
        this._contentAtClose = 1;
        this._speed = 1;
        this.content = 0;       // content alpha ceiling state (closing only)
    }

    setTotal(ms) {
        this.totalMs = ms;
    }

    // speed: 1 for a normal open, DRIP.switchOpenSpeed when it takes over from another top-bar pop-out (the old one is retracting: the
    // new one's drop must not fall for its full 230 ms with nothing else on screen)
    open(now, speed = 1) {
        this._tau0 = this.tau;
        this._t0 = now;
        this._speed = speed;
        this.mode = 'opening';
    }

    _W(tau) {
        return this.warp ? this.warp.W(tau) : tau / DRIP.openMs;
    }

    _inv(w) {
        return this.warp ? this.warp.inv(w) : w * DRIP.openMs;
    }

    // scale: 1 for a normal close, DRIP.switchCloseScale when another pop-out takes over
    close(now, scale = 1, contentNow = 1) {
        this._tau0 = this.tau;
        this._t0 = now;
        const full = this.warp ? this.warp.total : 1;
        this._w0 = this._W(this.tau);
        this._closeMs = Math.max(1, DRIP.closeMs * Math.max(DRIP.closeMinFraction, Math.min(1, this._w0 / full)) * scale);
        this._contentAtClose = contentNow;
        this._contentOutMs = Math.max(1, DRIP.contentOutMs * scale);
        this.mode = 'closing';
    }

    // advance to clock time `now`; returns {tau, finished}
    update(now) {
        if (this.mode === 'opening') {
            const tau = this._tau0 + (now - this._t0) * (this._speed ?? 1);
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
            // progress with a non-zero speed at both ends (m x average): c = m p + (1 - m) smoothstep(p)
            const m = DRIP.closeStartSpeed;
            const c = m * p + (1 - m) * p * p * (3 - 2 * p);
            this.tau = Math.min(this._tau0, this._inv(this._w0 * (1 - c)));
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

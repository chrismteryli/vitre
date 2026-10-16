/* Vitre lock-screen intro, as pure functions of time. No GI imports: node loads this file for the unit tests
 * (identity/session/tests) and the design preview; the shell loads the same file.
 *
 * The story (2026-10-12, logo concept A "Drop from the bar"): the small Vitre mark sits at the top of
 * the lock screen. When the prompt opens, a bead of glass buds from the bottom of the mark on a thin thread, hangs,
 * snaps free, falls (gravity, no easing curve: the brand kit's own fall law y = y0 * (1 - tau^2)), lands in the
 * password capsule with a squash and a cyan pulse ring, and blooms into the glass unlock card (the same bloom curve
 * and +1.7 % overshoot as the A17 drip). Avatar and name arrive with the bloom. Subtle: the bead is about 15 px.
 *
 * The motion numbers that come from the brand kit are read from tokens.json (identity/brand/tokens.json, shipped in
 * assets/): the fall length, the squash keys and the pulse ring. Everything else is in the VITRE table below so it can
 * be retuned in one place. All times are ms from the first frame in which the card geometry is known.
 *
 * The same drop story serves both surfaces: the lock screen (source = the mark, landing = the password capsule, card =
 * the unlock card) and the end-session dialog (source = a thin glass bar under the top bar, landing = the middle of the
 * card, card = the dialog card). dropContext / dropFrame take the surface's geometry and options; lockIntroContext is the
 * lock screen's preset.
 *
 * Coordinates: stage logical px, y down. A shape is {x, y, w, h, r}: centre, HALF sizes, corner radius (the same
 * convention as dripMotion.js / the glass field shader).
 */
import {bloomCurve, clamp, clamp01, easeOutCubic, easeInOutCubic, lerp, smoothstep} from './dripMotion.js';

// brand kit tokens.json (2026-10-12) as fallback when the file cannot be read
export const FALLBACK_TOKENS = {
    glassDrop: {
        fall: {durationMs: 360, scaleStart: [0.888, 0.965], scaleEnd: [0.975, 1.06]},
        land: {keys: [
            {tMs: 1450, scaleX: 0.975, scaleY: 1.06},
            {tMs: 1505, scaleX: 1.09, scaleY: 0.9},
            {tMs: 1585, scaleX: 0.972, scaleY: 1.036},
            {tMs: 1665, scaleX: 1.018, scaleY: 0.988},
            {tMs: 1750, scaleX: 0.997, scaleY: 1.004},
            {tMs: 1880, scaleX: 1.0, scaleY: 1.0},
        ]},
    },
    intro: {landing: {rippleRing1: {fromMs: 1455, toMs: 1970, scale: [0.42, 1.25], opacity: [0.6, 0], colour: '#9af3ff'}}},
    palette: {cyan: '#22d3ee', cyanPulse: '#96f0ff', ink: '#081226'},
};

export function motionFromTokens(tokens) {
    const t = tokens ?? FALLBACK_TOKENS;
    const fb = FALLBACK_TOKENS;
    const fall = t.glassDrop?.fall ?? fb.glassDrop.fall;
    const keys = t.glassDrop?.land?.keys ?? fb.glassDrop.land.keys;
    const ring = t.intro?.landing?.rippleRing1 ?? fb.intro.landing.rippleRing1;
    const t0 = keys[0]?.tMs ?? 0;
    return {
        // tokens: the free fall never takes longer than the brand's own fall (360 ms); stretch ratio from its start/end scales
        fallMaxMs: fall.durationMs ?? 360,
        fallStretch: ((fall.scaleEnd?.[1] ?? 1.06) / (fall.scaleStart?.[1] ?? 0.965)) / ((fall.scaleEnd?.[0] ?? 0.975) / (fall.scaleStart?.[0] ?? 0.888)),
        squash: keys.map(k => ({t: k.tMs - t0, sx: k.scaleX, sy: k.scaleY})),
        ring: {ms: (ring.toMs ?? 1970) - (ring.fromMs ?? 1455), s0: ring.scale?.[0] ?? 0.42, s1: ring.scale?.[1] ?? 1.25,
            a0: ring.opacity?.[0] ?? 0.6, a1: ring.opacity?.[1] ?? 0},
    };
}

export const VITRE = {
    // ---- bud and hang -------------------------------------------------------------------------------------
    // Vitre polish 2026-10-14 ("really mid"): the drop at brand scale. The bead was 8.5 px (17 px across, invisible on a
    // 2880x1800 screen); it is now a glass bead you can see swell, hang and let go, the thread is a thread, and the hang
    // takes long enough to read (the brand kit hangs 710 ms; 380 here keeps the unlock quick).
    budInMs: 220,           // the bead swells out from behind the mark's lower edge over this long
    snapMs: 380,            // the thread breaks here (the release)
    beadR: 19,              // bead radius at the snap, px
    beadRStart: 2.5,
    hangPx: 26,             // how far the bead sags below its budding point before the snap
    threadHw0: 6.5,         // thread half width, px, at its thickest ...
    threadHw1: 1.4,         // ... and at the break
    markKick: 0.035,        // the mark springs +3.5 % when the bead lets go
    markKickMs: 110,
    // ---- fall ---------------------------------------------------------------------------------------------
    fallMinMs: 260,         // fall time = clamp(sqrt(distance) * fallPerSqrtPx, fallMinMs, tokens fall.durationMs)
    fallPerSqrtPx: 14,
    fallStretchMax: 1.22,   // the bead lengthens as it speeds up (area kept)
    // ---- landing and bloom --------------------------------------------------------------------------------
    bloomMs: 400,           // capsule -> card
    bloomXLead: 1.25,       // the width opens first (the card grows out of the capsule), the height follows
    absorbMs: 150,          // the bead is absorbed into the capsule over this long after landing
    squashMs: 150,          // landing squash of the bead (tokens land keys, compressed)
    contentFrom: 150,       // avatar and name: alpha 0 -> 1 between these two times after landing
    contentTo: 390,
    settleMs: 40,           // card at rest before the hand-over
    handoffMs: 80,          // field fades out / the CSS card fades in over this long at the end
    fieldFadeInMs: 50,
    // ---- softness of the smooth union (px) -----------------------------------------------------------------
    kBud: 14,
    kFall: 4,
    kLand: 18,
    kEnd: 4,
};

// B24 (2026-10-15, "stretch everywhere"): 'stretch' = the card's glass stretches out of the source (the mark,
// the bar) on one spring and stays connected until it arrives, like the menus (dripMotion STYLE 'stretch'); 'drop' = the
// story above.
export const SESSION_STYLE = {name: 'stretch'};
export const SESSION_STRETCH = {responseMs: 380, damping: 0.86, lagMs: 40, lagPerPx: 0.30, lagMaxMs: 140, fromW: 0.7, fromH: 0.6,
    kStart: 22, kEnd: 4, contentFrom: 0.78, settle: 0.004, landMs: 90};
// the near edge (at the source) holds on longer the farther the card is: the glass first stretches as one column from the
// source, then gathers into the card (a card far below its bar must not let go of it halfway)

function springAt(t, responseMs, damping) {
    if (t <= 0)
        return 0;
    const w0 = 2 * Math.PI / (responseMs / 1000);
    const ts = t / 1000;
    const wd = w0 * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * w0 * ts) * (Math.cos(wd * ts) + damping * w0 / wd * Math.sin(wd * ts));
}

const _settle = new Map();
function settleMs(S) {
    const key = `${S.responseMs}|${S.damping}|${S.settle}`;
    if (!_settle.has(key)) {
        let last = 0;
        for (let t = 0; t <= 3000; t++) {
            if (Math.abs(1 - springAt(t, S.responseMs, S.damping)) > S.settle)
                last = t;
        }
        _settle.set(key, last + 1);
    }
    return _settle.get(key);
}

// Surface presets (options override VITRE)
export const LOCK_OPTS = {};
export const END_OPTS = {
    snapMs: 260, budInMs: 160, beadR: 17, hangPx: 20, bloomMs: 330, contentFrom: 150, contentTo: 320, settleMs: 24,
    handoffMs: 60, fieldHold: true, fallMinMs: 200, tintFrom: 0.24, tintTo: 0.46, barInMs: 70, barHoldMs: 150, barOutMs: 110,
};

// geom = {source: {cx, cy, r, bar?: {x, y, w, h}}, landing: {x, y, w, h}, card: {x, y, w, h, r}} (x, y = top-left, w, h = full sizes)
//   source: where the bead buds (cx; cy + r = the lower edge it hangs from); bar: a glass pill drawn by the field at the source
//   landing: where it lands (the capsule / the card's middle); card: the final glass
export function dropContext(geom, M, opts = {}) {
    const K = {...VITRE, ...opts};
    const {source, landing, card} = geom;
    const budX = source.cx;
    const budY0 = source.cy + source.r - 3;             // starts hidden behind the source's lower edge
    const budYSnap = budY0 + K.beadR + K.hangPx;        // where it hangs when the thread breaks
    const landX = landing.x + landing.w / 2;
    const landY = landing.y + landing.h / 2;
    const dist = Math.max(1, landY - budYSnap);
    const fallMs = clamp(Math.sqrt(dist) * K.fallPerSqrtPx, K.fallMinMs, Math.max(K.fallMinMs, M.fallMaxMs));
    const tLand = K.snapMs + fallMs;
    const tEnd = tLand + K.bloomMs + K.settleMs;
    // the card never shrinks below the landing rectangle it grows from
    const c = {x: Math.min(card.x, landing.x), y: Math.min(card.y, landing.y), r: card.r};
    c.w = Math.max(card.x + card.w, landing.x + landing.w) - c.x;
    c.h = Math.max(card.y + card.h, landing.y + landing.h) - c.y;
    const ctx = {source, bar: source.bar ?? null, landing, card: c, budX, budY0, budYSnap, landX, landY, fallMs, tLand, tEnd, M, K,
        totalMs: tEnd, stretchMax: Math.min(K.fallStretchMax, Math.max(1.02, M.fallStretch * 1.2))};
    if (SESSION_STYLE.name === 'stretch') {
        const S = SESSION_STRETCH;
        ctx.style = 'stretch';
        const src = source.bar ? {y: source.bar.y + source.bar.h} : {y: source.cy + source.r};
        ctx.lagMs = clamp(S.lagMs + Math.max(0, c.y - src.y) * S.lagPerPx, S.lagMs, S.lagMaxMs);
        ctx.doneAt = ctx.lagMs + settleMs(S);
        ctx.tLand = 0;
        ctx.tEnd = ctx.doneAt + K.settleMs;
        ctx.totalMs = ctx.tEnd;
    }
    return ctx;
}

// the lock screen: the mark, the password capsule, the unlock card
export function lockIntroContext(geom, M, K = VITRE) {
    const {mark, capsule, card} = geom;
    return dropContext({source: {cx: mark.cx, cy: mark.cy, r: mark.r}, landing: capsule, card}, M, {...LOCK_OPTS, ...(K === VITRE ? {} : K)});
}

// The surface's real geometry moved while the drip is already running (the end-session lists arrived, the lock stack
// finished its crossfade placement): take the new geometry from `next` (a context freshly built from the live
// geometry) but keep the running context's TIMELINE (fall time, landing, end), so the bead does not jump in time.
// Mutates and returns ctx. Pure.
export function retargetContext(ctx, next) {
    ctx.source = next.source;
    ctx.bar = next.bar;
    ctx.landing = next.landing;
    ctx.card = next.card;
    ctx.budX = next.budX;
    ctx.budY0 = next.budY0;
    ctx.budYSnap = next.budYSnap;
    ctx.landX = next.landX;
    ctx.landY = next.landY;
    return ctx;
}

// Do two cards differ (position or size) by more than eps px?
export function cardMoved(a, b, eps = 0.5) {
    return Math.abs(a.x - b.x) > eps || Math.abs(a.y - b.y) > eps || Math.abs(a.w - b.w) > eps || Math.abs(a.h - b.h) > eps;
}

function squashAt(M, dt) {
    const keys = M.squash;
    if (!keys.length || dt <= 0)
        return {sx: 1, sy: 1};
    // tokens keys span 215 ms; compress them into squashMs, hold the last, then settle to 1
    const span = keys[keys.length - 1].t || 1;
    const u = dt / VITRE.squashMs * span;
    if (u >= span)
        return {sx: 1, sy: 1};
    for (let i = 1; i < keys.length; i++) {
        if (u <= keys[i].t) {
            const a = keys[i - 1];
            const b = keys[i];
            const s = easeInOutCubic((u - a.t) / Math.max(1, b.t - a.t));
            return {sx: lerp(a.sx, b.sx, s), sy: lerp(a.sy, b.sy, s)};
        }
    }
    return {sx: 1, sy: 1};
}

// Fully evaluated frame at time t (ms from the start). Pure: the same function plays forward (open) and, with t running
// backwards, the retract (close).
export function dropFrame(ctx, t) {
    if (ctx.style === 'stretch')
        return stretchFrame(ctx, t);
    const {K, M} = ctx;
    const time = Math.max(0, t);
    const shapes = [];
    const point = {x: ctx.landX, y: ctx.landY, w: 0, h: 0, r: 0};
    let card = point;
    let bead = {x: ctx.budX, y: ctx.budY0, w: 0, h: 0, r: 0};
    let thread = {x: ctx.budX, y: ctx.budY0, w: 0, h: 0, r: 0};
    let k = K.kBud;
    let phase = 'bud';

    if (time < K.snapMs) {
        // bud and hang: the bead swells and sags on a thinning thread
        const swell = easeOutCubic(time / K.budInMs);
        const rad = lerp(K.beadRStart, K.beadR, swell);
        const sag = easeInOutCubic(time / K.snapMs) * (K.beadR + K.hangPx);
        const cy = ctx.budY0 + sag;
        const rx = rad * 0.94;
        const ry = rad * 1.06;
        bead = {x: ctx.budX, y: cy, w: rx, h: ry, r: Math.min(rx, ry)};
        const tw = lerp(K.threadHw0, K.threadHw1, smoothstep(0, K.snapMs, time)) * easeOutCubic(time / 60);
        const topY = ctx.budY0 - 6;
        if (cy > topY && tw > 0.05)
            thread = {x: ctx.budX, y: (topY + cy) / 2, w: tw, h: (cy - topY) / 2, r: tw};
        k = K.kBud;
    } else if (time < ctx.tLand) {
        // free fall: y = y0 + (y1 - y0) * tau^2 (the brand kit's gravity), the bead lengthens as it speeds up
        phase = 'fall';
        const tau = clamp01((time - K.snapMs) / ctx.fallMs);
        const cy = lerp(ctx.budYSnap, ctx.landY, tau * tau);
        const sy = lerp(1, ctx.stretchMax, tau);
        const rx = K.beadR / Math.sqrt(sy);
        const ry = K.beadR * sy;
        const cx = lerp(ctx.budX, ctx.landX, tau * tau);
        bead = {x: cx, y: cy, w: rx, h: ry, r: Math.min(rx, ry)};
        k = lerp(K.kFall, K.kLand, smoothstep(0.8, 1, tau));
    } else {
        phase = 'bloom';
        const dt = time - ctx.tLand;
        // the bead squashes into the capsule and is absorbed
        const sq = squashAt(M, dt);
        const absorb = 1 - smoothstep(0, K.absorbMs, dt);
        const rx = K.beadR * sq.sx * absorb;
        const ry = K.beadR * sq.sy * absorb;
        bead = {x: ctx.landX, y: ctx.landY, w: rx, h: ry, r: Math.min(rx, ry)};
        // the card grows out of the landing point: width first, then height, with the A17 overshoot
        const u = clamp01(dt / K.bloomMs);
        const ex = bloomCurve(clamp01(u * K.bloomXLead));
        const ey = bloomCurve(u);
        const c = ctx.card;
        const cap = ctx.capsule;
        const seed = {l: ctx.landX - K.beadR, r: ctx.landX + K.beadR, t: ctx.landY - K.beadR, b: ctx.landY + K.beadR};
        const l = lerp(seed.l, c.x, ex);
        const r = lerp(seed.r, c.x + c.w, ex);
        const tp = lerp(seed.t, c.y, ey);
        const b = lerp(seed.b, c.y + c.h, ey);
        const hw = Math.max(0, (r - l) / 2);
        const hh = Math.max(0, (b - tp) / 2);
        const rad = Math.min(lerp(Math.min(hw, hh), c.r, ey), hw, hh);
        card = {x: (l + r) / 2, y: (tp + b) / 2, w: hw, h: hh, r: Math.max(0, rad)};
        k = lerp(K.kLand, K.kEnd, smoothstep(0, K.bloomMs, dt));
    }
    shapes.push(card, bead, thread);

    const dtLand = time - ctx.tLand;
    const contentAlpha = time < ctx.tLand ? 0 : smoothstep(K.contentFrom, K.contentTo, dtLand);
    // field: fades in with the bud, out at the end while the CSS card fades in (class removed at cardAt)
    const cardAt = ctx.tEnd - K.handoffMs;
    const fieldAlpha = K.fieldHold ? smoothstep(0, K.fieldFadeInMs, time)
        : Math.min(smoothstep(0, K.fieldFadeInMs, time), 1 - smoothstep(cardAt, ctx.tEnd, time));
    // the glass tint: clear while the bead flies, the surface's own tint once the card has bloomed
    const blend = easeInOutCubic(clamp01(dtLand / K.bloomMs));
    const tint = K.tintFrom === undefined ? undefined : lerp(K.tintFrom, K.tintTo, blend);
    // a glass bar at the source (end-session): swells in, hangs, and shrinks away after the snap
    if (ctx.bar) {
        const b = ctx.bar;
        const inA = easeOutCubic(time / K.barInMs);
        const outA = smoothstep(K.snapMs + K.barHoldMs, K.snapMs + K.barHoldMs + K.barOutMs, time);
        const reb = time > K.snapMs ? 0.015 * Math.sin(Math.PI * clamp01((time - K.snapMs) / 70)) : 0;
        const hw = b.w / 2 * inA * (1 - outA) * (1 + reb);
        const hh = b.h / 2 * Math.max(inA, 0.25) * (1 - outA * 0.6) * (1 + reb);
        shapes.push({x: b.x + b.w / 2, y: b.y + b.h / 2, w: hw, h: Math.min(hh, hw), r: Math.min(hh, hw)});
    }
    // pulse ring around the capsule
    let ring = {alpha: 0, scale: M.ring.s0};
    if (dtLand > 0 && dtLand < M.ring.ms) {
        const rp = dtLand / M.ring.ms;
        ring = {alpha: lerp(M.ring.a0, M.ring.a1, easeOutCubic(rp)), scale: lerp(M.ring.s0, M.ring.s1, easeOutCubic(rp))};
    }
    // mark: a little spring when the bead lets go
    const markScale = time > K.snapMs ? 1 + K.markKick * Math.sin(Math.PI * clamp01((time - K.snapMs) / K.markKickMs)) : 1;
    return {t: time, phase, shapes, k, fieldAlpha, cardHidden: time < cardAt, contentAlpha, ring, markScale, tint, tintBlend: blend,
        done: time >= ctx.tEnd};
}

// The stretch: the source's glass (the bar, or a disc under the mark) and the card, smooth-unioned, the card's far edge
// leading on a spring and the edge at the source following; the source's glass gives way as the card arrives.
function stretchFrame(ctx, t) {
    const {K, M} = ctx;
    const S = SESSION_STRETCH;
    const time = Math.max(0, t);
    const src = ctx.bar ? {x: ctx.bar.x, y: ctx.bar.y, w: ctx.bar.w, h: ctx.bar.h}
        : {x: ctx.source.cx - ctx.source.r, y: ctx.source.cy - ctx.source.r, w: 2 * ctx.source.r, h: 2 * ctx.source.r};
    const scx = src.x + src.w / 2;
    const from = {x: scx - src.w * S.fromW / 2, y: src.y + src.h * (1 - S.fromH), w: src.w * S.fromW, h: src.h * S.fromH};
    const land = smoothstep(ctx.doneAt - S.landMs, ctx.doneAt, time);
    const sp = d => {
        const v = springAt(time - d, S.responseMs, S.damping);
        return v + (1 - v) * land;
    };
    const far = sp(0);
    const near = sp(ctx.lagMs);
    const side = (far + near) / 2;
    const c = ctx.card;
    const below = c.y + c.h / 2 >= src.y + src.h / 2;
    // the edge away from the source leads
    const top = lerp(from.y, c.y, below ? near : far);
    const bottom = lerp(from.y + from.h, c.y + c.h, below ? far : near);
    const l = lerp(from.x, c.x, side);
    const r = lerp(from.x + from.w, c.x + c.w, side);
    const hw = Math.max(0, (r - l) / 2);
    const hh = Math.max(0, (bottom - top) / 2);
    const card = time > 0 ? {x: (l + r) / 2, y: (top + bottom) / 2, w: hw, h: hh,
        r: Math.max(0, Math.min(lerp(Math.min(src.w, src.h) / 2, c.r, clamp01(far)), hw, hh))}
        : {x: scx, y: src.y + src.h / 2, w: 0, h: 0, r: 0};
    // the source's own glass: present from the first frame, gives way as the card arrives
    const away = smoothstep(0.55, 0.95, clamp01(near));
    const sw = src.w / 2 * (1 - away), sh = src.h / 2 * (1 - away);
    const source = {x: scx, y: src.y + src.h / 2, w: sw, h: Math.min(sh, sw), r: Math.min(sh, sw)};
    const thread = {x: scx, y: src.y, w: 0, h: 0, r: 0};
    const shapes = [card, source, thread];
    if (ctx.bar)
        shapes.push({x: scx, y: src.y + src.h / 2, w: 0, h: 0, r: 0});
    const k = lerp(S.kStart, S.kEnd, smoothstep(0.2, 1, clamp01(near)));
    const cardAt = ctx.tEnd - K.handoffMs;
    const fieldAlpha = K.fieldHold ? smoothstep(0, K.fieldFadeInMs, time)
        : Math.min(smoothstep(0, K.fieldFadeInMs, time), 1 - smoothstep(cardAt, ctx.tEnd, time));
    const blend = easeInOutCubic(clamp01(far));
    const tint = K.tintFrom === undefined ? undefined : lerp(K.tintFrom, K.tintTo, blend);
    return {t: time, phase: time > 0 ? 'bloom' : 'bud', shapes, k, fieldAlpha, cardHidden: time < cardAt,
        contentAlpha: smoothstep(S.contentFrom, 1, clamp01(Math.min(far, near))), ring: {alpha: 0, scale: M.ring.s0}, markScale: 1, tint, tintBlend: blend,
        done: time >= ctx.tEnd};
}

export const lockIntroFrame = dropFrame;

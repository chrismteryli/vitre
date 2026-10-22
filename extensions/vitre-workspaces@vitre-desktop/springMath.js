// SPDX-License-Identifier: GPL-3.0-or-later
// Vitre Workspaces: the pure math (no GNOME imports, so node can test it).
//
// Units: positions are workspace "progress" (GNOME's MonitorGroup.progress: one workspace = 1.0), times are motion
// milliseconds, velocities are progress per millisecond. A plan is a function of time only, so whatever drives it (a
// Clutter transition, the tail after the switch has ended, a film running N times slower) draws the same curve.

// ---- the Vitre stretch spring (vitre-menus dripMotion.js STRETCH, as Fullscreen Spaces uses it) ------------------------
export const SPRING = {
    periodMs: 400,      // spring period ...
    damping: 0.86,      // ... and damping ratio: a ~0.5 % overshoot that settles
    landMs: 80,         // the last 80 ms ease exactly onto the target, so the hand-over to the real desktop has no step
    tolEndPx: 3,        // the picture is done when it stays within this many px of the target ...
    tolLogicPx: 12,     // ... and the switch itself (input, mutter) ends once it stays within this many px
    minLogicMs: 120,    // never before this
    maxMs: 1600,        // nothing runs longer than this
    stiffFlick: 2.6,    // a fast flick stiffens the spring (omega >= this x |v0| / |distance|) so it cannot fling far past
    awayMax: 0.0015,    // a release moving away from its target keeps at most this speed (progress / ms)
    kbdPush: 0.003,     // a key press starts the motion at this speed instead of from rest (about 6 px per ms)
};

// ---- reduced motion: an in-place cross-fade --------------------------------------------------------------------------
export const FADE = {ms: 160};
const SPRING_MIN_PERIOD_MS = 40;   // the stiffest a flick can make it

export const clamp01 = v => Math.min(1, Math.max(0, v));
export const smoothstep = (a, b, v) => {
    const s = clamp01((v - a) / (b - a));
    return s * s * (3 - 2 * s);
};

function springConsts(periodMs, damping) {
    const w0 = 2 * Math.PI / periodMs;
    const zw = damping * w0;
    const wd = w0 * Math.sqrt(Math.max(1e-9, 1 - damping * damping));
    return {w0, zw, wd};
}

// displacement from the target `t` ms after starting at displacement `a` with speed `u` (underdamped spring)
export function springDisp(a, u, t, k) {
    if (t <= 0)
        return a;
    const b = (u + k.zw * a) / k.wd;
    return Math.exp(-k.zw * t) * (a * Math.cos(k.wd * t) + b * Math.sin(k.wd * t));
}

export function springVel(a, u, t, k) {
    if (t <= 0)
        return u;
    const b = (u + k.zw * a) / k.wd;
    return Math.exp(-k.zw * t) * ((b * k.wd - k.zw * a) * Math.cos(k.wd * t) - (a * k.wd + k.zw * b) * Math.sin(k.wd * t));
}

/**
 * One spring motion from `from` (moving at `v0`) to `to`.
 *
 * @param {object} p - {from, to, v0, unitPx (px per progress unit, for the tolerances), slow (unused: time is motion time)}
 * @returns {object|null} {from, to, v0, T, Tlogic, kind, at(t), vel(t)}; null when the inputs make no sense
 */
export function planSpring({from, to, v0 = 0, unitPx = 2020, spring = SPRING}) {
    if (![from, to, v0, unitPx].every(Number.isFinite) || !(unitPx > 0))
        return null;
    const a = from - to;                          // displacement from the target
    let u = v0;
    if (Math.abs(a) < 1e-9 && Math.abs(u) < 1e-9)
        return {from, to, v0: 0, T: 0, Tlogic: 0, kind: 'spring', at: () => to, vel: () => 0};
    // moving away from the target: keep a little of it (the motion turns), not a lurch the wrong way
    if (a !== 0 && u * a > 0)
        u = Math.sign(u) * Math.min(Math.abs(u), spring.awayMax);
    // a fast flick toward the target stiffens the spring, same damping
    let period = spring.periodMs;
    if (a !== 0 && u * a < 0) {
        const wNeed = spring.stiffFlick * Math.abs(u) / Math.abs(a);
        const w0 = 2 * Math.PI / period;
        if (wNeed > w0)
            period = Math.max(SPRING_MIN_PERIOD_MS, 2 * Math.PI / wNeed);
    }
    const k = springConsts(period, spring.damping);
    const tolEnd = spring.tolEndPx / unitPx;
    const tolLogic = spring.tolLogicPx / unitPx;
    let lastEnd = 0, lastLogic = 0;
    for (let t = 0; t <= spring.maxMs; t += 1) {
        const e = Math.abs(springDisp(a, u, t, k));
        if (e > tolEnd)
            lastEnd = t;
        if (e > tolLogic)
            lastLogic = t;
    }
    const T = Math.min(spring.maxMs, Math.max(spring.landMs, lastEnd + 1));
    const Tlogic = Math.min(T, Math.max(Math.min(spring.minLogicMs, T), lastLogic + 1));
    const landFrom = T - spring.landMs;
    const at = t => {
        if (t >= T)
            return to;
        const x = to + springDisp(a, u, t, k);
        return x + (to - x) * smoothstep(landFrom, T, t);
    };
    const vel = t => {
        if (t >= T)
            return 0;
        const x = to + springDisp(a, u, t, k);
        const v = springVel(a, u, t, k);
        const s = clamp01((t - landFrom) / spring.landMs);
        const land = s * s * (3 - 2 * s);
        const dLand = s > 0 && s < 1 ? 6 * s * (1 - s) / spring.landMs : 0;
        return v * (1 - land) + (to - x) * dLand;
    };
    return {from, to, v0: u, T, Tlogic, kind: 'spring', periodMs: period, at, vel};
}

/** reduced motion: progress eases from `from` to `to` over FADE.ms (smoothstep), no overshoot */
export function planFade({from, to, ms = FADE.ms}) {
    if (![from, to, ms].every(Number.isFinite))
        return null;
    const T = Math.abs(from - to) < 1e-9 ? 0 : ms;
    const at = t => t >= T ? to : from + (to - from) * smoothstep(0, T, t);
    const vel = t => {
        if (t <= 0 || t >= T)
            return 0;
        const s = t / T;
        return (to - from) * 6 * s * (1 - s) / T;
    };
    return {from, to, v0: 0, T, Tlogic: T, kind: 'fade', at, vel};
}

// ---- the look: a pure function of a card's screen offset u (in base distances; 0 = on screen) ------------------------
export const LOOK = {
    sink: 0.06,         // a card in motion steps back to 94 % ...
    dim: 0.38,          // ... and dims by 38 % (Fullscreen Spaces: 95 % and 42 %, the desktop stepping back)
    full: 0.45,         // ... fully once it is this far out (ease-out: it starts stepping back at once)
    edge: 1.0,          // the lit seam edge: strength ...
    edgeIn: 0.12,       // ... reaches full when the card is this far out ...
    rim: 1.0,           // the faint glass rim around a card in motion
    gapPx: 0,           // extra space between two cards at rest scale (the scale itself opens the seam)
};

export function depthOf(u, look = LOOK) {
    const a = Math.min(1, Math.abs(u) / look.full);
    return 1 - (1 - a) * (1 - a);
}

/** {x (px offset of the card's centre from the monitor's centre), scale, dim (0..1), edge (0..1), rim (0..1), side} */
export function lookAt(u, extentPx, look = LOOK) {
    const r = depthOf(u, look);
    const a = Math.abs(u);
    return {
        x: u * (extentPx + look.gapPx),
        scale: 1 - look.sink * r,
        dim: look.dim * r,
        edge: look.edge * smoothstep(0, look.edgeIn, a),
        rim: look.rim * r,
        side: u > 0 ? -1 : 1,          // which edge faces the seam: -1 = the card's left/top edge, 1 = right/bottom
    };
}

// ---- release velocity (copied from vitre-gesture-history releaseMotion.js, same rules) --------------------------------
export const WINDOW_MS = 50;
export const SPEED_WINDOW_MS = 40;
export const MIN_STALE_MS = 16;

function median(values) {
    const s = values.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function lineFit(pts) {
    const n = pts.length;
    const tm = pts.reduce((acc, s) => acc + s.t, 0) / n;
    const pm = pts.reduce((acc, s) => acc + s.p, 0) / n;
    let num = 0, den = 0;
    for (const s of pts) {
        num += (s.t - tm) * (s.p - pm);
        den += (s.t - tm) * (s.t - tm);
    }
    return {tm, pm, slope: den > 0 ? num / den : 0};
}

/**
 * Finger velocity at lift-off, in the samples' unit per ms.
 *
 * @param {{time: number, delta: number}[]} data - samples (time in ms, change since the previous sample)
 * @param {number} releaseTime - the release time in ms (NaN = the newest sample)
 * @param {number} fallback - used when fewer than 3 samples fall in the window
 * @returns {number}
 */
export function estimateReleaseVelocity(data, releaseTime, fallback = 0) {
    if (!Array.isArray(data) || data.length === 0)
        return 0;
    const samples = data.filter(s => Number.isFinite(s?.time) && Number.isFinite(s?.delta));
    if (samples.length === 0)
        return 0;
    const last = samples[samples.length - 1].time;
    const tRel = Number.isFinite(releaseTime) && releaseTime >= last ? releaseTime : last;
    let pos = 0;
    const pts = samples.map(s => {
        pos += s.delta;
        return {t: s.time, p: pos, d: s.delta};
    });
    const win = pts.filter(s => s.t >= tRel - WINDOW_MS);
    if (win.length === 0)
        return 0;
    const gaps = [];
    for (let i = 1; i < win.length; i++)
        gaps.push(win[i].t - win[i - 1].t);
    const staleLimit = Math.max(MIN_STALE_MS, gaps.length >= 2 ? 2.5 * median(gaps) : 0);
    if (tRel - win[win.length - 1].t > staleLimit)
        return 0;
    if (win.length < 3)
        return Number.isFinite(fallback) ? fallback : 0;
    const line = lineFit(win).slope;
    const speeds = [];
    for (let i = 1; i < pts.length; i++) {
        if (pts[i].t < tRel - SPEED_WINDOW_MS)
            continue;
        let dt = pts[i].t - pts[i - 1].t;
        let d = pts[i].d;
        while (dt <= 0 && i + 1 < pts.length && pts[i + 1].t >= tRel - SPEED_WINDOW_MS) {
            i++;
            dt = pts[i].t - pts[i - 2].t;
            d += pts[i].d;
        }
        if (dt > 0)
            speeds.push({t: pts[i].t - dt / 2, p: d / dt});
    }
    if (speeds.length < 4)
        return line;
    const fit = lineFit(speeds);
    const end = fit.pm + fit.slope * (tRel - fit.tm);
    if (!Number.isFinite(end) || end * line < 0 || Math.abs(end) > 2.5 * Math.abs(line) + 0.05 / 400)
        return line;
    return end;
}

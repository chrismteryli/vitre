// Pure math for the swipe-release hand-off (no GNOME imports, so it can be unit-tested with node).
//
// A finger lifts off at position x0 moving at velocity v0 (value units per ms, signed) and the animation must carry on from
// exactly that speed to the target. v3 (liquid): the motion is the liquid engine's track spring (liquid.js, feel A Viscous:
// response 0.42 s, damping 0.90, about 0.2 % past the target at most) with state {x, v} = the finger's position and speed,
// stepped by the engine's own integrator; it rests when the remaining step is under a quarter pixel. No stiffening for fast
// flicks, no duration floor or cap: the spring's role is the whole feel.

import {Plan, role, epsFor} from './liquid.js';

// -- release velocity from the touchpad samples -----------------------------------------------------------------------
// GNOME averages the last 150 ms (lags by ~75 ms).  A straight-line fit of position over 50 ms still lags by ~25 ms,
// which is 38 % off for a finger that speeds up and 117 % off for one that slows down before lifting (rig numbers),
// so the estimate is the end point of a straight-line fit of the per-sample SPEED over the last 40 ms (tools/est-lab*.mjs:
// within ~2-7 % for steady, speeding-up and slowing-down fingers, 15-25 % when the speed has a kink right at lift-off).
export const WINDOW_MS = 50;      // window of the position fit (stale rule, fallback)
export const SPEED_WINDOW_MS = 40;
export const MIN_STALE_MS = 16;   // a finger that sent nothing for this long (or 2.5 sample intervals) has stopped

function median(values) {
    const a = values.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function lineFit(pts) {
    const n = pts.length;
    const tm = pts.reduce((a, s) => a + s.t, 0) / n;
    const pm = pts.reduce((a, s) => a + s.p, 0) / n;
    let num = 0, den = 0;
    for (const s of pts) {
        num += (s.t - tm) * (s.p - pm);
        den += (s.t - tm) * (s.t - tm);
    }
    return {tm, pm, slope: den > 0 ? num / den : 0};
}

/**
 * Finger velocity at lift-off in input units per ms (the same unit as the samples' delta, i.e. touchpad px/ms).
 *
 * @param {{time: number, delta: number}[]} data - GNOME's EventHistory samples (time in ms, delta since the previous sample)
 * @param {number} releaseTime - the release event time in ms (NaN = use the newest sample)
 * @param {number} gnomeVelocity - GNOME's own 150 ms average, used when fewer than 3 samples fall in the window
 * @returns {number}
 */
export function estimateReleaseVelocity(data, releaseTime, gnomeVelocity = 0) {
    if (!Array.isArray(data) || data.length === 0)
        return 0;
    const samples = data.filter(s => Number.isFinite(s?.time) && Number.isFinite(s?.delta));
    if (samples.length === 0)
        return 0;
    const last = samples[samples.length - 1].time;
    const tRel = Number.isFinite(releaseTime) && releaseTime >= last ? releaseTime : last;
    // cumulative position at each sample
    let pos = 0;
    const pts = samples.map(s => {
        pos += s.delta;
        return {t: s.time, p: pos, d: s.delta};
    });
    const win = pts.filter(s => s.t >= tRel - WINDOW_MS);
    if (win.length === 0)
        return 0;                                   // nothing for 50 ms: the finger had stopped
    const gaps = [];
    for (let i = 1; i < win.length; i++)
        gaps.push(win[i].t - win[i - 1].t);
    const staleLimit = Math.max(MIN_STALE_MS, gaps.length >= 2 ? 2.5 * median(gaps) : 0);
    if (tRel - win[win.length - 1].t > staleLimit)
        return 0;                                   // it stopped a moment before lifting
    if (win.length < 3)
        return Number.isFinite(gnomeVelocity) ? gnomeVelocity : 0;
    const line = lineFit(win).slope;                // 50 ms position fit: speed ~25 ms ago
    // speed of each interval (samples with the same stamp are merged), fitted over 40 ms and read at the release time
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
    // noise guard: the extrapolation may not flip the sign or more than 2.5x the plain fit
    if (!Number.isFinite(end) || end * line < 0 || Math.abs(end) > 2.5 * Math.abs(line) + 0.05)
        return line;
    return end;
}

// -- the spring --------------------------------------------------------------------------------------------------------

/**
 * Everything needed to run one release; null when the inputs make no sense (the caller keeps GNOME's animation).
 * Times are ms; slowDown > 1 (rig films through St's slow-down) stretches them, a value below 1 (Just Perfection's speed-up)
 * leaves the spring as its role defines it. basePx: px per value unit (the rest tolerance is a quarter of one px).
 * Returns {e0, v0, T, start, target, progress(t)}: progress is 0..1 of start -> target (exactly 1 for t >= T).
 */
export function planRelease(start, target, v0, slowDown, basePx) {
    const e0 = start - target;
    if (![e0, v0, basePx].every(Number.isFinite) || Math.abs(e0) < 1e-6 || !(basePx > 0))
        return null;
    const slow = Number.isFinite(slowDown) && slowDown > 1 ? slowDown : 1;
    const plan = new Plan({from: start, to: target, v0: v0 * 1000, p: role('track'), eps: epsFor(basePx)});
    const T = Math.max(1, Math.ceil(plan.T * 1000 * slow));
    return {e0, v0, T, start, target, role: 'track', w: null,
        progress: t => t >= T ? 1 : (plan.at(Math.max(0, t) / slow / 1000) - start) / (target - start)};
}

/** normalized progress 0..1 of a plan at t ms (kept for callers of the v2 API) */
export function springProgress(t, plan) {
    return plan.progress(t);
}

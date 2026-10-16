// Pure math for the swipe-release hand-off (no GNOME imports, so it can be unit-tested with node).
//
// A finger lifts off at position x0 moving at velocity v0 (value units per ms, signed) and the animation must
// carry on from exactly that speed to the target.  With e = x - target the motion is the critically damped spring
//
//     e(t) = (e0 + (v0 + w e0) t) exp(-w t),      e(0) = e0,  e'(0) = v0,   w = omega (1/ms)
//
// which never crosses the target as long as w > |v0| / |e0| (we always use w >= C_STIFF |v0| / |e0|, C_STIFF = 2.35).
// At lift-off the motion has exactly the fingers' speed.  A fast flick then slows down to zero; a medium or slow release
// is pulled toward the target by the spring, so its speed rises a little first (about 1.1x-1.5x for a medium swipe) and
// then falls, which is what finishing in GNOME's time from a low speed needs.  See README.txt for the measured numbers.

// -- tuning (calibrated in the headless rig against the stock timings, see README) ------------------------------------
export const OMEGA_REF = 0.025;   // 1/ms at slow-down 1.0: a medium swipe settles (99.5 %) in about GNOME's stock time
export const C_STIFF = 2.35;      // stiffness per unit of v0/|e0|: keeps fast flicks within ~1.2x of the stock settle time
export const TOL_PX = 0.5;        // the transition ends when the remaining distance is below this (logical px)
export const MIN_T_MS = 40;
export const MAX_T_MS = 1500;

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

export function springOmega(e0, v0, slowDown) {
    const slow = Number.isFinite(slowDown) && slowDown > 0 ? slowDown : 1;
    return Math.max(OMEGA_REF, C_STIFF * Math.abs(v0) / Math.abs(e0)) / slow;
}

export function springError(t, e0, v0, w) {
    return (e0 + (v0 + w * e0) * t) * Math.exp(-w * t);
}

/** normalized progress 0..1 (value = start + (target - start) * progress); exactly 1 for t >= T */
export function springProgress(t, e0, v0, w, T) {
    if (!(t > 0))
        return 0;
    if (t >= T)
        return 1;
    return 1 - springError(t, e0, v0, w) / e0;
}

/** smallest whole-ms duration after which the remaining distance stays below TOL_PX logical pixels */
export function springDuration(e0, v0, w, basePx) {
    const tol = TOL_PX / basePx;
    let last = 0;
    for (let t = 0; t <= 4000; t += 1) {
        if (Math.abs(springError(t, e0, v0, w)) > tol)
            last = t;
    }
    return Math.min(MAX_T_MS, Math.max(MIN_T_MS, Math.ceil(last + 1)));
}

/** everything needed to run one release; null when the inputs make no sense (the caller keeps GNOME's animation) */
export function planRelease(start, target, v0, slowDown, basePx) {
    const e0 = start - target;
    if (![e0, v0, basePx].every(Number.isFinite) || Math.abs(e0) < 1e-6 || !(basePx > 0))
        return null;
    const w = springOmega(e0, v0, slowDown);
    const T = springDuration(e0, v0, w, basePx);
    return {e0, v0, w, T, start, target};
}

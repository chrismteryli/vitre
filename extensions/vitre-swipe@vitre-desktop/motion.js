// Pure motion math for swipe-depth (no GNOME imports, so it can be unit-tested with node).
//
// Three parts:
//  1. the finger -> overview-progress map (dead zone, then linear), per gesture anchor;
//  2. the release: a critically damped spring that starts at the progress the finger left and the speed it had, the same
//     family as gesture-history v2 (A5): e(t) = (e0 + (v0 + w e0) t) exp(-w t); the estimator and the spring below are
//     copied from vitre-gesture-history@vitre-desktop/releaseMotion.js (the constants come from the caller's table);
//  3. the followers of the depth model (plans/a20-concepts/depth-src/model.cjs): a lagged copy of the progress for the
//     wallpaper, the second-order pile follower, the window lift, the landing pop, the shadow rebound.

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smooth = (a, b, x) => {
    const u = clamp((x - a) / (b - a));
    return u * u * (3 - 2 * u);
};
export const lerp = (a, b, t) => a + (b - a) * t;

// -- 1. finger -> progress ---------------------------------------------------------------------------------------------

/**
 * Builds the map from tracker progress f (the finger) to overview state value v for ONE gesture.
 * f0 is the tracker's initial progress (the state value at the moment the fingers landed).
 * A gesture that grabs a motion in flight (f0 not on a snap point) is 1:1 from there, like stock GNOME.
 * From the desktop (f0 = 0): nothing for the first `deadZone` of the travel, then linear, `trackEnd` at f = 1.
 * From the open overview (f0 = 1): the same, mirrored, going down; going up toward the app grid is stock (v = f).
 */
export function makeRemap(tune, f0) {
    const atRest = Math.abs(f0 - Math.round(f0)) < 0.002;
    const anchor = Math.round(f0);
    const dz = clamp(tune.deadZone, 0, 0.9);
    const end = tune.trackEnd;
    const track = u => {
        if (u <= dz)
            return 0;
        return end * (Math.min(u, 1) - dz) / (1 - dz);
    };
    if (!atRest || anchor >= 2)
        return f => f;
    if (anchor === 0) {
        return f => {
            if (f <= 0)
                return 0;
            if (f <= 1)
                return track(f);
            return end + (f - 1) * (2 - end);          // only reachable with long swipes
        };
    }
    return f => {
        if (f >= 1)
            return f;
        return 1 - track(1 - Math.max(f, 0));
    };
}

export function slopeOf(remap, f) {
    const h = 0.002;
    return (remap(f + h) - remap(f - h)) / (2 * h);
}

// -- 2. the release -----------------------------------------------------------------------------------------------------

export const WINDOW_MS = 50;
export const SPEED_WINDOW_MS = 40;
export const MIN_STALE_MS = 16;
export const TOL_PX = 0.5;
export const MIN_T_MS = 40;
export const MAX_T_MS = 1500;

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

/** Finger velocity at lift-off in input units per ms (copy of gesture-history's estimator). */
export function estimateReleaseVelocity(data, releaseTime, gnomeVelocity = 0) {
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
        return Number.isFinite(gnomeVelocity) ? gnomeVelocity : 0;
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
    if (!Number.isFinite(end) || end * line < 0 || Math.abs(end) > 2.5 * Math.abs(line) + 0.05)
        return line;
    return end;
}

export function springOmega(tune, e0, v0, slowDown) {
    const slow = Number.isFinite(slowDown) && slowDown > 0 ? slowDown : 1;
    return Math.max(tune.omegaRef, tune.cStiff * Math.abs(v0) / Math.abs(e0)) / slow;
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

export function springDuration(e0, v0, w, basePx) {
    const tol = TOL_PX / basePx;
    let last = 0;
    for (let t = 0; t <= 4000; t += 1) {
        if (Math.abs(springError(t, e0, v0, w)) > tol)
            last = t;
    }
    return Math.min(MAX_T_MS, Math.max(MIN_T_MS, Math.ceil(last + 1)));
}

export function planRelease(tune, start, target, v0, slowDown, basePx) {
    const e0 = start - target;
    if (![e0, v0, basePx].every(Number.isFinite) || Math.abs(e0) < 1e-6 || !(basePx > 0))
        return null;
    const w = springOmega(tune, e0, v0, slowDown);
    const T = springDuration(e0, v0, w, basePx);
    return {e0, v0, w, T, start, target};
}

// -- 3. the followers of the depth model -----------------------------------------------------------------------------------

/** value at time t - lagMs from a short history of {t, p} (ms); clamps at the oldest sample */
export function lagged(history, t, lagMs) {
    const want = t - lagMs;
    if (history.length === 0)
        return 0;
    if (want <= history[0].t)
        return history[0].p;
    for (let i = history.length - 1; i > 0; i--) {
        const a = history[i - 1], b = history[i];
        if (want >= a.t) {
            const u = b.t > a.t ? (want - a.t) / (b.t - a.t) : 1;
            return a.p + (b.p - a.p) * clamp(u);
        }
    }
    return history[history.length - 1].p;
}

/** single positive bump (t/tau) e^(1 - t/tau): 0 at 0, 1 at t = tau, monotone decay afterwards (never negative) */
export function bump(t, delay, tau) {
    const x = (t - delay) / tau;
    if (x <= 0)
        return 0;
    return x * Math.exp(1 - x);
}

/** the concept's shadow-depth rebound: 0 until `a` ms after the release, one smooth lobe, 0 again at `b` ms */
export function shadowRebound(msSinceRelease, a = 100, b = 620) {
    if (msSinceRelease <= a || msSinceRelease >= b)
        return 0;
    const x = (msSinceRelease - a) / (b - a);
    return (1 - Math.cos(2 * Math.PI * x)) / 2;
}

/** second-order follower g'' = wn^2 (target - g) - 2 zeta wn g' (state in/out), semi-implicit Euler with small steps */
export function stepFollower(s, target, dtMs, wn, zeta) {
    let remain = Math.min(250, Math.max(0, dtMs)) / 1000;      // never more than 500 steps, whatever the caller passes
    const h = 0.0005;
    while (remain > 1e-9) {
        const dt = Math.min(h, remain);
        const a = wn * wn * (target - s.g) - 2 * zeta * wn * s.v;
        s.v += a * dt;
        s.g += s.v * dt;
        remain -= dt;
    }
    return s;
}

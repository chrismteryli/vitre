// Pure motion math for swipe-depth (no GNOME imports, so it can be unit-tested with node).
//
// Three parts:
//  1. the finger -> overview-progress map (dead zone, then linear), per gesture anchor;
//  2. the release: the liquid engine's track spring (liquid.js, feel A Viscous) that starts at the progress the finger
//     left and the speed it had, and rests when the remaining step is under a quarter pixel (the estimator is the same
//     as vitre-gesture-history's releaseMotion.js);
//  3. the followers of the depth model are engine springs too (see DepthEngine.tick): the wallpaper on the fade role, the
//     lift as a trailing copy of the release (track x viscosity), the piles on the bead role, the landing pop and the
//     shadow rebound as bead kicks sized by the release speed.

import {Plan, Spring, role, epsFor} from './liquid.js';

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

/**
 * The release: the track spring from `start` (moving at v0, progress per ms) to `target`. Times in motion ms; `slowDown` > 1
 * (rig films) stretches them, a slow-down below 1 (Just Perfection's speed-up) does not touch the spring (its role is its feel).
 * `roleName`: 'track' for a gesture's release, 'glide' for the overview opened or closed by a key or a click (Vitre Motion
 * Lab 2: the windows on glide). `stopAt`: the value is never carried past the target on the way up (the overview state
 * past the window picker is the app grid; on the way down the adjustment itself stops at 0).
 * Returns {e0, v0, T, start, target, at(t), progress(t)} (progress: 0..1 of start -> target, exactly 1 for t >= T) or null.
 */
export function planRelease(start, target, v0, slowDown, basePx, roleName = 'track', stopAt = false) {
    const e0 = start - target;
    if (![e0, v0, basePx].every(Number.isFinite) || Math.abs(e0) < 1e-6 || !(basePx > 0))
        return null;
    const slow = Number.isFinite(slowDown) && slowDown > 1 ? slowDown : 1;
    const plan = new Plan({from: start, to: target, v0: v0 * 1000, p: role(roleName), eps: epsFor(basePx)});
    const T = Math.max(1, Math.ceil(plan.T * 1000 * slow));
    const up = target > start;
    const at = t => {
        if (t >= T)
            return target;
        const x = plan.at(t / slow / 1000);
        return stopAt && up ? Math.min(target, x) : x;
    };
    return {e0, v0, T, start, target, role: roleName, at, progress: t => (at(t) - start) / (target - start)};
}

// the peak of a bead spring kicked from rest with unit speed (a kick of 1 / BEAD_PEAK peaks at 1)
function kickPeak(p) {
    const s = new Spring(0, p, 1e-9);
    s.kick(1);
    let m = 0;
    for (let i = 0; i < 2000; i++)
        m = Math.max(m, s.step(1 / 1000));
    return m;
}
export const BEAD_PEAK = kickPeak(role('bead'));
export const BEAD_TRAIL_PEAK = kickPeak(role('bead', {trail: true}));

// -- 3. the followers of the depth model -----------------------------------------------------------------------------------

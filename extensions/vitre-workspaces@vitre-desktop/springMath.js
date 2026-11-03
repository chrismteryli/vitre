// SPDX-License-Identifier: GPL-3.0-or-later
// Vitre Workspaces: the pure math (no GNOME imports, so node can test it).
//
// Units: positions are workspace "progress" (GNOME's MonitorGroup.progress: one workspace = 1.0), times are motion
// milliseconds, velocities are progress per millisecond. A plan is a function of time only, so whatever drives it (a
// Clutter transition, the tail after the switch has ended, a film running N times slower) draws the same curve.

import {Plan, role, REDUCED, epsFor, EPS_OPACITY, rubber} from './liquid.js';

// ---- the motion: the liquid engine's track role (liquid.js, feel A Viscous) ---------------------------------------------
// v3 (liquid): one spring with state {x, v} on the track role (response 0.42 s, damping 0.90). A release starts at the
// finger's position and speed, a key press starts from rest (or keeps the speed of the motion it interrupts), and the
// spring rests (snaps) only when the remaining step is under a quarter pixel: no land blend, no flick stiffening, no
// cap on a speed away from the target.
export const SPRING = {
    role: 'track',
    tolLogicPx: 12,     // the switch itself (input, mutter) ends once the picture stays within this many px ...
    minLogicMs: 120,    // ... never before this
    rubberR: 0.16,      // past the first or last workspace a drag meets this resistance: it can never go further (workspaces)
};

// ---- reduced motion: an in-place cross-fade --------------------------------------------------------------------------
export const FADE = {ms: 160};

export const clamp01 = v => Math.min(1, Math.max(0, v));
export const smoothstep = (a, b, v) => {
    const s = clamp01((v - a) / (b - a));
    return s * s * (3 - 2 * s);
};

export {rubber};

// Plans: {from, to, v0, T, Tlogic, kind, at(t), vel(t)} with t in motion ms and velocities in progress per ms (the units
// depthMotion and overviewScroll work in); the values come from the engine's spring (liquid.js Plan, stepped in seconds).
function wrap(plan, from, to, v0, unitPx, kind, p) {
    const T = plan.T * 1000;
    const tolLogic = SPRING.tolLogicPx / unitPx;
    let lastLogic = 0;
    for (let t = 1; t <= T; t += 1) {
        if (Math.abs(plan.at(t / 1000) - to) > tolLogic)
            lastLogic = t;
    }
    const Tlogic = Math.min(T, Math.max(Math.min(SPRING.minLogicMs, T), lastLogic + 1));
    return {from, to, v0, T, Tlogic, kind, role: kind === 'fade' ? 'reduced' : SPRING.role, response: p.r, damping: p.z,
        at: t => plan.at(t / 1000), vel: t => plan.vel(t / 1000) / 1000};
}

/**
 * One spring motion from `from` (moving at `v0`, progress per ms) to `to`.
 *
 * @param {object} p - {from, to, v0, unitPx (px per progress unit: the rest tolerance is a quarter of one of them)}
 * @returns {object|null} {from, to, v0, T, Tlogic, kind, at(t), vel(t)}; null when the inputs make no sense
 */
export function planSpring({from, to, v0 = 0, unitPx = 2020}) {
    if (![from, to, v0, unitPx].every(Number.isFinite) || !(unitPx > 0))
        return null;
    if (Math.abs(from - to) < 1e-9 && Math.abs(v0) < 1e-9)
        return {from, to, v0: 0, T: 0, Tlogic: 0, kind: 'spring', at: () => to, vel: () => 0};
    const p = role(SPRING.role);
    const plan = new Plan({from, to, v0: v0 * 1000, p, eps: epsFor(unitPx)});
    return wrap(plan, from, to, v0, unitPx, 'spring', p);
}

/** reduced motion: progress goes from `from` to `to` on the 160 ms cross-fade spring (critically damped, no overshoot) */
export function planFade({from, to}) {
    if (![from, to].every(Number.isFinite))
        return null;
    if (Math.abs(from - to) < 1e-9)
        return {from, to, v0: 0, T: 0, Tlogic: 0, kind: 'fade', at: () => to, vel: () => 0};
    // a 0..1 cross-fade, mapped onto the progress
    const u = new Plan({from: 0, to: 1, p: REDUCED, eps: EPS_OPACITY});
    const T = u.T * 1000;
    return {from, to, v0: 0, T, Tlogic: T, kind: 'fade', role: 'reduced',
        at: t => t >= T ? to : from + (to - from) * u.at(t / 1000),
        vel: t => t >= T ? 0 : (to - from) * u.vel(t / 1000) / 1000};
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

/** {x (px offset of the card's centre from the monitor's centre), scale, dim (0..1), edge (0..1), rim (0..1), side}.
 *  speed: the motion's speed in workspaces per second; a card steps back with speed as well as with distance (v3 liquid:
 *  desktops sink with velocity), so a fast switch reads deeper than a slow one. 0 at rest: the look is unchanged there. */
export function lookAt(u, extentPx, look = LOOK, speed = 0) {
    const sp = Math.min(1, Math.abs(speed) / 3);
    const r = Math.max(depthOf(u, look), sp * 0.7);
    const a = Math.abs(u);
    return {
        x: u * (extentPx + look.gapPx),
        scale: 1 - look.sink * r - 0.025 * sp,
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

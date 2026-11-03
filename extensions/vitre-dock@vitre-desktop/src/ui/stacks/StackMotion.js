/*
* Dhruva GNOME Extension
* Copyright (C) 2026 NarkAgni
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Vitre (B5): the motion of a stack's fan, as pure functions of time. It is Vitre's "stretch": every item leaves the
// stack on one damped spring and its edge nearest the Dock follows a little later, so the item is pulled out of the stack
// (longer while it moves fast) and lands at its own size. Same spring as Vitre's menus (vitre-menus dripMotion.js
// STRETCH): 400 ms response, damping 0.86, the near edge 34 ms behind, items further away leave up to 70 ms later.

import GLib from 'gi://GLib';

export const FAN_MOTION = {
    responseMs: 400,
    damping: 0.86,
    lagMs: 34,
    staggerPerPx: 0.12,
    staggerMaxMs: 70,
    landMs: 80,          // the last 80 ms ease the spring onto its exact target (no last-pixel creep, crisp at rest)
    fromScale: 0.42,     // an item leaves the stack at this size ...
    labelFrom: 0.45,     // ... and its name fades in from this far along
    closeMs: 210,        // close: every item goes back into the stack (accelerating), the far ones first
    closeStaggerMaxMs: 40,
    closeLagMs: 22,
    labelOutMs: 70,
    fadeInMs: 150,       // reduced motion: a plain fade
    fadeOutMs: 120,
    settle: 0.004,
};

export const clamp01 = v => Math.min(1, Math.max(0, v));
export const lerp = (a, b, s) => a + (b - a) * s;
export const smoothstep = (a, b, v) => {
    const s = clamp01((v - a) / (b - a));
    return s * s * (3 - 2 * s);
};
export const easeInCubic = u => {
    const v = clamp01(u);
    return v * v * v;
};

export function springAt(t, responseMs = FAN_MOTION.responseMs, damping = FAN_MOTION.damping) {
    if (t <= 0) return 0;
    const w0 = 2 * Math.PI / (responseMs / 1000);
    const ts = t / 1000;
    if (damping >= 1) return 1 - Math.exp(-w0 * ts) * (1 + w0 * ts);
    const wd = w0 * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * w0 * ts) * (Math.cos(wd * ts) + damping * w0 / wd * Math.sin(wd * ts));
}

let _settleMs = null;
export function springSettleMs() {
    if (_settleMs === null) {
        let last = 0;
        for (let t = 0; t <= 3000; t++) {
            if (Math.abs(1 - springAt(t)) > FAN_MOTION.settle) last = t;
        }
        _settleMs = last + 1;
    }
    return _settleMs;
}

// open: far / near progress (0 = in the stack, 1 = landed) of an item `st` ms late, at `t` ms
export function openProgress(t, st) {
    const doneAt = st + FAN_MOTION.lagMs + springSettleMs();
    const land = smoothstep(doneAt - FAN_MOTION.landMs, doneAt, t);
    const raw = x => springAt(x);
    const far = raw(t - st) + (1 - raw(t - st)) * land;
    const near = raw(t - st - FAN_MOTION.lagMs) + (1 - raw(t - st - FAN_MOTION.lagMs)) * land;
    return { far, near, done: t >= doneAt, doneAt };
}

// close from progress `from` (an open that was interrupted closes from where it is): lead = the edge going first
export function closeProgress(t, st, from = 1) {
    const d = FAN_MOTION.closeMs * Math.max(0.35, from);
    const lead = from * (1 - easeInCubic((t - st) / d));
    const trail = from * (1 - easeInCubic((t - st - FAN_MOTION.closeLagMs) / d));
    return { lead: clamp01(lead), trail: clamp01(trail), done: t >= st + FAN_MOTION.closeLagMs + d };
}

// the rig films the motion slowed down; same switch as Vitre's other motion
const ENV_SLOW = Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1;
export function motionSlow() {
    return Math.max(1, Number(globalThis.__vitreMotionSlow) || ENV_SLOW);
}

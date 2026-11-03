// Vitre liquid motion engine v3. Pure math: no GI, no DOM, so gjs, node and the browser lab load the same file.
// One file for the whole desktop: every Vitre extension that moves something carries this exact file (byte-identical,
// checked by tools/check-engine.sh), instead of the drifting copies of dripMotion.js / liquidDrip.js / springMath.js.
//
// One rule set for the whole desktop:
//   1. Everything that moves is a damped spring with state {x, v}. Retargeting keeps velocity, so any motion can be
//      interrupted or reversed mid-flight without a step in speed.
//   2. A spring is named by its role (bead, pour, glide, track) and described by response (period, s) and damping ratio.
//   3. Exits use the same spring, faster (response x exit.rMul) and never bouncing (damping >= exit.zMin).
//   4. Opacity and blur use the 'fade' role: critically damped, never past the target.
//   5. Liquid stretch comes from viscosity: the trailing edge of a shape is a slower copy of the leading edge's spring
//      (response x visc). It grows with speed and relaxes on its own; it is never a fixed time delay.
//   6. Anything that falls or hops does so under gravity (px/s^2); its landing squash starts from the impact speed.
//   7. Squash and stretch keep area: across = along^-volume.
//   8. A spring is done when it is within eps of its target and slower than eps*20 per second. Then it snaps: the
//      remaining step is sub-pixel, so there is no 'land' blend that bends the tail.
//   9. Reduced motion is its own feel (FEELS.reduced, lab 2): every role 0.16 s critically damped, viscosity 1, no
//      volume, no gravity, exits unchanged. REDUCED below is the same 160 ms rest spring for the cross-fade surfaces.
//
// Sections 1-3 are the lab's engine (Vitre Motion Lab, liquid.js) unchanged, without the lab-only helpers that replay
// v2's curves. Section 4 holds what the desktop needs on top: pixel tolerances, reduced motion, time plans for code that
// is driven by elapsed time (GNOME's own effect carriers, slow-motion films), lead/trail edge pairs and the gravity hop.

// ---- 1. feels and roles ----------------------------------------------------------------------------------------------
export const FEELS = {
    v2: {
        label: 'v2 · today',
        bead: {r: 0.40, z: 0.86}, pour: {r: 0.40, z: 0.86}, glide: {r: 0.40, z: 0.86}, track: {r: 0.40, z: 0.86},
        fade: {r: 0.24, z: 1},
        visc: 1.085,        // dripMotion STRETCH.lagMs 34 at a 400 ms period
        volume: 0,
        gravity: 0,         // keyframed hop (vitre-window-open HOP)
        magnify: 1.6,
        exit: {rMul: 0.75, zMin: 1},
        legacy: true,
    },
    viscous: {
        label: 'A · Viscous',
        bead: {r: 0.34, z: 0.68}, pour: {r: 0.46, z: 0.76}, glide: {r: 0.52, z: 0.82}, track: {r: 0.42, z: 0.90},
        fade: {r: 0.22, z: 1},
        visc: 1.5,
        volume: 0.5,
        gravity: 1300,
        magnify: 1.62,
        exit: {rMul: 0.8, zMin: 0.94},
    },
    reduced: {
        label: 'Reduced motion',
        bead: {r: 0.16, z: 1}, pour: {r: 0.16, z: 1}, glide: {r: 0.16, z: 1}, track: {r: 0.16, z: 1},
        fade: {r: 0.16, z: 1},
        visc: 1,
        volume: 0,
        gravity: 0,
        magnify: 1,
        exit: {rMul: 1, zMin: 1},
    },
    mercury: {
        label: 'B · Mercury',
        bead: {r: 0.26, z: 0.54}, pour: {r: 0.36, z: 0.62}, glide: {r: 0.42, z: 0.72}, track: {r: 0.34, z: 0.82},
        fade: {r: 0.18, z: 1},
        visc: 1.2,
        volume: 0.85,
        gravity: 1900,
        magnify: 1.72,
        exit: {rMul: 0.72, zMin: 0.88},
    },
};

// The desktop's feel (the lab page default, the owner's pick for v3).
export const FEEL = 'viscous';

export const ROLES = {
    bead: 'Small things: Dock icons, pills, toggles, indicators, the HUD level',
    pour: 'Surfaces that leave a source: menus, Control Center, notifications, HUD, stacks',
    glide: 'Windows: open, minimize, restore, snap, fullscreen',
    track: 'Gesture releases: workspaces, overview, swipe-back',
    fade: 'Opacity and blur only',
};

export function params(feel, role, {exit = false, trail = false} = {}) {
    const f = FEELS[feel] ?? FEELS.viscous;
    let {r, z} = f[role];
    if (exit) {
        r *= f.exit.rMul;
        z = Math.max(z, f.exit.zMin);
    }
    if (trail)
        r *= f.visc;
    return {r, z};
}

// ---- 2. the spring ---------------------------------------------------------------------------------------------------
export class Spring {
    constructor(x = 0, p = {r: 0.4, z: 0.86}, eps = 0.05) {
        this.x = x;
        this.v = 0;
        this.to = x;
        this.p = p;
        this.eps = eps;
    }

    set(to, p) {
        this.to = to;
        if (p)
            this.p = p;
        return this;
    }

    snap(x) {
        this.x = this.to = x;
        this.v = 0;
        return this;
    }

    kick(v) {
        this.v += v;
        return this;
    }

    get rest() {
        return this.x === this.to && this.v === 0;
    }

    step(dt) {
        if (this.rest || !(dt > 0))
            return this.x;
        const w = 2 * Math.PI / this.p.r;
        const k = w * w, c = 2 * this.p.z * w;
        let rem = dt;
        while (rem > 1e-9) {
            const h = Math.min(rem, 1 / 600);
            const a = -k * (this.x - this.to) - c * this.v;
            this.v += a * h;
            this.x += this.v * h;
            rem -= h;
        }
        if (Math.abs(this.x - this.to) < this.eps && Math.abs(this.v) < this.eps * 20)
            this.snap(this.to);
        return this.x;
    }
}

// percent past the target for a step input
export function overshoot({z}) {
    return z >= 1 ? 0 : Math.exp(-Math.PI * z / Math.sqrt(1 - z * z));
}

// ms until a unit step stays within tol
export function settleMs(p, tol = 0.004) {
    const s = new Spring(0, p, 1e-6).set(1);
    let last = 0;
    for (let t = 1; t <= 3000; t++) {
        s.step(0.001);
        if (Math.abs(s.x - 1) > tol)
            last = t;
    }
    return last;
}

export function stepResponse(p, ms = 900, n = 90) {
    const s = new Spring(0, p, 1e-6).set(1);
    const out = [0];
    const dt = ms / n / 1000;
    for (let i = 1; i <= n; i++)
        out.push(s.step(dt));
    return out;
}

// ---- 3. shape helpers ------------------------------------------------------------------------------------------------
// area-keeping squash/stretch: s > 0 stretches along the axis
export function squash(s, volume) {
    const along = Math.max(0.4, 1 + s);
    return {along, across: Math.pow(along, -volume)};
}

// release velocity from pointer samples [{t (s), p}], least squares over the last windowS
export function releaseVelocity(samples, windowS = 0.08) {
    if (samples.length < 2)
        return 0;
    const tEnd = samples[samples.length - 1].t;
    const w = samples.filter(s => s.t >= tEnd - windowS);
    if (w.length < 2)
        return 0;
    const tm = w.reduce((a, s) => a + s.t, 0) / w.length;
    const pm = w.reduce((a, s) => a + s.p, 0) / w.length;
    let num = 0, den = 0;
    for (const s of w) {
        num += (s.t - tm) * (s.p - pm);
        den += (s.t - tm) ** 2;
    }
    return den > 0 ? num / den : 0;
}

// past the ends of a track: resistance that never stops (rubber band), R = how far it can ever go
export function rubber(over, R) {
    const a = Math.abs(over);
    return Math.sign(over) * R * (1 - 1 / (1 + a / R));
}

// ---- 4. desktop helpers ----------------------------------------------------------------------------------------------
// A spring snaps when the remaining step is under a quarter pixel (rule 8). For a spring in other units, eps is a quarter
// pixel expressed in them: epsFor(spanPx) for a 0..1 spring that moves something spanPx far.
export const EPS_PX = 0.25;
export const EPS_OPACITY = 0.5 / 255;         // half of one 8-bit opacity step
export function epsFor(spanPx) {
    return EPS_PX / Math.max(1, Math.abs(spanPx));
}

// The desktop's role parameters (FEEL), with the same options as params().
export function role(name, opts) {
    return params(FEEL, name, opts);
}
export const feel = () => FEELS[FEEL];

// Reduced motion (rule 9): a 160 ms cross-fade in place. The cross-fade is the fade role's spring (critically damped, so it
// never overshoots) with a response chosen so that it comes to rest (within EPS_OPACITY, the spring's own test) at 160 ms.
export const REDUCED_MS = 160;
export const REDUCED = (() => {
    // the response for which a 0 -> 1 spring (rest tolerance EPS_OPACITY, the spring's own rest test) rests at REDUCED_MS
    const restMs = r => {
        const s = new Spring(0, {r, z: 1}, EPS_OPACITY).set(1);
        let t = 0;
        while (!s.rest && t < 2000) {
            s.step(0.001);
            t++;
        }
        return t;
    };
    let lo = 0.02, hi = 0.3;
    for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (restMs(mid) > REDUCED_MS)
            hi = mid;
        else
            lo = mid;
    }
    return {r: lo, z: 1};
})();

// Time plan: the same spring, stepped by the same integrator, as a function of elapsed time. For code that is driven by a
// clock it does not own (a GNOME effect's carrier transition, a filmed frame at N times slow motion): at(t) and vel(t)
// take seconds since the start; T is when the spring comes to rest (snaps). Queries may go back in time (a film replays):
// the plan steps forward from the nearest cached state.
//   from, to: values; v0: start velocity (units per second); p: {r, z}; eps: rest tolerance in the same units
export class Plan {
    constructor({from, to, v0 = 0, p, eps = 0.05, maxS = 6}) {
        this.from = from;
        this.to = to;
        this.v0 = v0;
        this.p = p;
        this.eps = eps;
        // step once to rest at 1 ms, keeping checkpoints every 16 ms for random access
        const s = new Spring(from, p, eps).set(to);
        s.v = v0;
        if (from === to && v0 === 0)
            s.snap(to);
        this._marks = [{t: 0, x: s.x, v: s.v}];
        let t = 0;
        const H = 0.001;
        while (!s.rest && t < maxS) {
            s.step(H);
            t += H;
            if (Math.round(t * 1000) % 16 === 0)
                this._marks.push({t, x: s.x, v: s.v});
        }
        if (!s.rest)
            s.snap(to);         // only a pathological input (a response far beyond any role) runs this long
        this.T = t;
        this._cur = null;
    }

    _state(t) {
        if (!(t > 0))
            return {x: this.from, v: this.v0};
        if (t >= this.T)
            return {x: this.to, v: 0};
        let c = this._cur;
        if (!c || c.t > t + 1e-12) {
            const m = this._marks[Math.min(this._marks.length - 1, Math.floor(t / 0.016))];
            const s = new Spring(m.x, this.p, this.eps).set(this.to);
            s.v = m.v;
            c = this._cur = {t: m.t, s};
        }
        if (t > c.t) {
            // no snap before T: the plan's own rest time decides the end, so at() is continuous up to T
            const eps = c.s.eps;
            c.s.eps = 0;
            c.s.step(t - c.t);
            c.s.eps = eps;
            c.t = t;
        }
        return {x: c.s.x, v: c.s.v};
    }

    at(t) {
        return this._state(t).x;
    }

    vel(t) {
        return this._state(t).v;
    }

    done(t) {
        return t >= this.T;
    }
}

// A lead/trail pair (rule 5): two springs that go to the same place, the trail one on the role's response x viscosity.
// A shape whose leading edge is on `lead` and trailing edge on `trail` stretches with speed and relaxes on its own.
export function pair(roleName, opts = {}) {
    return {lead: role(roleName, opts), trail: role(roleName, {...opts, trail: true})};
}

// Hop under gravity (rule 6): {y (px, up is negative), vy}; launch with hopLaunch(height); stepHop returns the impact speed
// (px/s, > 0) in the frame it lands, else 0. The squash at landing is a kick of the squash spring from that speed.
export function hopLaunch(heightPx, g = feel().gravity) {
    return -Math.sqrt(2 * g * heightPx);
}

export function stepHop(h, dt, g = feel().gravity) {
    h.vy += g * dt;
    h.y += h.vy * dt;
    if (h.y >= 0 && h.vy > 0) {
        const impact = h.vy;
        h.y = 0;
        h.vy = 0;
        return impact;
    }
    return 0;
}

// Opacity and blur (rule 4): the fade role's spring, which never passes its target. A critically damped spring cannot
// overshoot from rest, but one retargeted while it moves fast toward the new target could cross it once: the crossing is
// where it stops.
export class Fade extends Spring {
    constructor(x = 0, p = role('fade'), eps = EPS_OPACITY) {
        super(x, p, eps);
    }

    step(dt) {
        const side = Math.sign(this.x - this.to);
        super.step(dt);
        if (side !== 0 && Math.sign(this.x - this.to) === -side)
            this.snap(this.to);
        return this.x;
    }
}

// Is anything in this list still moving?
export function moving(springs) {
    for (const s of springs) {
        if (!s.rest)
            return true;
    }
    return false;
}

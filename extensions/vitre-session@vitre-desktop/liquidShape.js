// The lab's glass Shape (Vitre Motion Lab 2, lab.js Shape), for surfaces that pour out of a source without the shader field:
// six edge springs (top y, bottom y, top and bottom centre x, top and bottom half widths). go() puts the leading edges on the
// role's spring and the trailing ones on the same spring x viscosity, so the shape stretches with speed and relaxes on its
// own. box() is the rectangle the surface follows. Pure math on liquid.js: no GI, node can load it.
// Byte-identical copies in vitre-banners, vitre-search and vitre-session (an engine helper candidate: PROGRESS-A.md).
import {Spring, EPS_PX} from './liquid.js';

export const KEYS = ['tY', 'bY', 'tCx', 'bCx', 'tHw', 'bHw'];

// a rectangle {x, y, w, h} as a shape; bottomHw / topHw scale the half widths (a pill's narrower neck)
export const geomOf = (r, bottomHw = 1, topHw = 1) => ({
    tY: r.y, bY: r.y + r.h, tCx: r.x + r.w / 2, bCx: r.x + r.w / 2, tHw: r.w / 2 * topHw, bHw: r.w / 2 * bottomHw,
});

export class Shape {
    constructor(eps = EPS_PX) {
        KEYS.forEach(k => (this[k] = new Spring(0, undefined, eps)));
        this.hidden = true;
        this.from = this.target = null;
    }

    snapTo(g) {
        KEYS.forEach(k => this[k].snap(g[k]));
        this.hidden = false;
        this.from = this.target = g;
    }

    // bottomLeads: the bottom edge (and the bottom width) on `lead`, the top on `trail`, or the other way round;
    // widthsLead: both half widths on `lead`
    go(g, lead, trail, bottomLeads = true, widthsLead = false) {
        this.hidden = false;
        this.from = this.now();
        this.target = g;
        KEYS.forEach(k => this[k].set(g[k], (widthsLead && k.endsWith('Hw')) || (k[0] === 'b') === bottomLeads ? lead : trail));
    }

    // the target moved (the surface's rectangle changed while it pours): same springs, same start, new target
    retarget(g) {
        this.target = g;
        KEYS.forEach(k => this[k].set(g[k]));
    }

    now() {
        const o = {};
        KEYS.forEach(k => (o[k] = this[k].x));
        return o;
    }

    step(dt) {
        KEYS.forEach(k => this[k].step(dt));
    }

    get rest() {
        return KEYS.every(k => this[k].rest);
    }

    progress() {
        if (!this.from || !this.target)
            return 1;
        let d0 = 0, d = 0;
        for (const k of KEYS) {
            d0 += Math.abs(this.target[k] - this.from[k]);
            d += Math.abs(this.target[k] - this[k].x);
        }
        return d0 < 1e-6 ? 1 : 1 - d / d0;
    }

    box() {
        const x0 = Math.min(this.tCx.x - this.tHw.x, this.bCx.x - this.bHw.x);
        const x1 = Math.max(this.tCx.x + this.tHw.x, this.bCx.x + this.bHw.x);
        const y0 = Math.min(this.tY.x, this.bY.x), y1 = Math.max(this.tY.x, this.bY.x);
        return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
    }
}

/* VitreSearch motion (liquid v3, Motion Lab 2 for the open and close): every track is a liquid.js spring, stepped by the
 * controller once per frame. No measured tables any more. No GI imports here: node can load this file for the unit tests.
 *
 *   OPEN      the glass pours out of a pill in the top bar into the field (liquidShape.js Shape: the bottom edge and both
 *             widths lead on the pour spring, the top trails on pour x viscosity); the field's content fades in on the fade
 *             role once the glass is 55 % of the way. The glass itself comes up on the fade role from the first frame (the
 *             desktop has no search pill to pour out of: the drop of glass appears where one would be).
 *   CLOSE     the content goes on a short {r: 0.1, z: 1} fade and the glass drains back into the pill on the pour exit spring
 *             (the top edge and the widths lead, never bouncing); past 60 % of the way the glass fades on the fade exit spring.
 *             A reopen while it drains pours back out from where it is, with its speed.
 *   ROWS      result rows pour in top to bottom: row i waits 0.03 + i x 0.035 s, then its opacity rises on the fade role and
 *             it drops into place from -10 px on the pour spring; a row that goes leaves on {r: 0.1, z: 1} (RowMotion).
 *   PANEL     the results panel's height on the pour spring (taller) or its exit spring (shorter).
 *   SPLIT     the bar pinches off four round buttons: the bar's right edge retracts on the pour spring while the buttons
 *             spill out of its end, right to left (pour, a short spill delay each, as the lab's Dock stack), and grow
 *             round (bead); the union softness melts as they separate; the glyphs fade in once they are whole. Merging
 *             back is the same springs retargeted (velocity kept).
 *   Reduced motion: no travel, no growth: the opacity crosses on the 160 ms spring; rows, the panel and the split are set
 *   at once (rows cross-fade).
 */
import {Spring, Fade, role, feel, REDUCED, EPS_PX, EPS_OPACITY} from './liquid.js';
import {Shape, geomOf} from './liquidShape.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, s) => a + (b - a) * s;
// a mapping of a spring's state onto 0..1 with soft ends (a look, never a time curve)
const smoothstep = (a, b, v) => {
    const s = clamp((v - a) / (b - a), 0, 1);
    return s * s * (3 - 2 * s);
};

// ---------------------------------------------------------------------------------------------
// Geometry (logical px). H and W0 follow the measured proportions: the wide bar is 961 px for an
// 85 px bar in the a reference recording recording (11.3 : 1), so 64 x 720 here (11.25 : 1).
export const GEO = {
    H: 64,              // bar height
    W0: 720,            // wide (unsplit) bar width
    D: 67,              // button diameter (measured 72/68 units = 1.06 x bar height; plan said = height)
    RHO: 33.5,          // button radius
    C_FINAL: [474, 544.5, 615.5, 686.5],  // final button centres from the bar's left edge
    BAR_SPLIT: 433.5,   // the bar's right edge once the buttons have left (measured 606 of the 143..912 crop units)
    PANEL_R: 34,        // corner radius of the results panel
    TOP_FRACTION: 0.19, // bar top as a fraction of the monitor height (ESTIMATE: the reference design places it a
                        // little above the upper third)
};

export const CLOSE_BLUR_PT = 8;         // reduced motion's close blurs up to this (the v3 dematerialize, without travel)
export const CONTENT_FROM = 0.55;       // the content fades in once the glass is this far along (lab 2)
export const CONTENT_OUT = {r: 0.1, z: 1};      // the content (and a row) leaving (lab 2)
export const GLASS_OUT_FROM = 0.6;      // a drain fades the glass once it is this far home
export const ROW_DELAY = 0.03;          // s before the first row ...
export const ROW_STEP = 0.035;          // ... and between rows (lab 2)
export const ROW_FROM_Y = -10;          // px a row drops from
const SPILL_S = 0.022;                  // a button leaves the bar this much after the one to its right (the lab's viscous stack)
const K_JOINED = 28;                    // union softness while the buttons are still one blob with the bar ...
const K_APART = 3;                      // ... and once they are apart
const ICONS_FROM = 0.6;                 // the glyphs fade in once the split is this far along

// The show track: the glass shape between the pill and the field, the glass's and the content's alpha.
//   open(reduced, src, rect) / close(reduced, rect): src = the pill's shape, rect = the field's rectangle {x, y, w, h}, both in
//   the controller's group coordinates. frame(): {box, glass, alpha (the content), blur}
export class ShowMotion {
    constructor() {
        this.sh = new Shape(EPS_PX);
        this.glass = new Fade(0, role('fade'), EPS_OPACITY);
        this.alpha = new Fade(0, role('fade'), EPS_OPACITY);
        this.mode = 'closed';
        this.reduced = false;
        this.src = null;
        this.rect = null;
    }

    open(reduced, src, rect) {
        this.reduced = reduced;
        this.rect = rect;
        if (reduced) {
            this.sh.snapTo(geomOf(rect));
            this.glass.set(1, REDUCED);
            this.alpha.set(1, REDUCED);
            this.mode = 'opening';
            return;
        }
        if (this.mode === 'closed' || this.sh.hidden) {
            this.sh.snapTo(src);
            this.glass.snap(0);
            this.alpha.snap(0);
        }
        this.src = src;
        this.sh.go(geomOf(rect), role('pour'), role('pour', {trail: true}), true, true);
        this.glass.set(1, role('fade'));
        this.mode = 'opening';
    }

    close(reduced, rect = this.rect) {
        const from = this.mode;
        this.mode = 'closing';
        this.reduced = reduced;
        if (reduced || !this.src) {
            this.reduced = true;
            this.glass.set(0, REDUCED);
            this.alpha.set(0, REDUCED);
            return;
        }
        // from rest the shape starts on the field as it is now (the results panel included)
        if (from === 'open' && rect)
            this.sh.snapTo(geomOf(rect));
        this.alpha.set(0, CONTENT_OUT);
        const pe = role('pour', {exit: true});
        this.sh.go(this.src, pe, {r: pe.r * feel().visc, z: pe.z}, false, true);
    }

    // the field's rectangle changed while the glass pours in (the panel grows under typing): same springs, new target
    retarget(rect) {
        this.rect = rect;
        if (this.mode === 'opening' && !this.reduced)
            this.sh.retarget(geomOf(rect));
        else if (this.reduced || this.mode === 'open')
            this.sh.snapTo(geomOf(rect));
    }

    // instant (animations off)
    settle(open, rect = this.rect) {
        this.glass.snap(open ? 1 : 0);
        this.alpha.snap(open ? 1 : 0);
        if (rect)
            this.sh.snapTo(geomOf(rect));
        this.mode = open ? 'open' : 'closed';
    }

    step(dt) {
        this.sh.step(dt);
        if (this.mode === 'opening' && !this.reduced && this.sh.progress() > CONTENT_FROM)
            this.alpha.set(1, role('fade'));
        if (this.mode === 'closing' && !this.reduced && this.sh.progress() > GLASS_OUT_FROM)
            this.glass.set(0, role('fade', {exit: true}));
        this.glass.step(dt);
        this.alpha.step(dt);
        if (this.mode === 'opening' && this.sh.rest && this.glass.rest && this.alpha.rest && this.alpha.x === 1)
            this.mode = 'open';
        if (this.mode === 'closing' && (this.reduced ? this.glass.rest && this.glass.x === 0
            : this.alpha.rest && (this.sh.rest || this.sh.progress() > 0.995)))
            this.mode = 'closed';
        return this.frame();
    }

    get moving() {
        return this.mode === 'opening' || this.mode === 'closing';
    }

    progress() {
        return this.sh.progress();
    }

    frame() {
        const a = clamp(this.alpha.x, 0, 1);
        const closing = this.mode === 'closing';
        // reduced motion: one cross-fade (the glass's alpha carries the content too)
        return {box: this.sh.box(), glass: clamp(this.glass.x, 0, 1), alpha: this.reduced ? 1 : a,
            blur: closing && this.reduced ? CLOSE_BLUR_PT * (1 - clamp(this.glass.x, 0, 1)) : 0};
    }
}

// One result row's arrival or leave (by its index in the list).
export class RowMotion {
    constructor() {
        this.o = new Fade(0, role('fade'), EPS_OPACITY);
        this.y = new Spring(ROW_FROM_Y, role('pour'), EPS_PX);
        this.at = 0;            // motion s when it starts to arrive (0: nothing pending)
    }

    get shown() {
        return this.o.to === 1;
    }

    // mode: 'full' | 'reduced' | 'off'
    arrive(now, i, mode) {
        if (this.shown)
            return;
        if (mode === 'off') {
            this.o.snap(1);
            this.y.snap(0);
            this.at = 0;
        } else if (mode === 'reduced') {
            this.y.snap(0);
            this.o.set(1, REDUCED);
            this.at = 0;
        } else if (!this.at) {
            this.at = now + ROW_DELAY + i * ROW_STEP;
        }
    }

    leave(mode) {
        this.at = 0;
        if (mode === 'off') {
            this.o.snap(0);
            this.y.snap(ROW_FROM_Y);
            return;
        }
        this.o.set(0, mode === 'reduced' ? REDUCED : CONTENT_OUT);
        this.y.snap(this.y.x === 0 && this.o.x > 0 ? 0 : ROW_FROM_Y);
    }

    step(dt, now) {
        if (this.at && now >= this.at) {
            this.at = 0;
            this.o.set(1, role('fade'));
            this.y.set(0, role('pour'));
        }
        this.o.step(dt);
        this.y.step(dt);
        if (this.o.rest && this.o.x === 0)
            this.y.snap(ROW_FROM_Y);
    }

    get moving() {
        return Boolean(this.at) || !this.o.rest || !this.y.rest;
    }
}

// The results panel's height (px).
export class PanelMotion {
    constructor() {
        this.h = new Spring(0, role('pour'), EPS_PX);
    }

    to(h, reduced) {
        if (reduced) {
            this.h.snap(h);
            return;
        }
        this.h.set(h, h >= this.h.x ? role('pour') : role('pour', {exit: true}));
    }

    snap(h) {
        this.h.snap(h);
    }

    step(dt) {
        return this.h.step(dt);
    }

    get rest() {
        return this.h.rest;
    }

    get value() {
        return this.h.x;
    }

    get target() {
        return this.h.to;
    }
}

// The filter split. frame(): {barRight, lobes[4], rho, k, iconAlpha, progress (0 joined .. 1 split)}
export class SplitMotion {
    constructor(w0 = GEO.W0, rho = GEO.RHO) {
        this.w0 = w0;
        this.rhoFinal = rho;
        this.home = w0 - rho;                   // where the buttons are while they are part of the bar (its right end)
        this.bar = new Spring(w0, role('pour'), EPS_PX);
        this.lobes = GEO.C_FINAL.map(() => new Spring(this.home, role('pour'), EPS_PX));
        this.rho = new Spring(0, role('bead'), 0.05);
        this.icons = new Fade(0, role('fade'), EPS_OPACITY);
        this.on = false;
        this._waits = [];
    }

    get split() {
        return this.on;
    }

    get moving() {
        return !this.bar.rest || !this.rho.rest || !this.icons.rest || this.lobes.some(s => !s.rest) || this._waits.some(w => w);
    }

    set(on, reduced) {
        this.on = on;
        const finals = GEO.C_FINAL.map(c => c * this.w0 / GEO.W0);
        if (reduced) {
            this.bar.snap(on ? GEO.BAR_SPLIT * this.w0 / GEO.W0 : this.w0);
            this.lobes.forEach((s, i) => s.snap(on ? finals[i] : this.home));
            this.rho.snap(on ? this.rhoFinal : 0);
            this.icons.set(on ? 1 : 0, REDUCED);
            this._waits = [];
            return;
        }
        const p = on ? role('pour') : role('pour', {exit: true});
        this.bar.set(on ? GEO.BAR_SPLIT * this.w0 / GEO.W0 : this.w0, role('pour'));
        // out: the rightmost button leaves first and the rest spill after it; back: all at once (the bar gathers them)
        this._waits = this.lobes.map((_, i) => on ? (this.lobes.length - 1 - i) * SPILL_S : 0);
        this._go = i => this.lobes[i].set(on ? finals[i] : this.home, p);
        this._waits.forEach((w, i) => {
            if (w <= 0)
                this._go(i);
        });
        this.rho.set(on ? this.rhoFinal : 0, on ? role('bead') : role('bead', {exit: true}));
        if (!on)
            this.icons.set(0, role('fade', {exit: true}));
    }

    settle(on) {
        this.on = on;
        this.set(on, true);
        this.icons.snap(on ? 1 : 0);
    }

    progress() {
        const span = this.w0 - GEO.BAR_SPLIT * this.w0 / GEO.W0;
        return clamp((this.w0 - this.bar.x) / span, 0, 1.2);
    }

    step(dt) {
        this._waits = this._waits.map((w, i) => {
            if (w <= 0)
                return 0;
            const left = w - dt;
            if (left <= 0)
                this._go?.(i);
            return Math.max(0, left);
        });
        this.bar.step(dt);
        this.lobes.forEach(s => s.step(dt));
        this.rho.step(dt);
        if (this.on && this.progress() >= ICONS_FROM && this.rho.x > GEO.D / 2 - 6)
            this.icons.set(1, role('fade'));
        this.icons.step(dt);
        return this.frame();
    }

    frame() {
        const prog = this.progress();
        return {barRight: this.bar.x, lobes: this.lobes.map(s => s.x), rho: Math.max(0, this.rho.x),
            k: lerp(K_JOINED, K_APART, smoothstep(0.15, 1, prog)), iconAlpha: clamp(this.icons.x, 0, 1),
            end: Math.max(...this.lobes.map(s => s.x)) + Math.max(0, this.rho.x), progress: prog};
    }
}

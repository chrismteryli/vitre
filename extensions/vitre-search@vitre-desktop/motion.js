/* VitreSearch motion: the measured tables from plan A14 (sections 2a-2c, 6a-6b) and the third-party
 * teardown (eager-hollow-dyyf.here.now, 57 fps reference recording), turned into pure functions of time.
 * No GI imports here: node can load this file for the unit tests (rig/work/a11/tests).
 *
 * All times are the reference's own milliseconds. They are NOT scaled by St's slow-down factor
 * (Just Perfection sets 0.8); the controller reads a Clutter.Timeline, which is unscaled.
 *
 * Provenance of every table (anything not in a table is marked ESTIMATE):
 *   OPEN      teardown "Enter (materialize)" table, 11 rows (width % of final, opacity). The first two
 *             width values are extrapolated in the source.
 *   CLOSE     teardown "Exit (dematerialize)" presence table, 8 rows. Growth and blur: the source gives
 *             "+3-4 % per side by mid-fade" and "blur 0 -> ~8 pt"; the shape of both ramps is ESTIMATE.
 *   EXPAND    A14 2c expand table, bottom edge as % of travel (11 rows, 30 fps source).
 *   COLLAPSE  A14 2c collapse table (7 rows).
 *   SPLIT     A14 2a table (24 rows at 30 fps). The bar's right edge before pinch-off (B at 133-200 ms),
 *             the lobe radii, the smooth-union softness k and the button glyph fade are ESTIMATES: the
 *             recording shows only the outline of the connected shape there.
 */

// ---------------------------------------------------------------------------------------------
// Monotone cubic (PCHIP, Fritsch-Carlson) interpolation: passes through every measured point and
// never rings between them, so the tables are reproduced exactly at the sample times.
export function pchip(xs, ys) {
    const n = xs.length;
    const h = [];
    const d = [];
    for (let i = 0; i < n - 1; i++) {
        h[i] = xs[i + 1] - xs[i];
        d[i] = (ys[i + 1] - ys[i]) / h[i];
    }
    const m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] <= 0) {
            m[i] = 0;
        } else {
            const w1 = 2 * h[i] + h[i - 1];
            const w2 = h[i] + 2 * h[i - 1];
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
        }
    }
    return t => {
        if (t <= xs[0])
            return ys[0];
        if (t >= xs[n - 1])
            return ys[n - 1];
        let i = 0;
        while (i < n - 2 && t > xs[i + 1])
            i++;
        const s = (t - xs[i]) / h[i];
        const s2 = s * s;
        const s3 = s2 * s;
        return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h[i] * m[i] +
            (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * h[i] * m[i + 1];
    };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, s) => a + (b - a) * s;
const smoothstep = (a, b, v) => {
    const s = clamp((v - a) / (b - a), 0, 1);
    return s * s * (3 - 2 * s);
};

// Invert a monotone-increasing single-valued curve on [t0, t1] by bisection (used to resume an
// interrupted animation from the current value without a jump).
export function invert(fn, value, t0, t1) {
    if (value <= fn(t0))
        return t0;
    if (value >= fn(t1))
        return t1;
    let lo = t0;
    let hi = t1;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (fn(mid) < value)
            lo = mid;
        else
            hi = mid;
    }
    return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------------------------
// Geometry (logical px). H and W0 follow the measured proportions: the wide bar is 961 px for an
// 85 px bar in the a reference recording recording (11.3 : 1), so 64 x 720 here (11.25 : 1). With these the
// measured 60 % settled bar and the 4 buttons reproduce the original right end exactly (see SPLIT).
export const GEO = {
    H: 64,              // bar height
    W0: 720,            // wide (unsplit) bar width
    D: 67,              // button diameter (measured 72/68 units = 1.06 x bar height; plan said = height)
    RHO: 33.5,          // button radius
    C_FINAL: [474, 544.5, 615.5, 686.5],  // final button centres from the bar's left edge
    PANEL_R: 34,        // corner radius of the results panel
    TOP_FRACTION: 0.19, // bar top as a fraction of the monitor height (ESTIMATE: the reference design places it a
                        // little above the upper third)
};

// ---------------------------------------------------------------------------------------------
// OPEN: materialize (teardown). t ms -> width % of final, opacity.
const OPEN_T = [0, 35, 53, 70, 88, 105, 123, 158, 210, 264, 300];
const OPEN_W = [110, 105, 104.7, 102.5, 101.2, 100.0, 99.0, 98.7, 99.2, 99.6, 100.0];
const OPEN_A = [0.05, 0.36, 0.55, 0.71, 0.85, 0.95, 0.99, 0.99, 1.0, 1.0, 1.0];
export const OPEN_MS = 300;
const openW = pchip(OPEN_T, OPEN_W);
const openA = pchip(OPEN_T, OPEN_A);
export const OPEN_TABLE = {t: OPEN_T, w: OPEN_W, a: OPEN_A};

export function openFrame(t) {
    return {alpha: clamp(openA(t), 0, 1), sx: openW(t) / 100, sy: 1, blur: 0};
}

// ---------------------------------------------------------------------------------------------
// CLOSE: dematerialize (teardown presence table). Growth per side (fraction of the size) reaches
// 3.5 % at mid-fade and 4.8 % at the end (ESTIMATE of the ramp); blur radius in points reaches 8 at
// the end with the ramp proportional to the fade (ESTIMATE of the ramp, endpoint from the teardown).
const CLOSE_T = [0, 18, 35, 53, 70, 88, 105, 123];
const CLOSE_A = [1.0, 0.92, 0.80, 0.63, 0.38, 0.24, 0.13, 0.04];
export const CLOSE_MS = 125;
const closeA = pchip([...CLOSE_T, CLOSE_MS], [...CLOSE_A, 0]);
const closeGrow = pchip([0, 61.5, CLOSE_MS], [0, 0.035, 0.048]);
export const CLOSE_BLUR_PT = 8;
export const CLOSE_TABLE = {t: CLOSE_T, a: CLOSE_A};

export function closeFrame(t) {
    const a = clamp(closeA(t), 0, 1);
    const g = closeGrow(t);
    return {alpha: a, sx: 1 + 2 * g, sy: 1 + 2 * g, blur: CLOSE_BLUR_PT * (1 - a)};
}

// Resume points: time on the other curve that has the same opacity, so a reversed open/close
// continues from what is on screen.
export const closeTimeForAlpha = a => invert(t => -closeA(t), -a, 0, CLOSE_MS);
export const openTimeForAlpha = a => invert(openA, a, 0, OPEN_MS);

// ---------------------------------------------------------------------------------------------
// PANEL: bar <-> results panel, bottom edge as a fraction of the travel (bar = 0, final = 1).
const EXP_T = [0, 34, 67, 100, 134, 167, 200, 234, 267, 300, 334];
const EXP_P = [0, 38, 74, 92, 99.7, 102.5, 102.5, 101.8, 100.6, 100.3, 100].map(v => v / 100);
export const EXPAND_MS = 334;
const expandP = pchip(EXP_T, EXP_P);
export const EXPAND_TABLE = {t: EXP_T, p: EXP_P};

const COL_T = [0, 16, 50, 83, 116, 150, 183];
const COL_P = [0, 5, 24, 50, 70, 84, 100].map(v => v / 100);   // fraction of the collapse travel done
export const COLLAPSE_MS = 183;
const collapseP = pchip(COL_T, COL_P);
export const COLLAPSE_TABLE = {t: COL_T, p: COL_P};

// Fraction of the way from the start height to the target height at time t. Growing uses the expand
// curve (with its +2.5 % overshoot), shrinking uses the collapse curve.
export function panelProgress(kind, t) {
    return kind === 'collapse' ? collapseP(t) : expandP(t);
}

export const panelDuration = kind => kind === 'collapse' ? COLLAPSE_MS : EXPAND_MS;

// ---------------------------------------------------------------------------------------------
// SPLIT: the pill pinches off four round buttons (A14 2a). Raw values are the crop units of the
// recording: the bar's left edge is x = 143 and the wide bar's right edge is x = 912 (769 units = 100 %).
export const SPLIT_MS = 800;
const FRAME = 1000 / 30;
const U0 = 143;
const UW = 769;
const frac = x => (x - U0) / UW;

// 24 rows: 22 frames at 30 fps (0 .. 700 ms), then +767 and +800 ms
const SPLIT_T = [...Array(22).keys()].map(i => i * FRAME).concat([766.67, 800]);

// The bar's own right edge (raw units). Rows 0-3 and 7-23 are the measured "bar right edge" column
// (row 9 is a duplicate recording frame: interpolated). Rows 4-6 are ESTIMATES: the recording only gives
// the outline of bar + bud there (E below).
const BAR_RAW = [912, 907, 852, 813, 716, 670, 631, 600, 581, 582, 583, 589, 596, 601, 605, 608,
    609, 609, 609, 608, 606, 606, 606, 606];
// The right end of everything attached to the bar (raw units): the bar before the bud forms, then
// bar + bud, then the rightmost button. Rows 4-6 = the measured component extents at 133/167/200 ms
// (row 4 is 732 measured; 729.4 here because the smooth union adds 2.4 px at the bud's tip: the RENDERED
// outline then equals the measured 732).
const END_RAW = [912, 907, 852, 813, 729.4, 748, 793, 832, 863, 880, 897, 910, 919, 924, 925, 925,
    924, 922, 920, 918, 916, 915, 913, 912];

// Middle buttons from 367 ms on (px from the bar's left edge, W0 = 720): from the piece structure and
// the measured button extents. Before that the four lobes are evenly spaced (they are one blob).
const MID_FROM = 11;
const C2_PX = [554, 552, 551, 548.1, 546.5, 545, 544, 544.2, 544.4, 544.5, 544.5, 544.5, 544.5];
const C3_PX = [620, 630, 633, 629.2, 626, 623.6, 621.7, 620, 618.5, 617, 616.3, 615.7, 615.5];

// Left edge of the first button / blob (raw units): it settles at 612-617 through the whole table; the
// 5 unit swing around pinch-off is kept (the blob's left end recoils when the neck lets go).
const A0_RAW = [612.5, 612.5, 612.5, 612.5, 612.5, 612.5, 612.5, 612, 617, 617, 616, 615, 614, 614, 613,
    613, 614, 614, 614, 614, 613, 613, 613, 613];

const px = (raw, w0) => frac(raw) * w0;
const RHO_T = [0, 100, 133, 167, 200, 233, 267, 800];
const RHO_V = [0, 0, 20, 24, 27, 30, 33.5, 33.5];                  // ESTIMATE (grows into the final button size)
const K_T = [0, 133, 200, 233, 267, 333, 400, 800];
const K_V = [28, 28, 20, 13, 8, 5, 4, 3];                          // ESTIMATE (smooth-union softness, px)

export function buildSplit(w0 = GEO.W0, rhoFinal = GEO.RHO) {
    const rhoScale = rhoFinal / GEO.RHO;
    const barEdge = pchip(SPLIT_T, BAR_RAW.map(r => px(r, w0)));
    const endEdge = pchip(SPLIT_T, END_RAW.map(r => px(r, w0)));
    const rho = pchip(RHO_T, RHO_V.map(v => v * rhoScale));
    const kk = pchip(K_T, K_V);
    const tailT = SPLIT_T.slice(MID_FROM);
    const c2 = pchip(tailT, C2_PX.map(v => v * w0 / GEO.W0));
    const c3 = pchip(tailT, C3_PX.map(v => v * w0 / GEO.W0));
    const a0 = pchip(SPLIT_T, A0_RAW.map(r => px(r, w0)));
    return t => {
        const tt = clamp(t, 0, SPLIT_MS);
        const r = rho(tt);
        const barRight = barEdge(tt);
        const end = endEdge(tt);
        const c1 = a0(tt) + r;                         // the first lobe's left edge is nearly fixed
        const c4 = Math.max(c1, end - r);
        // while the blob is one piece (up to 333 ms) the lobes are evenly spaced; from 367 ms the measured
        // piece structure applies; in between the two are blended (this is where the first button leaves)
        const w = smoothstep(SPLIT_T[10], SPLIT_T[MID_FROM], tt);
        const m2 = lerp(c1 + (c4 - c1) / 3, c2(tt), w);
        const m3 = lerp(c1 + 2 * (c4 - c1) / 3, c3(tt), w);
        const lobes = [c1, m2, m3, c4];
        // glyphs appear once the buttons are separate (ESTIMATE: 300 -> 467 ms)
        const iconAlpha = smoothstep(300, 467, tt);
        return {barRight, lobes, rho: r, k: kk(tt), iconAlpha, end,
            // 0 before the bud exists, 1 once the buttons are whole
            progress: tt / SPLIT_MS};
    };
}

export const SPLIT_TABLE = {t: SPLIT_T, barRaw: BAR_RAW, endRaw: END_RAW, frac, U0, UW};

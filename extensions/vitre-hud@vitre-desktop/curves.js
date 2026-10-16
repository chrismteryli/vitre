/* Motion curves of the menu-bar HUD, from the frame-measured the reference design.x beta recording
 * (plans/A14-measurements.md section 1a, 60 fps, "presence" = interior opacity proxy).
 * Pure functions, no gi imports: run under node and gjs (tests/test-curves.mjs).
 *
 * Every number in the *_KNOTS tables is a smoothed copy of the measured table (the raw table
 * has frame-to-frame bumps of up to +-3 %); tools/fit_curves.py and tests/test-curves.mjs check
 * that each curve stays within 0.02 of every measured point. Times are milliseconds from the
 * first frame in which the HUD content is visible (enter) or from the last steady frame (exit).
 */

// Monotone cubic Hermite interpolation (Fritsch-Carlson), clamped flat outside the knots.
export function monotoneCurve(knots) {
    const n = knots.length;
    const xs = knots.map(k => k[0]);
    const ys = knots.map(k => k[1]);
    const d = [];
    for (let i = 0; i < n - 1; i++)
        d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    const m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++)
        m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) {
            m[i] = 0;
            m[i + 1] = 0;
            continue;
        }
        const a = m[i] / d[i];
        const b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) {
            const tau = 3 / Math.sqrt(s);
            m[i] = tau * a * d[i];
            m[i + 1] = tau * b * d[i];
        }
    }
    return t => {
        if (t <= xs[0])
            return ys[0];
        if (t >= xs[n - 1])
            return ys[n - 1];
        let i = 0;
        while (t > xs[i + 1])
            i++;
        const h = xs[i + 1] - xs[i];
        const u = (t - xs[i]) / h;
        const u2 = u * u;
        const u3 = u2 * u;
        return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] +
            (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m[i + 1];
    };
}

/* Enter, opacity of the whole capsule (fraction of final), t = 0 at the first visible frame.
 * Measured: 10 % at +50 ms, 50 % at +165 ms, 90 % at +335 ms, 98 % at +500 ms. */
export const ENTER_KNOTS = [
    [0, 0.003], [17, 0.008], [33, 0.035], [50, 0.078], [67, 0.123], [83, 0.175], [100, 0.235],
    [117, 0.305], [133, 0.375], [150, 0.455], [167, 0.50], [183, 0.55], [200, 0.60], [217, 0.65],
    [233, 0.69], [250, 0.73], [267, 0.77], [283, 0.805], [300, 0.835], [317, 0.865], [333, 0.89],
    [367, 0.93], [417, 0.96], [500, 0.982], [600, 0.994], [700, 1.0],
];
export const ENTER_MS = 700;

/* Exit, t = 0 at the last steady frame. Measured: 50 % at +83 ms, 8 % at +183 ms, noise floor
 * after that. The tail is closed to 0 at +195 ms. */
export const EXIT_KNOTS = [
    [0, 1.0], [17, 0.95], [33, 0.88], [50, 0.745], [67, 0.625], [83, 0.505], [100, 0.415],
    [117, 0.325], [133, 0.25], [150, 0.185], [167, 0.125], [183, 0.065], [195, 0.0],
];
export const EXIT_MS = 195;

/* Capsule scale about the top-centre (the top edge never moves). Enter: height reaches ~99 %
 * by 120-150 ms, width keeps closing to 100 % at ~500 ms. Exit: the same amount in reverse
 * (height -8 %, width -5 %, done by 133 ms). The first 100 ms of width are below the
 * measurement floor; the plan's 0.92 / ~0.95 are used as the starting scale. */
export const SY_ENTER_KNOTS = [[0, 0.92], [60, 0.92], [100, 0.945], [125, 0.975], [160, 0.99], [250, 0.995], [400, 1.0]];
export const SX_ENTER_KNOTS = [[0, 0.945], [100, 0.948], [150, 0.961], [200, 0.973], [250, 0.986], [300, 0.992], [400, 0.996], [500, 1.0]];
export const SY_EXIT_KNOTS = [[0, 1.0], [17, 1.0], [33, 0.996], [50, 0.987], [67, 0.978], [83, 0.968], [100, 0.955], [120, 0.93], [133, 0.92], [195, 0.92]];
export const SX_EXIT_KNOTS = [[0, 1.0], [17, 0.999], [33, 0.993], [50, 0.983], [67, 0.973], [83, 0.963], [100, 0.955], [117, 0.951], [133, 0.95], [195, 0.95]];

/* The glass (blur, tint, rim) starts about 35 ms after the content: gate 0 until +25 ms,
 * fully on at +45 ms. It only multiplies the glass layer; the whole capsule still follows the
 * enter curve above, so the summed opacity stays on the measured table. */
export const GLASS_GATE_START = 25;
export const GLASS_GATE_END = 45;

export const DWELL_MS = 900;      // measured 0.92 s and 0.88 s after the last value change
export const LEVEL_MS = 100;      // fill follows a new value in 100 ms (GNOME's own OSD step)

const presenceIn = monotoneCurve(ENTER_KNOTS);
const presenceOut = monotoneCurve(EXIT_KNOTS);
const syIn = monotoneCurve(SY_ENTER_KNOTS);
const sxIn = monotoneCurve(SX_ENTER_KNOTS);
const syOut = monotoneCurve(SY_EXIT_KNOTS);
const sxOut = monotoneCurve(SX_EXIT_KNOTS);

export const clamp01 = v => Math.min(1, Math.max(0, v));

export function enterPresence(t) {
    return t <= 0 ? ENTER_KNOTS[0][1] : clamp01(presenceIn(t));
}

export function exitPresence(t) {
    return clamp01(presenceOut(Math.max(0, t)));
}

export function enterScale(t) {
    return {sx: sxIn(Math.max(0, t)), sy: syIn(Math.max(0, t))};
}

export function exitScale(t) {
    return {sx: sxOut(Math.max(0, t)), sy: syOut(Math.max(0, t))};
}

export function glassGate(t) {
    return clamp01((t - GLASS_GATE_START) / (GLASS_GATE_END - GLASS_GATE_START));
}

// Time on the enter curve at which the presence equals p (bisection; the curve is monotone).
export function enterTimeForPresence(p) {
    if (p <= ENTER_KNOTS[0][1])
        return 0;
    if (p >= 1)
        return ENTER_MS;
    let lo = 0;
    let hi = ENTER_MS;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (enterPresence(mid) < p)
            lo = mid;
        else
            hi = mid;
    }
    return (lo + hi) / 2;
}

// Time on the exit curve at which the presence equals p (the exit curve is monotone falling).
export function exitTimeForPresence(p) {
    if (p >= 1)
        return 0;
    if (p <= 0)
        return EXIT_MS;
    let lo = 0;
    let hi = EXIT_MS;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (exitPresence(mid) > p)
            lo = mid;
        else
            hi = mid;
    }
    return (lo + hi) / 2;
}

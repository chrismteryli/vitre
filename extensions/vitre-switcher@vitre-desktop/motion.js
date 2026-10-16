/* Super-Tab timings, absolute milliseconds (plans/A-motion-measurements.md A7-2, A7-4; A16 for the delay).
 * Clutter.Timeline durations are not scaled by St's slow_down_factor (Just Perfection animation=5 gives 0.8),
 * which is exactly why the dismissal runs on a Timeline and not on actor.ease().
 *
 *   show delay   : the panel is revealed (opacity 0 -> 255, one frame) this long after the switcher key press.
 *                  the reference design: 167 ms (a reference clip, reference-era clip) to 200 ms (reference, A16). The rig stamps the first
 *                  full frame 3-12 ms after the reveal (next 120 Hz frame + paint), so 178 puts the visible
 *                  frame at ~181-190 ms, the middle of the the reference design range.
 *   fade out     : opacity 0.62, 0.54, 0.38, 0.20, 0.12, 0.03, 0 at 33.3 ms steps counted from the first painted
 *                  frame of the dismissal (mean of 4 releases, 30 fps clip), joined by a monotone cubic so the
 *                  curve passes exactly through every measured point without the lumps of a polyline.
 *   blur         : the icons smear while the panel fades (seen at 27.117-27.217 s of the clip; radius is an
 *                  estimate, not a measurement).
 */
export const SHOW_DELAY_MS = 178;

export const FADE_FRAME_MS = 1000 / 30;
export const FADE_POINTS = Object.freeze([0.62, 0.54, 0.38, 0.20, 0.12, 0.03, 0.0]);
export const FADE_MS = FADE_FRAME_MS * (FADE_POINTS.length - 1);

export const BLUR_MAX_RADIUS = 10;      // estimate
export const BLUR_RISE_MS = 120;        // estimate: reaches the maximum 120 ms in, then holds

const XS = FADE_POINTS.map((_, i) => i * FADE_FRAME_MS);

// Fritsch-Carlson monotone cubic slopes
function slopes(xs, ys) {
    const n = xs.length;
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
            const t = 3 / Math.sqrt(s);
            m[i] = t * a * d[i];
            m[i + 1] = t * b * d[i];
        }
    }
    return m;
}
const SLOPES = slopes(XS, FADE_POINTS);

// opacity (0..1) t ms after the first painted frame of the dismissal
export function opacityAt(t) {
    if (t <= 0)
        return FADE_POINTS[0];
    if (t >= FADE_MS)
        return 0;
    let i = Math.min(FADE_POINTS.length - 2, Math.floor(t / FADE_FRAME_MS));
    const h = XS[i + 1] - XS[i];
    const u = (t - XS[i]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    const v = (2 * u3 - 3 * u2 + 1) * FADE_POINTS[i] + (u3 - 2 * u2 + u) * h * SLOPES[i] +
        (-2 * u3 + 3 * u2) * FADE_POINTS[i + 1] + (u3 - u2) * h * SLOPES[i + 1];
    return Math.min(1, Math.max(0, v));
}

// blur radius in px (integer, Shell.BlurEffect.radius is an int)
export function blurAt(t) {
    const u = Math.min(1, Math.max(0, t / BLUR_RISE_MS));
    return Math.round(BLUR_MAX_RADIUS * Math.sin(u * Math.PI / 2));
}

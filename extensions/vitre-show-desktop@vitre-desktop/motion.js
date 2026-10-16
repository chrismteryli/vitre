// Show Desktop motion model (A8). Pure functions, no Shell imports, so the same
// file is unit-tested in plain Node and used by scene.js inside the Shell.
//
// Source: plans/A-motion-measurements.md section A8 (the reference design reference 26.x / 27, 60 fps):
//   * every window slides in a straight line to its NEAREST screen edge, all at once
//   * about 12 px of each window stays on the edge (below the menu bar at the top)
//   * opaque, unscaled, sharp the whole way; the return mirrors the hide, no snap
//   * hide about 410 ms, return about 500 ms, cubic-bezier(0.20, 0, 0.20, 1)
// These are the reference-style absolute times: they are NOT multiplied by Just Perfection's
// slow-down factor, and a reversal resumes on the target curve at the matching progress.

export const PEEK_PX = 12;
export const HIDE_MS = 410;
export const RETURN_MS = 500;
export const CURVE = Object.freeze([0.20, 0, 0.20, 1]);

const [X1, Y1, X2, Y2] = CURVE;

// One coordinate of a cubic Bezier with end points 0 and 1 and control values a, b.
function coord(t, a, b) {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
}

// Solve coord(t, a, b) = value for t in [0, 1]. Both coordinates used here are
// monotone, so Newton steps guarded by a bisection bracket always converge.
function solve(value, a, b) {
    let lo = 0;
    let hi = 1;
    let t = value;
    for (let i = 0; i < 48; i++) {
        const error = coord(t, a, b) - value;
        if (Math.abs(error) < 1e-9)
            return t;
        if (error > 0)
            hi = t;
        else
            lo = t;
        const u = 1 - t;
        const slope = 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b);
        t = slope > 1e-6 ? t - error / slope : (lo + hi) / 2;
        if (!(t > lo && t < hi))
            t = (lo + hi) / 2;
    }
    return t;
}

const clamp01 = value => Math.min(1, Math.max(0, value));

// Eased progress for a linear fraction of the animation time (0..1 -> 0..1).
export function ease(fraction) {
    const x = clamp01(fraction);
    if (x === 0 || x === 1)
        return x;
    return coord(solve(x, X1, X2), Y1, Y2);
}

// The time fraction at which ease() has reached the given progress.
export function easeInverse(progress) {
    const y = clamp01(progress);
    if (y === 0 || y === 1)
        return y;
    return coord(solve(y, Y1, Y2), X1, X2);
}

// Where one animation segment starts and how long it takes. `position` is how far
// the windows already are from home (0 = home, 1 = parked at the edges); `target`
// is 1 for the hide and 0 for the return. A fresh run starts at 0 and takes the full
// time; a reversal resumes the target's own curve at the same progress.
export function segment(position, target) {
    const total = target ? HIDE_MS : RETURN_MS;
    const start = easeInverse(target ? position : 1 - position);
    return {total, start, duration: Math.max(1, Math.round((1 - start) * total))};
}

// Window position (0..1) `elapsed` ms into a segment.
export function positionAt(seg, target, elapsed) {
    const eased = ease(seg.start + elapsed / seg.total);
    return target ? eased : 1 - eased;
}

// The screen edge nearest to the window's centre. `bounds` is the rectangle of
// the monitor(s) the window sits on. Ties prefer top, bottom, left, right.
export function nearestEdge(frame, bounds) {
    const cx = frame.x + frame.width / 2;
    const cy = frame.y + frame.height / 2;
    const distance = {
        top: cy - bounds.y,
        bottom: bounds.y + bounds.height - cy,
        left: cx - bounds.x,
        right: bounds.x + bounds.width - cx,
    };
    let best = 'top';
    for (const edge of ['bottom', 'left', 'right']) {
        if (distance[edge] < distance[best])
            best = edge;
    }
    return best;
}

// How far the window travels (dx, dy) so that PEEK_PX of it stays on `edge`.
// `topInset` is the height of the menu bar on the top edge: the strip stays below it.
export function edgeOffset(frame, bounds, edge, topInset = 0, peek = PEEK_PX) {
    switch (edge) {
    case 'left':
        return {dx: bounds.x + peek - (frame.x + frame.width), dy: 0};
    case 'right':
        return {dx: bounds.x + bounds.width - peek - frame.x, dy: 0};
    case 'top':
        return {dx: 0, dy: bounds.y + topInset + peek - (frame.y + frame.height)};
    case 'bottom':
        return {dx: 0, dy: bounds.y + bounds.height - peek - frame.y};
    default:
        throw new Error('Unknown screen edge');
    }
}

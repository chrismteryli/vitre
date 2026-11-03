// Show Desktop motion model (A8, liquid v3). Pure functions, no Shell imports, so the same file is unit-tested in plain
// Node and used by scene.js inside the Shell.
//
// Source: plans/A-motion-measurements.md section A8:
//   * every window slides in a straight line to its NEAREST screen edge, all at once
//   * about 12 px of each window stays on the edge (below the menu bar at the top)
//   * opaque, unscaled, sharp the whole way; the return mirrors the hide, no snap
// The motion is the liquid.js 'glide' spring (scene.js): the hide is an exit (response x 0.8, damping >= 0.94: it never
// bounces off the edge), the return the glide spring itself; a reversal turns around from where the windows are, with
// their speed. Reduced motion: no travel, the windows cross-fade (out at home, in at the edges, and back).

export const PEEK_PX = 12;

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

/* Geometry of the menu-bar HUD in GNOME logical px, derived from the the reference design.x beta
 * recording (plans/A14-measurements.md section 1a, video px, 1080 px wide crop, 60 fps).
 *
 * The recording cannot be converted to points (the crop has no scale reference), so the
 * conversion is relative: the top-bar item highlight in the video is 48 px high, and our top-bar
 * highlight pill (Control Center's, 44 x 18.5 pt x 1.15 = 21 logical px) plays that role.
 *      f = PILL_H / 48 logical px per video px
 * Everything else is a ratio to that highlight. Pure module (node + gjs).
 */

// Measured in the video (px).
export const VIDEO = {
    pillH: 48,          // speaker highlight y 28-76
    pillW: 66,          // x 492-558
    capsuleH: 217,      // top rim y 138-140, bottom edge 357
    aspect: 4.7,        // plan: ~4.7 : 1 (right edge 1041 px; left edge 10-26 px, inferred)
    gapBelowPill: 64,   // highlight bottom (76) to capsule top (140)
};

export const PILL_H = 21;                 // our top-bar highlight pill height (Control Center's, A9)
export const RIGHT_MARGIN = 13;           // 11.5 pt x 1.15 (A9), the capsule keeps it at the screen edge

/* panel: {height}; monitor: {x, y, width, height}; itemCenterX: stage x of the owning top-bar
 * item's centre (NaN or missing = use the right-margin position). */
export function deriveGeometry({panelH, monitor, itemCenterX, pillH = PILL_H}) {
    const f = pillH / VIDEO.pillH;
    const h = Math.round(VIDEO.capsuleH * f);
    const w = Math.round(VIDEO.aspect * h);
    const gap = Math.round(VIDEO.gapBelowPill * f);
    const pillW = Math.round(VIDEO.pillW * f);
    const pillY = Math.round((panelH - pillH) / 2);
    const y = monitor.y + pillY + pillH + gap;
    const minX = monitor.x + RIGHT_MARGIN;
    const maxX = monitor.x + monitor.width - RIGHT_MARGIN - w;
    const centred = Number.isFinite(itemCenterX) ? Math.round(itemCenterX - w / 2) : maxX;
    const x = Math.min(maxX, Math.max(minX, centred));
    return {
        f, w, h, x, y, radius: h / 2, pillW, pillH, pillY: monitor.y + pillY,
        pillX: Number.isFinite(itemCenterX) ? Math.round(itemCenterX - pillW / 2) : null,
        // contents (design choices, not measured): proportions of the capsule height
        glyph: Math.round(h * 0.36), inset: Math.round(h * 0.32), gapGlyph: Math.round(h * 0.17),
        track: Math.round(h * 0.105),
    };
}

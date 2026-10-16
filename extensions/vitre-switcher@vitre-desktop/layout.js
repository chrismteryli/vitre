/* Super-Tab panel geometry from the measured ratios (plans/A-motion-measurements.md A7-1, reference 26.x, 8 apps):
 *   icon 1.0, pitch 1.30 (icon + gap 0.30), panel padding 0.35 (first icon edge to panel edge),
 *   panel height 1.70 (top 0.38 above the icons, 0.32 below), panel radius 0.32, selected plate 1.18.
 *   Panel width = N x pitch + 2 x padding - gap = (1.30 N + 0.40) icons, centred on the screen.
 * The icon size itself is not a ratio of the icon: it is 106 / 1551 of the reference screen width in the clip
 * (0.0683), so the 8-app panel is 0.74 of the screen width as measured.
 * Pure functions, all lengths in stage pixels (what the layout sees); the caller divides by the theme scale
 * factor for CSS lengths. Rounding keeps every edge on a whole pixel and the icon exactly S.
 */
export const RATIO = Object.freeze({
    icon: 1.0,
    pitch: 1.30,
    padding: 0.35,
    top: 0.38,
    panelHeight: 1.70,
    radius: 0.32,
    plate: 1.18,
    // not measured (design choices, flagged in the report): selected-app name band and font, plate corner radius
    labelHeight: 0.14,
    fontSize: 0.115,
    plateRadius: 0.27,
});

export const ICON_PER_SCREEN_WIDTH = 106 / 1551;
export const MAX_PANEL_FRACTION = 0.94;
export const MIN_ICON = 48;

export function iconSizeFor(count, monitorWidth) {
    const n = Math.max(1, count);
    const ideal = Math.round(monitorWidth * ICON_PER_SCREEN_WIDTH);
    const widthRatio = RATIO.pitch * n + 2 * RATIO.padding - (RATIO.pitch - RATIO.icon);
    const fit = Math.floor(monitorWidth * MAX_PANEL_FRACTION / widthRatio);
    return Math.max(MIN_ICON, Math.min(ideal, fit));
}

export function computeMetrics({count, monitorWidth, iconSize = null}) {
    const n = Math.max(1, count);
    let S = iconSize ?? iconSizeFor(n, monitorWidth);
    let m = metricsFor(n, S);
    // whole-pixel rounding can overshoot the formula by a few pixels: step down until it fits
    while (iconSize === null && m.panelW > monitorWidth * MAX_PANEL_FRACTION && S > MIN_ICON)
        m = metricsFor(n, --S);
    return m;
}

function metricsFor(n, S) {
    const p = Math.round((RATIO.plate - RATIO.icon) / 2 * S);        // plate overhang around the icon
    const plate = S + 2 * p;
    const pitch = Math.round(RATIO.pitch * S);
    const gap = pitch - plate;
    const padX = Math.round(RATIO.padding * S) - p;                   // panel edge to plate edge
    const padTop = Math.round(RATIO.top * S) - p;
    const panelH = Math.round(RATIO.panelHeight * S);
    const labelH = Math.round(RATIO.labelHeight * S);
    const room = panelH - padTop - plate - labelH;                    // left for the bottom padding(s)
    return {
        count: n, S, p, plate, pitch, gap, padX, padTop, panelH, labelH,
        radius: Math.round(RATIO.radius * S),
        plateRadius: Math.round(RATIO.plateRadius * S),
        fontPx: Math.round(RATIO.fontSize * S),
        // app switcher: label sits inside the item under the plate, one bottom padding
        padBottomApp: room,
        // window switcher: one shared label under the list: gap and bottom padding are equal
        padBottomWin: Math.round(room / 2),
        panelW: 2 * padX + n * plate + (n - 1) * gap,
    };
}

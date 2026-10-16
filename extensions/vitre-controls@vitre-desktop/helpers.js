/* Pure, dependency-free helpers for the Control Center extension (no gi imports,
 * so they run under node and gjs in the unit tests). */

// the reference points -> GNOME logical px (physical-size match A16 141.5 px/in vs MBP16 123.4 pt/in).
export const K = 1.15;
export const pt = v => Math.round(v * K);

// Control Center geometry, from plan A9 section 1.1 (the reference points in comments).
export const GEO = {
    unit: pt(60),           // 60 pt  -> 69
    gap: pt(13),            // 13 pt  -> 15
    columns: 4,
    rightMargin: pt(11.5),  // 11.5 pt -> 13
    topGap: pt(12),         // 12 pt  -> 14
    tileRadius: pt(26),     // 2x2 tile 26 pt -> 30
    sliderRadius: pt(23),   // 4x1 tile 23 pt -> 26
    disc: pt(34.5),         // 34.5 pt -> 40
    discInset: pt(12.5),    // 12.5 pt -> 14
    textGap: pt(10),        // 10 pt -> 12
    sliderTitleLeft: pt(12.5),
    sliderTitleTop: pt(10),
    track: pt(3.5),         // 3.5 pt -> 4
    roundButton: pt(28),    // 28 pt -> 32
    glyph: pt(17),          // 17 pt -> 20 (19.55)
    pillW: 0, pillH: 0, width: 0, rowPitch: 0,
};
GEO.pillW = 2 * GEO.unit + GEO.gap;             // 153
GEO.pillH = GEO.unit;                           // 69
GEO.width = 4 * GEO.unit + 3 * GEO.gap;         // 321
GEO.rowPitch = GEO.unit + GEO.gap;              // 84
GEO.circleRadius = GEO.unit / 2;                // 34.5

// Roles of the GNOME / extension items, from their class name or title.
export function roleOfItem({className, title, hasMenu}) {
    switch (className) {
    case 'NMWirelessToggle': return 'wifi';
    case 'NMWiredToggle': return 'wired';
    case 'BluetoothToggle': return 'bluetooth';
    case 'PowerProfilesToggle': return 'power';
    case 'NightLightToggle': return 'night';
    case 'DarkModeToggle': return 'dark';
    case 'DoNotDisturbToggle': return 'focus';
    case 'KeyboardBrightnessToggle': return 'kbd';
    case 'RfkillToggle': return 'airplane';
    case 'RotationToggle': return 'rotate';
    case 'BrightnessItem': return 'display';
    case 'OutputStreamSlider': return 'sound';
    case 'InputStreamSlider': return 'mic';
    case 'SystemItem': return 'system';
    case 'StageManagerToggle': return 'stage';
    case 'ScreenshotItem': return 'screenshot';
    default: break;
    }
    if (title === 'Vitre Stage' || title === 'Vitre Stage')
        return 'stage';
    if (title === 'App Windows')
        return 'appwin';
    if (title === 'Show Desktop')
        return 'desktop';
    return hasMenu ? 'extra-menu' : 'extra';
}

// kind: how the module is drawn and how many cells it takes.
export const KIND_CELLS = {
    circle: {cs: 1, rs: 1},
    pill: {cs: 2, rs: 1},
    tile: {cs: 2, rs: 2},
    slider: {cs: 4, rs: 1},
    wide: {cs: 4, rs: 1},
};

const PILL_ROLES = new Set(['wifi', 'wired', 'bluetooth', 'power', 'focus']);
const SLIDER_ROLES = new Set(['display', 'sound', 'mic']);

export function kindOfRole(role, isSlider) {
    if (role === 'nowplaying')
        return 'tile';
    if (PILL_ROLES.has(role))
        return 'pill';
    if (SLIDER_ROLES.has(role) || isSlider)
        return 'slider';
    if (role === 'extra-wide')
        return 'wide';
    return 'circle';
}

// Order of the flow after the hero block (plan 3.1 mapping).
const FLOW_ORDER = ['power', 'stage', 'appwin', 'dark', 'desktop', 'focus'];
const SLIDER_ORDER = ['display', 'sound', 'mic'];
const EXTRA_ORDER = ['night', 'kbd', 'airplane', 'screenshot', 'rotate'];

/**
 * Place visible modules on the 4-column grid.
 * entries: [{id, role, kind}] in GNOME's own child order (only visible ones).
 * Returns {cells: [{id, col, row, cs, rs}], rows}.
 */
export function planGrid(entries) {
    const byRole = new Map();
    const rest = [];
    for (const e of entries) {
        if (e.role === 'system') // hidden by the extension, never planned
            continue;
        if (!byRole.has(e.role))
            byRole.set(e.role, e);
        else
            rest.push(e);
    }
    const take = role => {
        const e = byRole.get(role);
        byRole.delete(role);
        return e ?? null;
    };

    const cells = [];
    let row = 0;
    // hero block: Wi-Fi/Bluetooth stacked on the left, Now Playing 2x2 on the right
    const wifi = take('wifi') ?? take('wired');
    const bt = take('bluetooth');
    const np = take('nowplaying');
    const left = [wifi, bt].filter(Boolean);
    if (np || left.length > 0) {
        left.forEach((e, i) => cells.push({id: e.id, kind: e.kind, col: 0, row: row + i, cs: 2, rs: 1}));
        if (np)
            cells.push({id: np.id, kind: np.kind, col: 2, row, cs: 2, rs: 2});
        row += np ? 2 : left.length;
    }

    // flow: fill rows of 4 columns
    let col = 0;
    const place = e => {
        if (!e)
            return;
        const {cs, rs} = KIND_CELLS[e.kind];
        if (col + cs > GEO.columns) {
            col = 0;
            row += 1;
        }
        cells.push({id: e.id, kind: e.kind, col, row, cs, rs});
        col += cs;
        if (col >= GEO.columns) {
            col = 0;
            row += 1;
        }
    };
    const flushRow = () => {
        if (col > 0) {
            col = 0;
            row += 1;
        }
    };
    for (const role of FLOW_ORDER)
        place(take(role));
    flushRow();
    // sliders: always full rows
    for (const role of SLIDER_ORDER) {
        flushRow();
        place(take(role));
    }
    flushRow();
    for (const role of EXTRA_ORDER)
        place(take(role));
    // anything else (unknown toggles, other extensions): circles first, wide rows last
    const others = [...byRole.values(), ...rest];
    for (const e of others.filter(x => x.kind === 'circle' || x.kind === 'pill'))
        place(e);
    flushRow();
    for (const e of others.filter(x => x.kind === 'slider' || x.kind === 'wide' || x.kind === 'tile'))
        place(e);
    flushRow();
    const rows = cells.reduce((m, c) => Math.max(m, c.row + c.rs), 0);
    return {cells, rows};
}

// Pixel rectangle of a cell, relative to the grid origin.
export function cellRect(cell, rowYs, rowHs) {
    const x = cell.col * (GEO.unit + GEO.gap);
    const w = cell.cs * GEO.unit + (cell.cs - 1) * GEO.gap;
    const y = rowYs[cell.row];
    const last = cell.row + cell.rs - 1;
    const h = rowYs[last] + rowHs[last] - y;
    return {x, y, w, h};
}

// Row heights: every row is one unit (69 px) high unless a wide item needs more.
export function rowMetrics(plan, naturalHeights, overlayHeight = 0, openRows = new Set()) {
    const rowHs = new Array(plan.rows).fill(GEO.unit);
    for (const c of plan.cells) {
        const nat = naturalHeights.get(c.id) ?? 0;
        if (c.kind === 'wide' && nat > rowHs[c.row])
            rowHs[c.row] = nat;
    }
    const rowYs = [];
    let y = 0;
    for (let r = 0; r < plan.rows; r++) {
        rowYs.push(y);
        y += rowHs[r] + GEO.gap;
        if (openRows.has(r))
            y += overlayHeight;
    }
    const height = plan.rows > 0 ? y - GEO.gap : 0;
    return {rowYs, rowHs, height};
}

// Where the menu goes: right edge 13 px from the monitor edge, 14 px below the bar.
export function menuOrigin(area, width) {
    return {x: area.x + area.width - width - GEO.rightMargin, y: area.y + GEO.topGap};
}

export class UndoJournal {
    constructor() {
        this._undo = [];
    }

    add(undo) {
        this._undo.push(undo);
    }

    property(object, name, value) {
        const old = object[name];
        this.add(() => { object[name] = old; });
        object[name] = value;
    }

    method(object, name, factory) {
        const own = Object.getOwnPropertyDescriptor(object, name);
        const original = object[name];
        if (typeof original !== 'function')
            throw new Error('Required native method unavailable');
        const replacement = factory(original);
        this.add(() => {
            // Do not overwrite another extension's later replacement.
            if (object[name] !== replacement)
                return;
            if (own)
                Object.defineProperty(object, name, own);
            else
                delete object[name];
        });
        object[name] = replacement;
        return original;
    }

    move(actor, parent, index = -1) {
        const oldParent = actor.get_parent();
        const oldIndex = oldParent?.get_children().indexOf(actor) ?? -1;
        this.add(() => {
            actor.get_parent()?.remove_child(actor);
            if (oldParent)
                oldParent.insert_child_at_index(actor, oldIndex);
        });
        oldParent?.remove_child(actor);
        if (parent)
            parent.insert_child_at_index(actor, index);
    }

    rollback() {
        let errors = 0;
        for (const undo of this._undo.splice(0).reverse()) {
            try {
                undo();
            } catch {
                errors++;
            }
        }
        return errors;
    }
}

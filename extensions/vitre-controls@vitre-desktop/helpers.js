/* Pure, dependency-free helpers for the Control Center extension (no gi imports,
 * so they run under node and gjs in the unit tests). */

// the reference points -> GNOME logical px (physical-size match A16 141.5 px/in vs MBP16 123.4 pt/in).
export const K = 1.15;
export const pt = v => Math.round(v * K);

// Control Center geometry, from plan A9 section 1.1 (the reference points in comments).
export const GEO = {
    // Vitre tokens (packages/polish-tokens-20261101/TOKENS.md): the reference points snapped to the 4 px grid and the radius scale
    unit: 68,               // 60 pt x 1.15 = 69 -> 68
    gap: 16,                // 13 pt -> 15 -> 16
    columns: 4,
    rightMargin: 12,        // 11.5 pt -> 13 -> 12
    topGap: 12,             // 12 pt -> 14 -> 12
    tileRadius: 32,         // 2x2 tile: r-3xl
    sliderRadius: 24,       // 4x1 tile: r-2xl
    disc: 44,               // 34.5 pt -> 40 -> 44: concentric in the 68 px pill with a 12 px inset ((68 - 44) / 2)
    discInset: 12,          // 12.5 pt -> 14 -> 12
    textGap: pt(10),        // 10 pt -> 12
    sliderTitleLeft: 16,
    sliderTitleTop: 12,
    track: pt(3.5),         // 3.5 pt -> 4
    roundButton: pt(28),    // 28 pt -> 32
    glyph: pt(17),          // 17 pt -> 20 (19.55)
    pillW: 0, pillH: 0, width: 0, rowPitch: 0,
};
GEO.pillW = 2 * GEO.unit + GEO.gap;             // 152
GEO.pillH = GEO.unit;                           // 68
GEO.width = 4 * GEO.unit + 3 * GEO.gap;         // 320
GEO.rowPitch = GEO.unit + GEO.gap;              // 84
GEO.circleRadius = GEO.unit / 2;                // 34: the pill

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

// Order of the small modules (pills and circles) after the hero block (plan 3.1 mapping), then the extras.
const FLOW_ORDER = ['power', 'stage', 'appwin', 'dark', 'desktop', 'focus'];
const SLIDER_ORDER = ['display', 'sound', 'mic'];
const EXTRA_ORDER = ['night', 'kbd', 'airplane', 'screenshot', 'rotate'];

/* Pack small modules (pills 2x1, circles 1x1) into full rows of GEO.columns, keeping their order as far as no hole is left:
 * a pill that does not fit in what is left of a row lets the next circle take the gap first. The last row never has a gap:
 * its circles stretch to 2x1 capsules (the icon stays centred), a lone pill spans the row, and a lone circle takes a circle
 * from the row above so both rows end full. Returns [{e, cs}] rows. */
export function packRows(items) {
    const queue = [...items];
    const rows = [];
    let row = [];
    let free = GEO.columns;
    const span = e => KIND_CELLS[e.kind].cs;
    while (queue.length) {
        let i = queue.findIndex(e => span(e) <= free);
        if (i < 0) {
            rows.push(row);
            row = [];
            free = GEO.columns;
            continue;
        }
        const [e] = queue.splice(i, 1);
        row.push({e, cs: span(e)});
        free -= span(e);
        if (free === 0) {
            rows.push(row);
            row = [];
            free = GEO.columns;
        }
    }
    if (row.length)
        rows.push(row);
    // a short row other than the last can only happen when nothing fitted its gap (pills only): stretch it like the last
    const used = r => r.reduce((m, c) => m + c.cs, 0);
    const last = rows.at(-1);
    if (last && used(last) === 1 && rows.length > 1) {
        const above = rows.at(-2);
        const k = above.map(c => c.e.kind).lastIndexOf('circle');
        if (k >= 0) {
            const [c] = above.splice(k, 1);
            last.unshift(c);
        }
    }
    for (const r of rows) {
        let gap = GEO.columns - used(r);
        // circles grow from the end of the row backwards, one cell each
        for (let k = r.length - 1; k >= 0 && gap > 0; k--) {
            if (r[k].e.kind === 'circle' && r[k].cs === 1) {
                r[k].cs = 2;
                gap--;
            }
        }
        // what is still left goes to the last module of the row (a lone pill spans the row; a lone capsule too)
        if (gap > 0 && r.length)
            r[r.length - 1].cs += gap;
    }
    return rows;
}

/**
 * Place visible modules on the 4-column grid, with no hole anywhere.
 * entries: [{id, role, kind}] in GNOME's own child order (only visible ones).
 * Returns {cells: [{id, col, row, cs, rs}], rows}.
 *
 * Layout (top to bottom): the hero block (Now Playing 2x2 on the right; on its left two pills: Wi-Fi and Bluetooth, or
 * whatever pills / pairs of circles come first when they are missing), the small modules packed in full rows, the sliders
 * (one per row), then anything wide.
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

    const np = take('nowplaying');
    const lead = [take('wifi') ?? take('wired'), take('bluetooth')].filter(Boolean);
    const small = [];
    for (const role of [...FLOW_ORDER, ...EXTRA_ORDER]) {
        const e = take(role);
        if (e)
            small.push(e);
    }
    const sliders = [];
    for (const role of SLIDER_ORDER) {
        const e = take(role);
        if (e)
            sliders.push(e);
    }
    const others = [...byRole.values(), ...rest];
    for (const e of others.filter(x => x.kind === 'circle' || x.kind === 'pill'))
        small.push(e);
    const wide = others.filter(x => x.kind === 'slider' || x.kind === 'wide' || x.kind === 'tile');

    const cells = [];
    let row = 0;
    if (np) {
        // the 2x2 on the left of Now Playing: two pill rows; a missing pill is replaced by the next pill, else by two circles
        const leftRows = lead.map(e => [{e, cs: 2}]);
        const pool = [...small];
        while (leftRows.length < 2) {
            const p = pool.findIndex(x => x.kind === 'pill');
            const circles = pool.filter(x => x.kind === 'circle');
            if (p >= 0)
                leftRows.push([{e: pool.splice(p, 1)[0], cs: 2}]);
            else if (circles.length >= 2)
                leftRows.push(circles.slice(0, 2).map(e => ({e: pool.splice(pool.indexOf(e), 1)[0], cs: 1})));
            else
                break;
        }
        if (leftRows.length < 2) {
            // not enough to fill the left half: Now Playing takes the full width and everything else flows below it
            small.unshift(...lead);
            cells.push({id: np.id, kind: np.kind, col: 0, row, cs: GEO.columns, rs: 2});
        } else {
            small.length = 0;
            small.push(...pool);
            leftRows.forEach((r, i) => {
                let col = 0;
                for (const c of r) {
                    cells.push({id: c.e.id, kind: c.e.kind, col, row: row + i, cs: c.cs, rs: 1});
                    col += c.cs;
                }
            });
            cells.push({id: np.id, kind: np.kind, col: 2, row, cs: 2, rs: 2});
        }
        row += 2;
    } else {
        small.unshift(...lead);
    }

    for (const r of packRows(small)) {
        let col = 0;
        for (const c of r) {
            cells.push({id: c.e.id, kind: c.e.kind, col, row, cs: c.cs, rs: 1});
            col += c.cs;
        }
        row += 1;
    }
    for (const e of [...sliders, ...wide]) {
        cells.push({id: e.id, kind: e.kind, col: 0, row, cs: GEO.columns, rs: e.kind === 'tile' ? 2 : 1});
        row += e.kind === 'tile' ? 2 : 1;
    }
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

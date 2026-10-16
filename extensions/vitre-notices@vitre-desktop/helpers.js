/* Pure, dependency-free helpers. No notification data enters these helpers.
 * (No gi imports: the unit tests run them under node and gjs.) */

// the reference points -> GNOME logical px (physical-size match A16 141.5 px/in vs MBP16 123.4 pt/in).
export const K = 1.15;
export const pt = v => Math.round(v * K);

// Notification Center geometry, plan A9 section 1.2 (the reference points in comments).
export const NCGEO = {
    width: pt(331),          // 331 pt -> 381
    rightMargin: pt(11.5),   // 11.5 pt -> 13
    topGap: pt(20),          // 20 pt -> 23
    gap: pt(16.5),           // 16.5 pt -> 19
    smallW: pt(157),         // 157 pt -> 181
    smallH: pt(156),         // 156 pt -> 179
    mediumH: pt(158),        // 158 pt -> 182
    widgetRadius: pt(22),    // 22 pt -> 25
    cardRadius: pt(20),      // 20 pt -> 23
    appIcon: pt(32),         // 32 pt -> 37
    bottomMargin: pt(11.5),
    // the scroll view clips at its box: 3 px of room so the cards' rim is not cut at the edges
    clipPad: 3,
};

// Open curve, fitted to Fable's frame-stepped table (tools/fit_nc_curve.py, max error 0.005):
// visible fraction p(s) = 1 - (1 + B s) exp(-W s), s in ms since the start of motion.
export const CURVE = {W: 0.0205, B: 0.011, T0: 0.5, DURATION: 340};

export function curveRaw(s) {
    if (s <= 0)
        return 0;
    return 1 - (1 + CURVE.B * s) * Math.exp(-CURVE.W * s);
}

// The raw curve is 0.9957 at 340 ms; a cubic blend closes the last 0.4 % so the motion ends
// exactly at rest (max deviation from the table stays under 0.005).
export function curve(s) {
    const t = Math.min(Math.max(s, 0), CURVE.DURATION);
    if (s >= CURVE.DURATION)
        return 1;
    const gap = 1 - curveRaw(CURVE.DURATION);
    return Math.min(1, curveRaw(t) + gap * Math.pow(t / CURVE.DURATION, 3));
}

// Inverse of the curve: the time at which the motion has covered fraction x.
export function curveInverse(x) {
    if (x <= 0)
        return 0;
    if (x >= 1)
        return CURVE.DURATION;
    let lo = 0;
    let hi = CURVE.DURATION;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (curve(mid) < x)
            lo = mid;
        else
            hi = mid;
    }
    return (lo + hi) / 2;
}

// Where the column goes: right edge 13 px from the monitor edge, 23 px under the bar.
export function columnOrigin(area, width) {
    return {x: area.x + area.width - width - NCGEO.rightMargin, y: area.y + NCGEO.topGap};
}

export function columnMaxHeight(area) {
    return Math.max(1, area.height - NCGEO.topGap - NCGEO.bottomMargin);
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

export function configuredWidgetVisible(kind, nativeVisible, configured) {
    return Boolean(nativeVisible && (kind === 'clocks'
        ? Number(configured) > 0 : configured));
}

export function notificationSectionVisible(empty, nativeVisible) {
    return Boolean(!empty && nativeVisible);
}

// Pairs of small widgets: [[a, b], [c]] from a flat list.
export function pairUp(items) {
    const rows = [];
    for (let i = 0; i < items.length; i += 2)
        rows.push(items.slice(i, i + 2));
    return rows;
}

// Hand angles (radians, clockwise from 12) for an analog clock.
export function clockAngles(hours, minutes, seconds) {
    const sec = seconds / 60;
    const min = (minutes + sec) / 60;
    const hour = ((hours % 12) + min) / 12;
    return {hour: hour * 2 * Math.PI, minute: min * 2 * Math.PI, second: sec * 2 * Math.PI};
}

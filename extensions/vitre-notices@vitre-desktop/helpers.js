/* Pure, dependency-free helpers. No notification data enters these helpers.
 * (No gi imports: the unit tests run them under node and gjs.) */

// the reference points -> GNOME logical px (physical-size match A16 141.5 px/in vs MBP16 123.4 pt/in).
export const K = 1.15;
export const pt = v => Math.round(v * K);

// Notification Center geometry, plan A9 section 1.2 (the reference points in comments).
export const NCGEO = {
    width: pt(331),          // 331 pt -> 381
    rightMargin: 12,         // 11.5 pt -> 13 -> 12 (4 px grid, as Control Center)
    topGap: 24,              // 20 pt -> 23 -> 24
    gap: 20,                 // 16.5 pt -> 19 -> 20
    smallW: pt(157),         // 157 pt -> 181
    smallH: pt(156),         // 156 pt -> 179
    mediumH: pt(158),        // 158 pt -> 182
    widgetRadius: 24,        // 22 pt -> 25 -> r-2xl
    cardRadius: 24,          // 20 pt -> 23 -> r-2xl
    appIcon: pt(32),         // 32 pt -> 37
    bottomMargin: 12,
    // the scroll view clips at its box: 2 px of room so the cards' rim is not cut at the edges (= .nc-scroll padding)
    clipPad: 2,
};

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

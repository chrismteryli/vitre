/* The Control Center grid layout: 4 columns of 69 px with 15 px gaps (the reference's 60 pt /
 * 13 pt x 1.15), explicit cells (including a 2x2 tile, which GNOME's own
 * QuickSettingsLayout cannot do), the submenu-overlay row shift of the original, and
 * the glass layers allocated in the same pass as their modules.
 *
 * GNOME's QuickSettingsMenu keeps calling `layout_manager.child_set_property(grid,
 * item, 'column-span', n)` and reads `_overlay` from the layout, so both are kept. */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {GEO, planGrid, cellRect, rowMetrics} from './helpers.js';
import {MARGIN} from './glass.js';

export const CCLayoutMeta = GObject.registerClass({
    Properties: {
        'column-span': GObject.ParamSpec.int(
            'column-span', null, null,
            GObject.ParamFlags.READWRITE,
            1, GLib.MAXINT32, 1),
    },
}, class CCLayoutMeta extends Clutter.LayoutMeta {});

export const CCLayout = GObject.registerClass(
class CCLayout extends Clutter.LayoutManager {
    // hooks: {entries(container) -> [{id, actor, role, kind}], layerOf(actor) -> GlassLayer|null,
    //         isManaged(actor) -> bool}
    _init(overlay, hooks) {
        super._init();
        this._overlay = overlay;
        this._hooks = hooks;
        this.lastPlan = null;
    }

    vfunc_get_child_meta_type() {
        return CCLayoutMeta.$gtype;
    }

    _compute(container, width) {
        const entries = this._hooks.entries(container);
        const plan = planGrid(entries);
        const actors = new Map(entries.map(e => [e.id, e.actor]));
        const natural = new Map();
        for (const cell of plan.cells) {
            if (cell.kind === 'wide') {
                const actor = actors.get(cell.id);
                natural.set(cell.id, actor.get_preferred_height(width)[1]);
            }
        }
        const [, overlayHeight] = this._overlay.get_preferred_height(width);
        const openRows = new Set();
        for (const cell of plan.cells) {
            const actor = actors.get(cell.id);
            if (actor.menu?.actor?.visible) {
                for (let r = cell.row; r < cell.row + cell.rs; r++)
                    openRows.add(r);
                // the overlay opens under the row that holds the item's last cell row
                openRows.delete(cell.row);
                openRows.add(cell.row + cell.rs - 1);
            }
        }
        const metrics = rowMetrics(plan, natural, overlayHeight, openRows);
        return {entries, plan, actors, metrics, overlayHeight};
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [GEO.width, GEO.width];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const {metrics, overlayHeight} = this._compute(container, GEO.width);
        const total = metrics.height;
        void forWidth;
        void overlayHeight;
        return [total, total];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        const {plan, actors, metrics, overlayHeight} = this._compute(container, width);
        this.lastPlan = {plan, metrics};
        this._overlay.allocate_available_size(0, 0, width, overlayHeight);

        const isRtl = container.text_direction === Clutter.TextDirection.RTL;
        const [cx, cy] = container.get_transformed_position();
        const childBox = new Clutter.ActorBox();
        const layerBox = new Clutter.ActorBox();
        for (const cell of plan.cells) {
            const actor = actors.get(cell.id);
            const r = cellRect(cell, metrics.rowYs, metrics.rowHs);
            let x = box.x1 + r.x;
            if (isRtl)
                x = box.x2 - r.w - r.x;
            const y = box.y1 + r.y;
            childBox.set_origin(x, y);
            childBox.set_size(r.w, r.h);
            actor.allocate(childBox);
            const layer = this._hooks.layerOf(actor);
            if (layer) {
                layerBox.set_origin(x - MARGIN, y - MARGIN);
                layerBox.set_size(r.w + 2 * MARGIN, r.h + 2 * MARGIN);
                layer.actor.allocate(layerBox);
                layer.sync(r.w, r.h, cx + x - MARGIN, cy + y - MARGIN);
            }
        }
    }
});

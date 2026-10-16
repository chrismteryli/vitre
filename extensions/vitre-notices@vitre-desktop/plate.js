/* A "plate": one card with its own clear glass behind it. Children by role (set as
 * actor._plateRole): 'glass' (a GlassLayer actor, allocated MARGIN larger than the card),
 * 'content' (fills the plate and sets its size), 'rim' (fills the plate, painted above the
 * content, non-reactive: the specular rim), 'overlay' (natural size, aligned by its own
 * x_align / y_align: hover buttons). */
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {MARGIN} from './glass.js';

const ALIGN = {
    [Clutter.ActorAlign.START]: 0,
    [Clutter.ActorAlign.CENTER]: 0.5,
    [Clutter.ActorAlign.END]: 1,
    [Clutter.ActorAlign.FILL]: 0,
};

export const PlateLayout = GObject.registerClass(
class PlateLayout extends Clutter.LayoutManager {
    // glass: GlassLayer; compensate(): extra stage translation to ignore (a sliding ancestor)
    _init(glass, compensate = () => 0) {
        super._init();
        this._glass = glass;
        this._compensate = compensate;
        this._last = null;
    }

    _content(container) {
        return container.get_children().find(c => c._plateRole === 'content' && c.visible);
    }

    vfunc_get_preferred_width(container, forHeight) {
        return this._content(container)?.get_preferred_width(forHeight) ?? [0, 0];
    }

    vfunc_get_preferred_height(container, forWidth) {
        return this._content(container)?.get_preferred_height(forWidth) ?? [0, 0];
    }

    vfunc_allocate(container, box) {
        const w = box.get_width();
        const h = box.get_height();
        const inner = new Clutter.ActorBox();
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            switch (child._plateRole) {
            case 'glass':
                inner.set_origin(box.x1 - MARGIN, box.y1 - MARGIN);
                inner.set_size(w + 2 * MARGIN, h + 2 * MARGIN);
                child.allocate(inner);
                break;
            case 'overlay':
                child.allocate_align_fill(box, ALIGN[child.x_align] ?? 0.5, ALIGN[child.y_align] ?? 0.5, false, false);
                break;
            default:
                child.allocate(box);
            }
        }
        this._last = {w, h, x1: box.x1, y1: box.y1};
        this.resync(container);
    }

    // Offsets of the backdrop copy: stage position of the layer's corner, ignoring `compensate`.
    resync(container) {
        if (!this._last || !this._glass)
            return;
        const [cx, cy] = container.get_transformed_position();
        const {w, h, x1, y1} = this._last;
        this._glass.sync(w, h, cx + x1 - MARGIN - this._compensate(), cy + y1 - MARGIN);
    }
});

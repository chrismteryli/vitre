/* Control Center side of the liquid drip (plan A17): the adapter the shared controller (liquidDrip.js) drives.
 * Pieces are the visible Quick Settings modules, each with its own glass layer (glass.js); during the drip
 * the layers and the modules are hidden and the field draws all the glass, then every module hands over to
 * its own glass and content as its piece settles. Nothing here changes the modules' own look or behaviour at
 * rest: begin() remembers every opacity and end() puts exactly that back. */
import {highlightRect, op255, Lifetimes, DRIP} from './liquidDrip.js';
import {GLASS_FINISH} from './glass.js';
import {GEO} from './helpers.js';

export class CCDripAdapter {
    constructor(ext) {
        this._ext = ext;
        this.finish = GLASS_FINISH;
        this.handoffMs = DRIP.handoffMs;     // the field fades out over this long after the geometry is done (no rim step at the end)
        this.allocCount = 0;      // bumped by the pointer's _reposition (once per allocation pass)
        this._allocAt = -1;
        this._saved = null;
        this._byId = new Map();
        this._life = new Lifetimes();    // a Quick Settings module can be destroyed while a drip runs (a device goes away)
    }

    // ---- geometry --------------------------------------------------------------------------------------

    // the source pill is the Quick Settings button: when it is not on screen (panel hidden) there is nothing to drip from, and the
    // surface is handed over at once instead of waiting out the geometry timeout invisible
    canDrip() {
        return Boolean(this._ext._native?.qs?.mapped);
    }

    geometry(rest = false) {
        const ext = this._ext;
        const native = ext._native;
        if (!native || !ext._mods)
            return null;
        if (!rest && this.allocCount <= this._allocAt)
            return null;
        const plan = ext._layout?.lastPlan?.plan;
        if (!plan?.cells?.length)
            return null;
        const byId = new Map();
        for (const [item, mod] of ext._mods)
            byId.set(mod.id, [item, mod]);
        const pieces = [];
        for (const cell of plan.cells) {
            const entry = byId.get(cell.id);
            if (!entry)
                continue;
            const [item, mod] = entry;
            this._life.watch(item);
            if (!this._life.alive(item) || !item.visible || !item.has_allocation())
                continue;
            const [x, y] = item.get_transformed_position();
            const [w, h] = item.get_transformed_size();
            if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1)
                return null;
            const radius = Math.min(mod.layer?.radius ?? GEO.circleRadius, w / 2, h / 2);
            pieces.push({id: mod.id, x, y, w, h, r: radius, row: cell.row});
        }
        if (!pieces.length)
            return null;
        const button = native.qs;
        if (!button.mapped)
            return null;
        const pill = highlightRect(button);
        if (![pill.x, pill.y, pill.w, pill.h].every(Number.isFinite))
            return null;
        return {pill: {...pill, keep: true}, pieces};
    }

    maskActor() {
        return this._ext._native?.grid ?? null;
    }

    // ---- take over / hand back -------------------------------------------------------------------------

    begin() {
        const ext = this._ext;
        this._allocAt = this.allocCount;
        this._byId = new Map();
        const saved = [];
        for (const [item, mod] of ext._mods) {
            this._life.watch(item);
            this._life.watch(mod.layer?.actor);
            if (!this._life.alive(item))
                continue;
            this._byId.set(mod.id, [item, mod]);
            const layerAlive = Boolean(mod.layer) && this._life.alive(mod.layer.actor);
            saved.push({item, layer: layerAlive ? mod.layer : null, itemOp: item.opacity, layerOp: layerAlive ? mod.layer.actor.opacity : 255});
            item.opacity = 0;
            if (layerAlive)
                mod.layer.actor.opacity = 0;
        }
        this._saved = saved;
        ext._native?.grid.queue_redraw();
    }

    setPiece(id, {real, content, clip}) {
        let entry = this._byId.get(id);
        if (!entry) {
            // a module adopted after begin() (Quick Settings builds some items late): look it up now
            for (const [item, mod] of this._ext._mods ?? []) {
                if (mod.id === id) {
                    this._life.watch(item);
                    this._life.watch(mod.layer?.actor);
                    entry = [item, mod];
                    this._byId.set(id, entry);
                    break;
                }
            }
            if (!entry)
                return;
        }
        const [item, mod] = entry;
        if (!this._life.alive(item))
            return;
        if (mod.layer && this._life.alive(mod.layer.actor))
            mod.layer.actor.opacity = op255(real);
        item.opacity = op255(content);
    }

    end() {
        const saved = this._saved;
        this._saved = null;
        for (const s of saved ?? []) {
            // a module destroyed while the drip ran has nothing to give back
            if (this._life.alive(s.item))
                s.item.opacity = s.itemOp;
            if (s.layer && this._life.alive(s.layer.actor))
                s.layer.actor.opacity = s.layerOp;
        }
        this._byId = new Map();
        this._life.clear();
    }

    destroy() {
        this._life.clear();
        this._saved = null;
        this._byId = new Map();
    }
}

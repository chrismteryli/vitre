/* Control Center side of the liquid drip (plan A17): the adapter the shared controller (liquidDrip.js) drives.
 * Pieces are the visible Quick Settings modules, each with its own glass layer (glass.js); during the drip
 * the layers and the modules are hidden and the field draws all the glass, then every module hands over to
 * its own glass as its piece settles. Nothing here changes the modules' own look or behaviour at rest: begin()
 * remembers every opacity and end() puts exactly that back.
 *
 * The modules' content (Motion Lab 2): in full motion it does not follow the pour's content alpha; each module is a
 * tile (tiles.js) that arrives on its own bead and fade springs, the nearer ones to the button first, and leaves on a
 * short fade and the pour exit spring while the glass drains. The phase the controller reports each frame starts them;
 * they keep moving after the pour has handed back. */
import St from 'gi://St';

import {highlightRect, op255, Lifetimes, DRIP} from './liquidDrip.js';
import {GLASS_FINISH} from './glass.js';
import {GEO} from './helpers.js';
import {motionMode, nowS} from './liquidClock.js';
import {TILE, tileOf, resetTiles} from './tiles.js';

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
        this._tiles = false;             // this drip's content moves as tiles (full motion)
        this._phase = 'closed';          // the controller's phase as of the last frame
        this._pending = null;            // {t0, items}: tiles whose distance is not known yet
    }

    // ---- tiles -----------------------------------------------------------------------------------------

    _tileItems() {
        const out = [];
        for (const [item] of this._ext._mods ?? []) {
            this._life.watch(item);
            if (this._life.alive(item) && item.visible)
                out.push(item);
        }
        return out;
    }

    // open: each tile waits by its distance from the button (logical px), then arrives. On a first open the modules have no
    // allocation yet: their wait is settled in the first frame that has one (the pour starts only once they do, well inside
    // the 0.12 s every tile waits anyway)
    _arriveTiles() {
        const t0 = nowS();
        this._pending = {t0, items: new Set()};
        for (const item of this._tileItems()) {
            const t = tileOf(item);
            t.arrive(t0 + TILE.delay, !t.moving && !t.ownsOpacity);
            this._pending.items.add(item);
        }
        this._placeTiles();
    }

    _placeTiles() {
        const p = this._pending;
        if (!p)
            return;
        const native = this._ext._native;
        let pill = null, top = 0;
        try {
            pill = native?.qs?.mapped ? highlightRect(native.qs) : null;
            top = native?.grid?.get_transformed_position()[1] ?? 0;
        } catch (_e) {
            pill = null;
        }
        if (!pill || !Number.isFinite(top))
            return;
        const scale = Math.max(1, St.ThemeContext.get_for_stage(global.stage).scale_factor);
        for (const item of [...p.items]) {
            if (!this._life.alive(item)) {
                p.items.delete(item);
                continue;
            }
            if (!item.has_allocation())
                continue;
            const [x, y] = item.get_transformed_position();
            const [w] = item.get_transformed_size();
            if (![x, y, w].every(Number.isFinite))
                continue;
            const d = Math.hypot(x + w / 2 - (pill.x + pill.w / 2), y - top) / scale;
            const t = item._vitreTileMotion;
            if (t?.at)
                t.at = p.t0 + TILE.delay + Math.min(TILE.maxSpread, d * TILE.perPx);
            p.items.delete(item);
        }
        if (!p.items.size)
            this._pending = null;
    }

    _leaveTiles() {
        for (const item of this._tileItems())
            tileOf(item).leave();
    }

    frame(_fr, _tau, phase) {
        if (this._pending)
            this._placeTiles();
        if (phase === this._phase)
            return;
        const was = this._phase;
        this._phase = phase;
        if (!this._tiles)
            return;
        if (phase === 'closing') {
            this._pending = null;
            this._leaveTiles();
        }
        else if (phase === 'opening' && was === 'closing')
            this._arriveTiles();         // reversed: the tiles come back from where they are, with their speed
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
        const phase = ext._drip?.controller?.phase ?? 'opening';
        this._allocAt = this.allocCount;
        this._byId = new Map();
        // full motion: the content moves as tiles; an open starts them now, a close from rest when the first frame says so
        this._tiles = motionMode() === 'full';
        this._phase = phase;
        const saved = [];
        for (const [item, mod] of ext._mods) {
            this._life.watch(item);
            this._life.watch(mod.layer?.actor);
            if (!this._life.alive(item))
                continue;
            this._byId.set(mod.id, [item, mod]);
            const layerAlive = Boolean(mod.layer) && this._life.alive(mod.layer.actor);
            const tile = item._vitreTileMotion;
            const itemOp = tile?.ownsOpacity ? tile.restOpacity : item.opacity;
            saved.push({item, layer: layerAlive ? mod.layer : null, itemOp, layerOp: layerAlive ? mod.layer.actor.opacity : 255});
            if (this._tiles) {
                tileOf(item).restOpacity = itemOp;
                if (phase !== 'opening')
                    tileOf(item).ownsOpacity = true;      // a close from rest: the tile is on screen and leaves from there
            } else {
                item.opacity = 0;
            }
            if (layerAlive)
                mod.layer.actor.opacity = 0;
        }
        this._saved = saved;
        if (this._tiles && phase === 'opening')
            this._arriveTiles();
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
        if (!this._tiles)
            item.opacity = op255(content);
    }

    end() {
        const saved = this._saved;
        this._saved = null;
        const phase = this._ext._drip?.controller?.phase ?? 'closed';
        for (const s of saved ?? []) {
            const tile = s.item._vitreTileMotion;
            if (tile && this._life.alive(s.item)) {
                // open: a tile still arriving keeps its springs (it ends on the remembered opacity); a close that finished, a
                // reset or an aborted open: at rest now
                if (phase !== 'open' || !this._tiles)
                    tile.settle();
                if (tile.ownsOpacity) {
                    if (s.layer && this._life.alive(s.layer.actor))
                        s.layer.actor.opacity = s.layerOp;
                    continue;
                }
            }
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
        resetTiles();
        this._life.clear();
        this._saved = null;
        this._byId = new Map();
    }
}

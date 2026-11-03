/* Control Center tiles (Motion Lab 2, Control Center): each module's content arrives, leaves and answers a toggle on its own
 * springs, on top of the glass pour (liquidDrip.js draws the glass; this moves what is on it).
 *
 *   arrive  : at t0 + 0.12 + min(0.12, d x 0.0007) s (t0 = the open, d = logical px from the button to the tile), the tile's
 *             scale 0.85 -> 1 on the bead spring and its opacity 0 -> 1 on the fade role: the nearer tiles first.
 *   leave   : opacity -> 0 on a short critically damped spring {r: 0.1, z: 1}, scale -> 0.85 on the pour exit spring, while
 *             the glass drains into the button.
 *   toggle  : the on/off light crosses on the fade role (ccFeedback.js) and the tile takes a bead kick of -2.6 (a squash that
 *             keeps its area, liquid.js squash at volume 0.5).
 * The scale is the tile's own factor (feedback.js composeScale): a press on the tile multiplies it, never overwrites it. The
 * tile's glass layer is not scaled (the glass is the pour's). Full motion only: reduced motion and animations off keep the
 * v3 path (the pour's own content cross-fade, no travel). No GI-free math here: liquidClock's Ticker steps every tile. */
import {Spring, Fade, role, squash, EPS_OPACITY} from './liquid.js';
import {Ticker, nowS} from './liquidClock.js';
import {composeScale} from './feedback.js';

export const TILE = {
    from: 0.85,             // a tile's scale before it arrives and after it leaves
    delay: 0.12,            // s after the open before the first tile
    perPx: 0.0007,          // s per logical px from the button
    maxSpread: 0.12,        // s: the farthest tile waits at most this much longer
    out: {r: 0.1, z: 1},    // the content leaving
    kick: -2.6,             // the toggle's kick
    squash: 0.05,           // squash per unit of the kick spring
};

const ALL = new Set();

export class TileMotion {
    constructor(item) {
        this.item = item;
        this.s = new Spring(1, role('bead'), 1e-3);         // 0 = TILE.from, 1 = rest
        this.o = new Fade(1, role('fade'), EPS_OPACITY);
        this.sq = new Spring(0, role('bead'), 1e-3);
        this.at = 0;                                        // motion s when the arrival starts (0: none pending)
        this.ownsOpacity = false;                           // true while the tile's opacity is ours (an open or a close)
        this.restOpacity = 255;
        this._dead = false;
        this._ticker = new Ticker(dt => this._step(dt));
        ALL.add(this);
        try {
            item.connect('destroy', () => this.dispose());
        } catch (_e) {
            this._dead = true;
        }
    }

    get moving() {
        return Boolean(this.at) || !this.s.rest || !this.o.rest || !this.sq.rest;
    }

    // an open: from where the tile is (a reopen during a close keeps its speed), arriving at `at`
    arrive(at, fresh) {
        if (this._dead)
            return;
        if (fresh) {
            this.s.snap(0);
            this.o.snap(0);
        }
        this.ownsOpacity = true;
        this.at = at;
        this._apply();
        this._ticker.start();
    }

    leave() {
        if (this._dead)
            return;
        this.at = 0;
        this.ownsOpacity = true;
        this.o.set(0, TILE.out);
        this.s.set(0, role('pour', {exit: true}));
        this._apply();
        this._ticker.start();
    }

    kick() {
        if (this._dead)
            return;
        this.sq.p = role('bead');
        this.sq.kick(TILE.kick);
        this._ticker.start();
    }

    // at rest at once: scale 1, the opacity the surface had (a close finished, the style changed, disable)
    settle() {
        this.at = 0;
        this._ticker.stop();
        this.s.snap(1);
        this.o.snap(1);
        this.sq.snap(0);
        if (!this._dead) {
            if (this.ownsOpacity)
                this.item.opacity = this.restOpacity;
            this.item._vitreTile = null;
            composeScale(this.item);
        }
        this.ownsOpacity = false;
    }

    _step(dt) {
        if (this._dead)
            return false;
        if (this.at && nowS() >= this.at) {
            this.at = 0;
            this.s.set(1, role('bead'));
            this.o.set(1, role('fade'));
        }
        this.s.step(dt);
        this.o.step(dt);
        this.sq.step(dt);
        this._apply();
        if (this.moving)
            return true;
        if (this.s.x === 1 && this.o.x === 1) {
            // arrived: the surface's own opacity again (the same 255 in every case seen), the factor gone
            if (this.ownsOpacity)
                this.item.opacity = this.restOpacity;
            this.ownsOpacity = false;
            this.item._vitreTile = null;
            composeScale(this.item);
        }
        return false;
    }

    _apply() {
        if (this._dead)
            return;
        const k = TILE.from + (1 - TILE.from) * this.s.x;
        const q = squash(this.sq.x * TILE.squash, 0.5);
        this.item.set_pivot_point(0.5, 0.5);
        this.item._vitreTile = [k * q.across, k * q.along];
        composeScale(this.item);
        if (this.ownsOpacity)
            this.item.opacity = Math.round(255 * Math.min(1, Math.max(0, this.o.x)) * this.restOpacity / 255);
    }

    dispose() {
        this._dead = true;
        this._ticker.stop();
        ALL.delete(this);
    }
}

export function tileOf(item) {
    if (!item._vitreTileMotion || item._vitreTileMotion._dead)
        item._vitreTileMotion = new TileMotion(item);
    return item._vitreTileMotion;
}

// disable: every tile at rest and forgotten
export function resetTiles() {
    for (const t of [...ALL]) {
        t.settle();
        t.dispose();
        if (t.item._vitreTileMotion === t)
            t.item._vitreTileMotion = null;
    }
}

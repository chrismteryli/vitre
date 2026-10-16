/* Volume / brightness capsule side of the liquid drip (plan A17): the adapter the shared controller
 * (liquidDrip.js) drives. One piece: the capsule. The source pill is the highlight pill that already replaces
 * the Control Center icon while the capsule is up (hud.js, A15 geometry). The capsule's own glass layer is
 * hidden during the drip and takes over from the field when the capsule has settled. */
import {op255} from './liquidDrip.js';
import {smoothstep} from './dripMotion.js';
import {GLASS_FINISH} from './glass.js';

const PILL_SHOW_MS = 40;   // the replacement pill and the old icons cross over during the first ms of the drip

export class HudDripAdapter {
    constructor(hud) {
        this._hud = hud;
        this.finish = GLASS_FINISH;
        this.handoffMs = 0;
        this.immediate = true;      // the capsule's geometry is derived from the bar, known at open()
        this._held = false;
    }

    _content() {
        const a = this._hud._actors;
        return a ? [a.glyph, a.track, a.fill] : [];
    }

    geometry() {
        const hud = this._hud;
        const g = hud._geo;
        if (!hud._actors || !g)
            return null;
        const pill = g.pillX !== null
            ? {x: g.pillX, y: g.pillY, w: g.pillW, h: g.pillH}
            // no Control Center button on screen: a pill above the capsule's centre
            : {x: g.x + g.w / 2 - g.pillW / 2, y: g.pillY, w: g.pillW, h: g.pillH};
        return {pill: {...pill, keep: true}, pieces: [{id: 'hud', x: g.x, y: g.y, w: g.w, h: g.h, r: Math.min(g.radius, g.w / 2, g.h / 2), row: 0}]};
    }

    maskActor() {
        return this._hud._actors?.root ?? null;
    }

    // the capsule's own rectangle (the root is placed and sized explicitly, scale 1 during a drip): the mask uses it while a
    // pending relayout (the slider easing its width) leaves the root without a paint volume
    maskBox() {
        const g = this._hud._geo;
        return g ? {x: g.x, y: g.y, w: g.w, h: g.h} : null;
    }

    begin() {
        const a = this._hud._actors;
        if (!a)
            return;
        this._held = true;
        a.root.remove_all_transitions();
        a.root.opacity = 255;
        a.root.set_scale(1, 1);
        a.glass.actor.opacity = 0;
        for (const c of this._content())
            c.opacity = 0;
    }

    setPiece(_id, {real, content, clip}) {
        const a = this._hud._actors;
        if (!a)
            return;
        a.glass.actor.opacity = op255(real);
        for (const c of this._content())
            c.opacity = op255(content);
    }

    // per frame: the replacement pill and the old top-bar icons cross over at the start, back at the end
    frame(_fr, tau) {
        const hud = this._hud;
        const a = hud._actors;
        if (!a || !hud._swap)
            return;
        const p = smoothstep(0, PILL_SHOW_MS, tau);
        a.pill.opacity = hud._swap.on ? op255(p) : 0;
        if (hud._swap.indicators)
            hud._swap.indicators.opacity = Math.round(hud._swap.indicatorsOp * (1 - p));
    }

    end() {
        const a = this._hud._actors;
        this._held = false;
        if (!a)
            return;
        a.root.opacity = 255;
        a.glass.actor.opacity = 255;
        for (const c of this._content())
            c.opacity = 255;
    }
}

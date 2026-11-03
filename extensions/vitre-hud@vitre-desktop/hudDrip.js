/* Volume / brightness capsule side of the liquid drip (plan A17): the adapter the shared controller
 * (liquidDrip.js) drives. One piece: the capsule. The source pill is the highlight pill that already replaces
 * the Control Center icon while the capsule is up (hud.js, A15 geometry). The capsule's own glass layer is
 * hidden during the drip and takes over from the field when the capsule has settled. */
import {op255} from './liquidDrip.js';
import {Fade, role, EPS_OPACITY} from './liquid.js';
import {GLASS_FINISH} from './glass.js';

const PILL_HOME = 0.25;     // closing: the pill hands back to the top-bar icons once the glass is this close to home


export class HudDripAdapter {
    constructor(hud) {
        this._hud = hud;
        this.finish = GLASS_FINISH;
        this.handoffMs = 0;
        this.immediate = true;      // the capsule's geometry is derived from the bar, known at open()
        this._held = false;
        this._pill = new Fade(0, role('fade'), EPS_OPACITY);    // the replacement pill and the old icons cross over (a Fade spring)
        this._pillT = null;
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
        // the pill carries on from what it shows now (a close that starts from rest finds it fully in)
        this._pill.snap(this._hud._swap?.on ? a.pill.opacity / 255 : 0);
        this._pillT = null;
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

    // per frame: the replacement pill and the old top-bar icons cross over on a Fade spring: in as the glass leaves the bar,
    // out as it comes home (the pour's openness falls under PILL_HOME)
    frame(fr, tau, phase) {
        const hud = this._hud;
        const a = hud._actors;
        if (a)
            this._mapContent(fr);
        if (!a || !hud._swap)
            return;
        const now = tau / 1000;
        const dt = this._pillT === null || now < this._pillT ? 0 : now - this._pillT;
        this._pillT = now;
        this._pill.set(phase === 'closing' && (fr.openness ?? 1) < PILL_HOME ? 0 : 1);
        this._pill.step(dt);
        const p = this._pill.x;
        a.pill.opacity = hud._swap.on ? op255(p) : 0;
        if (hud._swap.indicators)
            hud._swap.indicators.opacity = Math.round(hud._swap.indicatorsOp * (1 - p));
    }

    // Motion Lab 2 (HUD): the content rides on the glass. Its box is mapped onto the moving glass box (top-left origin, x and y
    // apart), as the lab maps the capsule's content onto the pour's box; at rest the two boxes are one and nothing is scaled.
    _mapContent(fr) {
        const g = this._hud._geo;
        const d = fr?.drop;
        let kx = 1, ky = 1, bx = 0, by = 0;
        if (g && d && d.x > -9000 && d.w > 0 && d.h > 0 && fr.mode !== 'closed') {
            kx = Math.min(2, Math.max(0.01, 2 * d.w / g.w));
            ky = Math.min(2, Math.max(0.01, 2 * d.h / g.h));
            bx = d.x - d.w - g.x;
            by = d.y - d.h - g.y;
        }
        this._setContentPose(kx, ky, bx, by);
    }

    _setContentPose(kx, ky, bx, by) {
        for (const c of this._content()) {
            const [px, py] = c.get_pivot_point();
            if (px !== 0 || py !== 0)
                c.set_pivot_point(0, 0);
            if (c.scale_x !== kx || c.scale_y !== ky)
                c.set_scale(kx, ky);
            c.translation_x = bx + c.x * (kx - 1);
            c.translation_y = by + c.y * (ky - 1);
        }
    }

    end() {
        const a = this._hud._actors;
        if (a)
            this._setContentPose(1, 1, 0, 0);
        this._held = false;
        this._pillT = null;
        if (!a)
            return;
        a.root.opacity = 255;
        a.glass.actor.opacity = 255;
        for (const c of this._content())
            c.opacity = 255;
    }
}

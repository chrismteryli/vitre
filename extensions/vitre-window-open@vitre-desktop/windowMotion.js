// Vitre window motion (liquid v3): open, close, minimize into the Dock and restore out of it, on liquid.js springs.
//
// GNOME keeps ownership of each effect and of its completion: its map / minimize / unminimize / destroy handler eases the
// window and the FIRST eased property's transition (the "carrier") calls GNOME's done handler when it stops. This module
// keeps that carrier and removes GNOME's other transitions on the window. The carrier is retimed to a long linear run and
// its interval is rewritten from its own 'new-frame' signal (which runs before the transition's class handler applies the
// value in that same frame), so the property it carries follows the springs with no lag and is never set under GNOME. Every
// other property (scale, translation, opacity when the carrier is not opacity) is set directly: nothing of GNOME animates it
// any more. When the springs rest, the carrier is let finish on the next frame and GNOME completes the effect as always.
//
// The window is a box of four edge springs on the frame rectangle (the lab's windows): the leading edges on the 'glide'
// role, the trailing edge on glide x viscosity (it stretches with speed and relaxes on its own). The picture is that box:
// a scale (x and y apart) and a translation of the window actor. A window's springs outlive a killed effect for a moment,
// so a restore that interrupts a minimize (or the reverse) turns around from where the window is, with its speed.
//   open      the box grows from 0.9 of the frame (pour: the lab's window open; the top edge on pour x viscosity), opacity in on
//             the fade role
//   close     the box shrinks to 0.94 on the glide exit spring, every edge on it (never bouncing, no trailing edge: the lab's
//             close), opacity out on the fade exit spring
//   minimize  the box pours into the Dock button (bottom edge leads, the top trails); the window melts as it nears the
//             icon's size; the icon swallows it (a bead kick) as the bottom edge arrives
//   restore   the box pours back out of the button (the far, top edge leads); the icon gives (a bead kick) as it leaves
//   no button: in place (the box to / from 0.88, opacity on the fade springs)
// Reduced motion: no travel; opacity crosses on the 160 ms spring. Animations off: GNOME's own (instant).
import Clutter from 'gi://Clutter';

import {Spring, Fade, role, feel, squash, REDUCED, EPS_PX, EPS_OPACITY} from './liquid.js';
import {nowS, motionMode, slowFactor, Ticker} from './liquidClock.js';

const EDGES = ['top', 'bottom', 'left', 'right'];
const WATCHDOG_MS = 5000;           // the carrier's run: the springs end it long before (a stuck motion still completes)
const CARRY_S = 0.25;               // a window's springs are taken over by its next effect within this long
const MAX_STEP_S = 1 / 30;          // a frame the shell held slows the motion instead of skipping it
export const SCALE = {open: 0.9, close: 0.94, inPlace: 0.88};
const MIN_DONE_PX = 3;              // a minimize is done once the box is this close to the button on its top edge and width
const GULP_PX = 8;                  // ... and the icon swallows it when the bottom edge is this close
const KICK = {gulp: 3.0, give: -2.2, squash: 0.06};     // the lab's icon kicks (gulp x (0.5 + volume)) and squash scale

const edgesOf = r => ({top: r.y, bottom: r.y + r.h, left: r.x, right: r.x + r.w});
const scaled = (r, s) => ({x: r.x + r.w * (1 - s) / 2, y: r.y + r.h * (1 - s) / 2, w: r.w * s, h: r.h * s});
const clamp01 = v => Math.min(1, Math.max(0, v));

// per window actor: its springs, kept for CARRY_S after its effect ends so the next effect continues them
const STATES = new WeakMap();

export function stateOf(actor) {
    const st = STATES.get(actor);
    if (!st)
        return null;
    if (!st.active && nowS() - st.endedAt > CARRY_S) {
        STATES.delete(actor);
        return null;
    }
    return st;
}

function newState(box) {
    const e = edgesOf(box);
    const s = {};
    for (const k of EDGES)
        s[k] = new Spring(e[k], role('glide'), EPS_PX);
    return {s, op: new Fade(1, role('fade'), EPS_OPACITY), active: false, endedAt: 0, flight: null};
}

// A Dock icon's squash (bead): kicks add speed; it settles on its own.
export class IconKick {
    constructor(icon, alive) {
        this._icon = icon;
        this._alive = alive;
        this._s = new Spring(0, role('bead'), 1e-3);
        this._ticker = new Ticker(dt => this._step(dt));
    }

    kick(v) {
        if (!this._alive(this._icon))
            return;
        this._icon.set_pivot_point(0.5, 1.0);
        this._s.kick(v);
        this._ticker.start();
    }

    _step(dt) {
        if (!this._alive(this._icon))
            return false;
        const x = this._s.step(dt);
        const vol = Math.max(0.5, feel().volume);
        const q = squash(x * KICK.squash, vol);
        this._icon.set_scale(q.across, q.along);
        if (!this._s.rest)
            return true;
        this._icon.set_scale(1, 1);
        return false;
    }

    stop() {
        this._ticker.stop();
        if (this._alive(this._icon))
            this._icon.set_scale(1, 1);
    }
}

/**
 * Take over one of GNOME's window effects.
 * @param {Meta.WindowActor} actor
 * @param {object} o
 *   kind: 'open' | 'close' | 'minimize' | 'restore'
 *   carrier: GNOME's first transition (its completion) ; carrierProp: 'opacity' | 'scale_x'
 *   frame: the window's frame rectangle at rest, stage px ; at: the actor's position at rest {x, y}
 *   from: the box to start from when nothing carries over (null: the frame) ; to: the box to go to
 *   lead: the edge that leads ('bottom' or 'top'; the opposite edge trails) ; exit: exit parameters (never bouncing)
 *   op: 'fade' (opacity springs to opTo) or 'size' (opacity follows the box's size: it melts near the icon)
 *   opFrom, opTo ; icon: an IconKick for the Dock icon (or null) ; onEnd(finished)
 */
export function fly(actor, o) {
    const mode = motionMode();
    let st = stateOf(actor);
    const carried = Boolean(st);
    if (!st) {
        st = newState(o.from ?? o.frame);
        STATES.set(actor, st);
        st.op.snap(o.opFrom ?? 1);
    }
    st.flight?.detach();
    const reduced = mode === 'reduced';
    const F = o.frame;
    if (reduced) {
        // no travel: the window is at rest in place and crosses over (a minimize fades out, a restore fades in: their
        // full-motion opacity follows the box's size, which does not change here)
        const e = edgesOf(F);
        for (const k of EDGES)
            st.s[k].snap(e[k]);
        const opTo = o.kind === 'minimize' ? 0 : o.kind === 'restore' ? 1 : o.opTo;
        if (!carried)
            st.op.snap(o.kind === 'restore' ? 0 : o.opFrom ?? 1);
        st.op.set(opTo, REDUCED);
    } else {
        // Motion Lab 2 (windows): an open pours (role 'pour', the top edge on pour x viscosity); a close shrinks on the glide exit
        // spring with no trailing edge (the lab gives every edge the same exit spring); minimize and restore glide
        const roleName = o.role ?? 'glide';
        const lead = o.exit ? role(roleName, {exit: true}) : role(roleName);
        const trail = o.kind === 'close' ? lead : {r: lead.r * feel().visc, z: lead.z};
        const trailEdge = o.lead === 'top' ? 'bottom' : 'top';
        const e = edgesOf(o.to);
        for (const k of EDGES)
            st.s[k].set(e[k], k === trailEdge ? trail : lead);
        if (o.op === 'fade')
            st.op.set(o.opTo, o.opTo < st.op.x ? role('fade', {exit: true}) : role('fade'));
        else
            st.op.snap(1);
    }
    st.active = true;
    const flight = new Flight(actor, st, o, reduced);
    st.flight = flight;
    flight.start();
    return flight;
}

class Flight {
    constructor(actor, st, o, reduced) {
        this.actor = actor;
        this.st = st;
        this.o = o;
        this.reduced = reduced;
        this.done = false;
        this._last = nowS();
        this._ids = [];
        this._gulped = false;
        this._ending = false;
        this.frames = 0;
    }

    start() {
        const {carrier, carrierProp} = this.o;
        const actor = this.actor;
        // GNOME's other transitions go (no completion is attached to them); the carrier stays and is retimed
        for (const p of ['opacity', 'scale-x', 'scale-y', 'x', 'y', 'translation-x', 'translation-y']) {
            const t = actor.get_transition(p);
            if (t && t !== carrier)
                actor.remove_transition(p);
        }
        actor.set_position(this.o.at.x, this.o.at.y);
        actor.set_pivot_point(0, 0);
        carrier.progress_mode = Clutter.AnimationMode.LINEAR;
        carrier.set_duration(Math.round(WATCHDOG_MS * slowFactor()));
        this._ids.push([carrier, carrier.connect('new-frame', () => this._frame())]);
        this._ids.push([carrier, carrier.connect('stopped', (_t, finished) => this._stopped(finished))]);
        if (this.o.kind === 'restore')
            this.o.icon?.kick(KICK.give);
        this._apply();
    }

    // the carrier's frame: step the springs, write the pose (the carrier's own property through its interval)
    _frame() {
        if (this.done)
            return;
        const now = nowS();
        const dt = Math.min(MAX_STEP_S, Math.max(0, now - this._last));
        this._last = now;
        const s = this.st.s;
        for (const k of EDGES)
            s[k].step(dt);
        this.st.op.step(dt);
        this.frames++;
        this._apply();
        if (this._ending)
            return;
        const o = this.o;
        const to = edgesOf(o.to);
        if (o.kind === 'minimize' && !this._gulped && Math.abs(s.bottom.x - to.bottom) < GULP_PX) {
            this._gulped = true;
            o.icon?.kick(KICK.gulp * (0.5 + feel().volume));
        }
        let rest;
        if (o.kind === 'minimize' && !this.reduced)
            rest = Math.abs(s.top.x - to.top) < MIN_DONE_PX && Math.abs((s.right.x - s.left.x) - (to.right - to.left)) < MIN_DONE_PX;
        else if (o.kind === 'close')
            rest = this.st.op.rest && this.st.op.x === 0;
        else
            rest = EDGES.every(k => s[k].rest) && this.st.op.rest;
        if (rest) {
            // let the carrier finish on its next frame: GNOME then completes the effect
            this._ending = true;
            const c = o.carrier;
            c.set_duration(Math.max(1, c.get_elapsed_time()));
        }
    }

    // the pose: the box as a scale and a translation of the actor (pivot at its origin)
    _apply() {
        const {actor, st, o} = this;
        const F = o.frame;
        const s = st.s;
        const bw = Math.max(1, s.right.x - s.left.x), bh = Math.max(1, s.bottom.x - s.top.x);
        const sx = bw / Math.max(1, F.w), sy = bh / Math.max(1, F.h);
        // the frame sits at (F.x - at.x, F.y - at.y) inside the actor: put that point on the box's top-left
        const ox = F.x - o.at.x, oy = F.y - o.at.y;
        const tx = s.left.x - o.at.x - sx * ox, ty = s.top.x - o.at.y - sy * oy;
        let op = st.op.x;
        if (o.op === 'size' && !this.reduced)
            op = clamp01((bh / Math.max(1, F.h) - 0.14) / 0.4);
        const opacity = Math.round(255 * clamp01(op));
        const set = (prop, v) => {
            if (prop === o.carrierProp) {
                o.carrier.set_from(v);
                o.carrier.set_to(v);
            } else {
                actor[prop] = v;
            }
        };
        set('scale_x', sx);
        set('scale_y', sy);
        actor.translation_x = tx;
        actor.translation_y = ty;
        set('opacity', opacity);
    }

    _stopped(finished) {
        if (this.done)
            return;
        this.done = true;
        this.detach();
        const st = this.st;
        st.active = false;
        st.endedAt = nowS();
        if (st.flight === this)
            st.flight = null;
        // the window keeps no offset of ours (GNOME's done handler has reset scale, opacity and pivot); a closed window's
        // actor is GNOME's to destroy and is not touched again
        if (this.o.kind !== 'close') {
            this.actor.translation_x = 0;
            this.actor.translation_y = 0;
        }
        if (finished)
            STATES.delete(this.actor);
        this.o.onEnd?.(finished);
    }

    detach() {
        for (const [obj, id] of this._ids.splice(0)) {
            try {
                obj.disconnect(id);
            } catch (_e) {
                // gone
            }
        }
    }
}

export {scaled, edgesOf};

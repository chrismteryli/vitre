// Vitre liquid motion, GNOME side: the clock that steps liquid.js springs once per painted frame, and the motion mode.
// Carried byte-identical by every Vitre extension that moves something (tools/check-engine.sh), next to liquid.js.
//
// GNOME 51 ignores Clutter.Transition.set_progress_func, so springs are not Clutter transitions: a Clutter.Timeline on a
// stage actor only paces the frames (new-frame), and the springs are stepped by the wall-clock time between frames
// (a Timeline's own elapsed time counts from the frame clock's last timestamp, which is stale when it starts out of an idle
// period). It runs only while something moves.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Spring, Fade, role, REDUCED, EPS_PX, EPS_OPACITY} from './liquid.js';

// Rig only: VITRE_MOTION_SLOW=8 plays every motion 8 times slower, for filmstrips. Unset in a session.
const ENV_SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);
export const slowFactor = () => Math.max(1, Number(globalThis.__vitreMotionSlow) || ENV_SLOW);

// motion seconds now (the rig's slow motion stretches them)
export const nowS = () => GLib.get_monotonic_time() / 1e6 / slowFactor();

// 'off' (animations off: cut), 'reduced' (reduced motion: a 160 ms cross-fade in place), 'full'
export function motionMode() {
    const s = St.Settings.get();
    if (!s.enable_animations)
        return 'off';
    if (s.reducedMotion === St.ReducedMotion.REDUCE)
        return 'reduced';
    return 'full';
}

// A frame-paced ticker. tick(dt, now) is called once per frame with motion seconds; it returns true while anything still
// moves, false when everything rests (the ticker then stops by itself). The longest step is capped (maxDt) so a frame the
// shell holds (a first paint, a restack) slows the motion there instead of skipping ahead.
export class Ticker {
    constructor(tick, {actor = null, maxDt = 1 / 30} = {}) {
        this._tick = tick;
        this._actor = actor;
        this._maxDt = maxDt;
        this._tl = null;
        this._last = 0;
        this._manual = false;
    }

    get running() {
        return Boolean(this._tl);
    }

    start() {
        if (this._tl || this._manual)
            return;
        const actor = this._actor ?? Main.uiGroup;
        const tl = new Clutter.Timeline({duration: 3600000, actor});
        this._tl = tl;
        this._last = nowS();
        tl.connect('new-frame', () => {
            const now = nowS();
            const dt = Math.min(this._maxDt, Math.max(0, now - this._last));
            this._last = now;
            let more = false;
            try {
                more = this._tick(dt, now);
            } catch (e) {
                console.error(`Vitre liquid: frame failed: ${e?.message ?? e}`);
                more = false;
            }
            if (!more)
                this.stop();
        });
        tl.start();
    }

    stop() {
        const tl = this._tl;
        if (!tl)
            return;
        this._tl = null;
        tl.stop();
    }

    // rig: drive the ticker by hand (advance(dt) steps once)
    setManual(on) {
        this._manual = on;
        if (on)
            this.stop();
    }

    advance(dt) {
        return this._tick(dt, nowS());
    }
}

// ---- actor properties on springs --------------------------------------------------------------------------------------
// animate(actor, {opacity: 0, scale_x: 1, translation_y: 12, ...}, {p, fade, onDone}) moves each property on a liquid.js spring
// from where it is, keeping the speed of a spring already moving it (retargeting). opacity (0..255) is a Fade spring on
// 0..1 (never past its target); every other property a Spring with params p (default: the fade role for opacity, 'bead'
// otherwise). onDone(finished) runs once every property of this call rests (true), or when a later call takes one of its
// properties over or stop() is called (false), as ease()'s onStopped. Any GNOME transition on those properties is removed
// first (a property GNOME animates is never written under it). Reduced motion: opacity crosses on the 160 ms spring and the
// other properties are set at once (no travel); animations off: everything is set at once.

const SCALE_PROPS = new Set(['scale_x', 'scale_y', 'scale_z']);
// did someone else write this property since we did (float properties read back rounded to float32: a tolerance)
const changed = (now, ours) => Math.abs(now - ours) > Math.max(1e-3, Math.abs(ours) * 1e-6);
const ANGLE_PROPS = new Set(['rotation_angle_x', 'rotation_angle_y', 'rotation_angle_z']);

function epsOf(prop) {
    if (SCALE_PROPS.has(prop))
        return 1e-4;
    if (ANGLE_PROPS.has(prop))
        return 0.02;
    return EPS_PX;
}

export function animate(actor, targets, {p = null, fade = null, onDone = null} = {}) {
    const mode = motionMode();
    if (actor._vitreSprings?.dead)
        return null;
    let st = actor._vitreSprings;
    if (!st) {
        st = actor._vitreSprings = {springs: new Map(), owners: new Map(), ticker: null, calls: new Set(), written: new Map(), dead: false};
        // a destroyed actor is never touched again: its springs stop, their calls end not finished (as its transitions would)
        try {
            actor.connect('destroy', () => {
                st.dead = true;
                st.ticker?.stop();
                st.springs.clear();
                st.written.clear();
                st.owners.clear();
                if (actor._vitreEaseDelay) {
                    GLib.Source.remove(actor._vitreEaseDelay);
                    actor._vitreEaseDelay = 0;
                }
                for (const c of [...st.calls]) {
                    st.calls.delete(c);
                    if (!c.done) {
                        c.done = true;
                        c.onDone?.(false);
                    }
                }
            });
        } catch (_e) {
            // not an actor that can be destroyed
        }
    }
    const call = {props: new Set(Object.keys(targets)), onDone, done: false};
    // a property taken over from an earlier call ends that call (not finished)
    for (const prop of call.props) {
        const prev = st.owners.get(prop);
        if (prev && prev !== call) {
            prev.props.delete(prop);
            if (!prev.done && prev.props.size === 0) {
                prev.done = true;
                st.calls.delete(prev);
                prev.onDone?.(false);
            }
        }
        st.owners.set(prop, call);
        actor.remove_transition?.(prop.replaceAll('_', '-'));
    }
    st.calls.add(call);
    for (const [prop, to] of Object.entries(targets)) {
        const isOp = prop === 'opacity';
        if (mode === 'off' || (mode === 'reduced' && !isOp)) {
            st.springs.delete(prop);
            actor[prop] = to;
            continue;
        }
        // a value someone else wrote since our last frame is where the spring starts (their write, not ours, is on screen)
        if (st.springs.has(prop) && st.written.has(prop) && changed(actor[prop], st.written.get(prop)))
            st.springs.delete(prop);
        let s = st.springs.get(prop);
        if (!s) {
            s = isOp ? new Fade(actor.opacity / 255, role('fade'), EPS_OPACITY) : new Spring(actor[prop], role('bead'), epsOf(prop));
            st.springs.set(prop, s);
        }
        const params = isOp ? (mode === 'reduced' ? REDUCED : fade ?? role('fade')) : p ?? role('bead');
        s.set(isOp ? to / 255 : to, params);
    }
    const settle = () => {
        for (const c of [...st.calls]) {
            const moving = [...c.props].some(prop => st.springs.has(prop) && !st.springs.get(prop).rest);
            if (!moving && !c.done) {
                c.done = true;
                st.calls.delete(c);
                for (const prop of c.props) {
                    if (st.owners.get(prop) === c)
                        st.owners.delete(prop);
                }
                c.onDone?.(true);
            }
        }
    };
    if (!st.ticker) {
        st.ticker = new Ticker(dt => {
            if (st.dead)
                return false;
            let more = false;
            for (const [prop, s] of st.springs) {
                // the property was written by someone else (its owner set it directly): that ends this spring, as removing a
                // transition would (the call that moved it ends not finished)
                if (st.written.has(prop) && changed(actor[prop], st.written.get(prop))) {
                    st.springs.delete(prop);
                    st.written.delete(prop);
                    const c = st.owners.get(prop);
                    st.owners.delete(prop);
                    if (c && !c.done) {
                        c.props.delete(prop);
                        if (c.props.size === 0) {
                            c.done = true;
                            st.calls.delete(c);
                            c.onDone?.(false);
                        }
                    }
                    continue;
                }
                const x = s.step(dt);
                actor[prop] = prop === 'opacity' ? Math.round(255 * Math.min(1, Math.max(0, x))) : x;
                st.written.set(prop, actor[prop]);
                if (s.rest) {
                    st.springs.delete(prop);
                    st.written.delete(prop);
                } else {
                    more = true;
                }
            }
            settle();
            return more;
        });
    }
    settle();
    if (st.springs.size)
        st.ticker.start();
    return call;
}

// stop every spring on the actor where it is (callbacks: not finished)
export function stopAnimate(actor) {
    const st = actor._vitreSprings;
    if (!st)
        return;
    st.ticker?.stop();
    st.springs.clear();
    st.owners.clear();
    st.written?.clear();
    if (actor._vitreEaseDelay) {
        GLib.Source.remove(actor._vitreEaseDelay);
        actor._vitreEaseDelay = 0;
    }
    for (const c of [...st.calls]) {
        st.calls.delete(c);
        if (!c.done) {
            c.done = true;
            c.onDone?.(false);
        }
    }
}

// is any property of the actor still moving on a spring
export function animating(actor) {
    return Boolean(actor._vitreSprings?.springs.size);
}

// GNOME's ease(), on springs: ease(actor, {prop: value, ..., duration, mode, delay, onComplete, onStopped}, {role}) moves each
// numeric property on a liquid.js spring of the role (default 'bead': small things), opacity on the fade role. duration and mode
// are not used: the role is the motion. A call whose opacity goes to 0 is an exit (response x 0.8, damping >= 0.94: never
// bouncing). duration 0 sets at once. delay waits that long (motion time) before it starts. onStopped(finished) and onComplete
// run as ease()'s. An actor whose eases are taken over by an owner (actor._vitreEase, the Dock menus' pour) keeps its own ease;
// a repeating or non-numeric ease is left to GNOME (none of the Dock's live ones).
export function ease(actor, params, {role: roleName = 'bead'} = {}) {
    if (!actor || actor._vitreSprings?.dead)
        return;
    if (actor._vitreEase && typeof actor.ease === 'function')
        return actor.ease(params);
    const {duration, mode: _mode, delay, onComplete, onStopped, repeatCount, autoReverse, animationRequired: _ar, ...props} = params;
    if (repeatCount || autoReverse || Object.values(props).some(v => typeof v !== 'number'))
        return actor.ease(params);
    const done = finished => {
        onStopped?.(finished);
        if (finished)
            onComplete?.();
    };
    const exit = props.opacity === 0;
    const start = () => {
        if (duration === 0) {
            stopProps(actor, Object.keys(props));
            for (const [k, v] of Object.entries(props))
                actor[k] = v;
            done(true);
            return;
        }
        animate(actor, props, {p: role(roleName, {exit}), fade: role('fade', {exit: exit || (props.opacity ?? 255) < actor.opacity}), onDone: done});
    };
    if (actor._vitreEaseDelay) {
        GLib.Source.remove(actor._vitreEaseDelay);
        actor._vitreEaseDelay = 0;
    }
    if (delay > 0 && motionMode() !== 'off') {
        actor._vitreEaseDelay = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(delay * slowFactor()), () => {
            actor._vitreEaseDelay = 0;
            start();
            return GLib.SOURCE_REMOVE;
        });
        return;
    }
    start();
}

// stop the springs of these properties where they are (their calls end not finished)
export function stopProps(actor, props) {
    const st = actor._vitreSprings;
    if (!st)
        return;
    for (const prop of props) {
        st.springs.delete(prop);
        st.written.delete(prop);
        const c = st.owners.get(prop);
        st.owners.delete(prop);
        if (c && !c.done) {
            c.props.delete(prop);
            if (c.props.size === 0) {
                c.done = true;
                st.calls.delete(c);
                c.onDone?.(false);
            }
        }
    }
}

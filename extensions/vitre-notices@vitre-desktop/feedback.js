/* A13: hover and click feedback for Control Center and Notification Center.
 *
 * ONE TABLE OF CONSTANTS (below). Every number in this feature is here, labelled MEASURED
 * (read frame by frame from the reference design reference 26 screen recordings, plan A13 section 1) or ESTIMATE
 * (the reference publishes nothing and no clean recording exists: the reference's documented behaviour,
 * "interactive glass reacts to touch and pointer in real time", with conservative numbers).
 * Retune the feel here and nowhere else. This file is byte-identical in control-center and
 * notification-center (like glass.js); each extension only reads the constants it uses.
 *
 * Motion (liquid v3): every value moves on a liquid.js spring (liquidClock.js Ticker, wall clock per frame, NOT slowed by
 * St's slow_down_factor): fades and cross-fades on the fade role (never past the target), the press and the knob/lens morph
 * on the bead role (the glass gives a little and settles), the notification stack on the pour role. No durations.
 * Animations off: every change is instant. Reduced motion: fades cross over on the 160 ms spring, travel is instant.
 */
import {Spring, Fade, role, REDUCED, EPS_OPACITY} from './liquid.js';
import {Ticker, motionMode} from './liquidClock.js';

export const FB = {
    // ---- MEASURED (the reference design reference 26 recordings, 60 fps, plan A13 section 1) ----------------------
    knobDiameter: 12,        // slider hover knob: 3x the 4 px track (the reference ~10-11 pt -> 12 px)
    lensWidthRatio: 1.6,     // pressed lens width / knob width
    lensHeightRatio: 1.15,   // pressed lens height / knob height ("same or slightly taller": 1.0-1.15)
    tileChevronRight: 14,    // 12.5 pt x 1.15 from the tile's right edge
    tileChevronCenterY: 19,  // aligned with the 11 pt title line (title top 11 px + half a line)
    pillChevronRight: 14,    // ~12 pt x 1.15 from the pill's right end

    // ---- ESTIMATES (plan A13 section 1: not measured) -----------------------------------------
    chevronWidth: 6,         // ">" glyph box (the reference's looks about 5 x 8 pt)
    chevronHeight: 10,
    chevronStroke: 1.8,
    lensBlurRadius: 3,       // small blur so the 4 px track stays visible through the lens
    lensBrightness: 1.0,     // "blurred / brightened backdrop"; Shell.BlurEffect.brightness is 0..1 (1.2 was rejected with a GLib-GObject-CRITICAL x3 per activation and the default 1.0 applied)
    lensFinish: {tint: 0.14, rimSide: 0.55, rimTop: 0.95, rimBottom: 0.85, rimWidth: 1.4},
    pressScale: 1.04,        // pressed shape scales to this about its centre
    pressGrowCapPx: 3,       // ...but never grows more than this per side (a 381 px card at 1.04 would clip)
    pressTintBoost: 0.08,    // glass tint +8 % (white glow +8 % on shapes without glass)
};

// Test seam (rig only, null in a real session): when set, every Tween reports (label, value, kind)
// as it starts ('start') and as it applies each frame ('frame') so the rig can time a transition
// from the frame callbacks themselves instead of from painted frames.
export const probe = {fn: null};

// animations on (reduced motion counts: fades still cross over, on the 160 ms spring)
export function animationsOn() {
    return motionMode() !== 'off';
}

// what a Tween moves on: 'fade' (opacity, cross-fades), 'bead' (press, morph), 'pour' (a stack opening), 'exit' (closing)
const KIND = {
    fade: () => role('fade'),
    bead: () => role('bead'),
    pour: () => role('pour'),
    exit: () => role('pour', {exit: true}),       // something going away (a stack collapsing): never bouncing
};

/* A number that moves to a target on a liquid.js spring and reports every value to `apply`. Interruptible: a new target
 * retargets the spring (it keeps its speed). `actor` must be on the stage for it to move (else the value is set at once). */
export class Tween {
    constructor(actor, apply, initial = 0, label = '') {
        this._actor = actor;
        this._apply = apply;
        this.label = label;
        this._s = null;
        this._onDone = null;
        this._t = 0;
        this._ticker = new Ticker(dt => this._step(dt));
        this.value = initial;
    }

    _emit(value, kind, elapsed = 0) {
        probe.fn?.(this.label, value, kind, elapsed);
    }

    get running() {
        return this._ticker.running;
    }

    stop() {
        this._ticker.stop();
        this._s = null;
        this._onDone = null;
    }

    set(value) {
        this.stop();
        this.value = value;
        this._emit(value, 'set');
        this._apply(value);
    }

    // kind: 'fade' | 'bead' | 'pour' | 'exit'. onDone runs when the spring rests on the target (also when it is applied at once); an
    // interrupted move never calls it.
    to(target, kind = 'bead', onDone = null) {
        const mode = motionMode();
        const fade = kind === 'fade';
        if (target === this.value && !this._s) {
            this._apply(target);
            onDone?.();
            return;
        }
        if (mode === 'off' || (mode === 'reduced' && !fade) || !this._actor.get_stage() || !this._actor.mapped) {
            this.set(target);
            onDone?.();
            return;
        }
        const p = mode === 'reduced' ? REDUCED : (KIND[kind] ?? KIND.bead)();
        if (!this._s || this._s.fade !== fade) {
            const v = this._s?.v ?? 0;
            this._s = fade ? new Fade(this.value, p, EPS_OPACITY) : new Spring(this.value, p, 1e-3);
            this._s.v = v;
            this._s.fade = fade;
            this._t = 0;
            this._emit(this.value, 'start');
        }
        this._s.set(target, p);
        this._onDone = onDone;
        this._ticker.start();
    }

    _step(dt) {
        const s = this._s;
        if (!s)
            return false;
        this._t += dt;
        this.value = s.step(dt);
        this._emit(this.value, 'frame', this._t * 1000);
        this._apply(this.value);
        if (!s.rest)
            return true;
        this._s = null;
        const done = this._onDone;
        this._onDone = null;
        done?.();
        return false;
    }

    destroy() {
        this.stop();
    }
}

/* How much a shape of this size may grow on press: FB.pressScale, capped to pressGrowCapPx per side. */
export function pressGrow(width, height) {
    const big = Math.max(width, height, 1);
    return Math.min(FB.pressScale - 1, 2 * FB.pressGrowCapPx / big);
}

/* The press response of one pressable shape: p goes 0 -> 1 on press and back to 0 on release, on the bead spring (the glass
 * gives under the finger and springs back). `apply(p)` does the visuals (scale, tint). */
export class PressResponse {
    constructor(actor, apply, label = 'press') {
        this.tween = new Tween(actor, apply, 0, label);
    }

    get p() {
        return this.tween.value;
    }

    press() {
        this.tween.to(1, 'bead');
    }

    release() {
        this.tween.to(0, 'bead');
    }

    destroy() {
        this.tween.destroy();
    }
}

/* Drive a PressResponse from an St.Button's pressed state. */
export function bindPress(button, response) {
    const sync = () => {
        if (button.pressed)
            response.press();
        else
            response.release();
    };
    button.connectObject('notify::pressed', sync, response);
    return () => button.disconnectObject(response);
}

/* Scale `actors` about their centres (a press). An actor that also carries a factor of its own (actor._vitreTile = [x, y]:
 * the Control Center tiles' arrival and squash, tiles.js) is scaled by the product. */
export function setScale(actors, scale) {
    for (const actor of actors) {
        actor._vitrePress = scale;
        composeScale(actor);
    }
}

export function composeScale(actor) {
    const p = actor._vitrePress ?? 1;
    const t = actor._vitreTile;
    actor.scale_x = p * (t ? t[0] : 1);
    actor.scale_y = p * (t ? t[1] : 1);
}

export function centrePivot(actors) {
    for (const actor of actors)
        actor.set_pivot_point(0.5, 0.5);
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function lerpColor(a, b, t) {
    return {red: lerp(a.red, b.red, t), green: lerp(a.green, b.green, t),
        blue: lerp(a.blue, b.blue, t), alpha: lerp(a.alpha, b.alpha, t)};
}

export function cssRgba(c) {
    return `rgba(${Math.round(c.red)}, ${Math.round(c.green)}, ${Math.round(c.blue)}, ${(c.alpha / 255).toFixed(3)})`;
}

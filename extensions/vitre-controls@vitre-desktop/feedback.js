/* A13: hover and click feedback for Control Center and Notification Center.
 *
 * ONE TABLE OF CONSTANTS (below). Every number in this feature is here, labelled MEASURED
 * (read frame by frame from the reference design reference 26 screen recordings, plan A13 section 1) or ESTIMATE
 * (the reference publishes nothing and no clean recording exists: the reference's documented behaviour,
 * "interactive glass reacts to touch and pointer in real time", with conservative numbers).
 * Retune the feel here and nowhere else. This file is byte-identical in control-center and
 * notification-center (like glass.js); each extension only reads the constants it uses.
 *
 * Time base: Clutter.Timeline (NOT slowed by St's slow_down_factor, which Just Perfection sets to
 * 0.8), so the reference's measured timings are played as measured. Animations off / reduced motion:
 * every transition is instant.
 */
import Clutter from 'gi://Clutter';
import St from 'gi://St';

export const FB = {
    // ---- MEASURED (the reference design reference 26 recordings, 60 fps, plan A13 section 1) ----------------------
    knobDiameter: 12,        // slider hover knob: 3x the 4 px track (the reference ~10-11 pt -> 12 px)
    lensWidthRatio: 1.6,     // pressed lens width / knob width
    lensHeightRatio: 1.15,   // pressed lens height / knob height ("same or slightly taller": 1.0-1.15)
    morphMs: 50,             // knob <-> lens morph (the reference 2-3 frames = 40-60 ms)
    hoverInMs: 25,           // knob + tile chevron appear (the reference: within ~2 frames)
    hoverOutMs: 60,          // knob + tile chevron fade out (the reference: 3-4 frames = 50-70 ms)
    pillChevronInMs: 50,     // pill chevron fades in (the reference ~3 frames)
    pillChevronOutMs: 60,    // pill chevron fades out (the reference: "fade out on leave", not timed: same as the knob)
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
    pressInMs: 80,           // press: ease-out
    releaseMs: 180,          // release: critically damped spring (no overshoot)
    stateMs: 150,            // on/off crossfade of the disc fill and the glyph colour
    xFadeMs: 120,            // notification close/options buttons fade in/out on card hover
    stackMs: 300,            // notification stack expand / collapse (NC slide curve shape, no overshoot)
};

// Critically damped spring: displacement fraction left after t (in units of 1/omega). The curve
// is normalised so it ends exactly at 1 at SPRING_T (residual 0.5 % before normalising).
const SPRING_T = 7.5;
const springEnd = 1 - (1 + SPRING_T) * Math.exp(-SPRING_T);

export const MODES = {
    linear: p => p,
    easeOut: p => 1 - Math.pow(1 - p, 3),
    spring: p => {
        const t = p * SPRING_T;
        return Math.min(1, (1 - (1 + t) * Math.exp(-t)) / springEnd);
    },
};

// Test seam (rig only, null in a real session): when set, every Tween reports (label, value, kind)
// as it starts ('start') and as it applies each frame ('frame') so the rig can time a transition
// from the frame callbacks themselves instead of from painted frames.
export const probe = {fn: null};

export function animationsOn() {
    const settings = St.Settings.get();
    return settings.enable_animations && settings.reducedMotion !== St.ReducedMotion.REDUCE;
}

/* A number that animates to a target and reports every value to `apply`. Interruptible: a new
 * target starts from the current value (no jump). `actor` supplies the frame clock. */
export class Tween {
    constructor(actor, apply, initial = 0, label = '') {
        this._actor = actor;
        this._apply = apply;
        this._tl = null;
        this.label = label;
        this.value = initial;
    }

    _emit(value, kind, elapsed = 0) {
        probe.fn?.(this.label, value, kind, elapsed);
    }

    get running() {
        return this._tl !== null;
    }

    stop() {
        const tl = this._tl;
        if (!tl)
            return;
        this._tl = null;
        tl.stop();
        tl.disconnectObject(this);
    }

    set(value) {
        this.stop();
        this.value = value;
        this._emit(value, 'set');
        this._apply(value);
    }

    // mode: a name from MODES or a function p -> progress. onDone runs when the target is reached (also
    // when it is applied at once); an interrupted tween never calls it.
    to(target, ms, mode = 'easeOut', onDone = null) {
        const from = this.value;
        this.stop();
        if (target === from) {
            this._apply(target);
            onDone?.();
            return;
        }
        if (ms <= 0 || !animationsOn() || !this._actor.get_stage() || !this._actor.mapped) {
            this.set(target);
            onDone?.();
            return;
        }
        const f = typeof mode === 'function' ? mode : (MODES[mode] ?? MODES.linear);
        const tl = new Clutter.Timeline({duration: ms, actor: this._actor});
        this._tl = tl;
        this._emit(from, 'start');
        tl.connectObject('new-frame', () => {
            if (this._tl !== tl)
                return;
            const p = Math.min(1, tl.get_elapsed_time() / ms);
            this.value = p >= 1 ? target : from + (target - from) * f(p);
            this._emit(this.value, 'frame', tl.get_elapsed_time());
            this._apply(this.value);
            if (p >= 1) {
                this._tl = null;
                tl.stop();
                tl.disconnectObject(this);
                onDone?.();
            }
        }, this);
        tl.start();
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

/* The press response of one pressable shape: p goes 0 -> 1 on press (80 ms ease-out) and back to 0 on
 * release (180 ms critically damped spring). `apply(p)` does the visuals (scale, tint). */
export class PressResponse {
    constructor(actor, apply, label = 'press') {
        this.tween = new Tween(actor, apply, 0, label);
    }

    get p() {
        return this.tween.value;
    }

    press() {
        this.tween.to(1, FB.pressInMs, 'easeOut');
    }

    release() {
        this.tween.to(0, FB.releaseMs, 'spring');
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

/* Scale `actors` about their centres. */
export function setScale(actors, scale) {
    for (const actor of actors) {
        actor.scale_x = scale;
        actor.scale_y = scale;
    }
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

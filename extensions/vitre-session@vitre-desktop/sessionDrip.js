/* Shared plumbing for the two Vitre session surfaces (lock screen intro, end-session drip): a frame clock and a
 * "glass sheet" (the A17 glass field placed in an arbitrary parent). Adapted from vitre-menus@vitre-desktop
 * liquidDrip.js (DripController: wall-clock timeline, manual clock for the rig, parked field); dripField.js, glass.js
 * and dripMotion.js next to this file are byte-identical copies of the liquid-menus v1 files.
 *
 * Nothing here is allowed to take a surface down: every callback the owner passes in is wrapped by the caller, and
 * destroy() is safe to call twice or on a half-built object.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DripField} from './dripField.js';
import {MARGIN, BLUR_RADIUS} from './glass.js';

export {MARGIN, BLUR_RADIUS};

// Rig only: VITRE_MOTION_SLOW=8 plays the session drops 8 times slower, for filmstrips. Unset in a session.
export const SESSION_SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);
export const wallMs = () => GLib.get_monotonic_time() / 1000 / SESSION_SLOW;

// Fault injection for the rig only: VITRE_SESSION_FAULT=lock-build,es-frame,... makes the named point throw, so the
// tests can prove that every failure ends in GNOME's stock dialog. Unset in normal use: this is one getenv per call.
export function fault(point) {
    const spec = GLib.getenv('VITRE_SESSION_FAULT');
    if (spec && spec.split(',').includes(point))
        throw new Error(`injected fault: ${point}`);
}

// Animations on and no reduced motion. (The lock screen and the end-session dialog both want the motion on a locked
// or unlocked session alike, unlike the top-bar pop-outs of A17.)
export function motionAllowed() {
    const settings = St.Settings.get();
    return Boolean(settings.enable_animations) && settings.reducedMotion !== St.ReducedMotion.REDUCE;
}

/* A clock that calls `onFrame(ms)` once per stage frame with the wall-clock time since start(). A Clutter.Timeline
 * is only used to be woken at every frame (its own elapsed time counts from the frame clock's last timestamp, which
 * is stale after an idle period: the wall clock is read instead, as in liquidDrip.js). In manual mode (rig) nothing
 * runs by itself: advanceTo(ms) drives it. */
export class FrameClock {
    constructor(onFrame) {
        this._onFrame = onFrame;
        this._timeline = null;
        this._origin = 0;
        this._manual = false;
        this._now = 0;
        this.running = false;
    }

    setManual(on) {
        this._manual = on;
        if (on)
            this._stopTimeline();
    }

    get manual() {
        return this._manual;
    }

    now() {
        if (this._manual)
            return this._now;
        return this.running ? wallMs() - this._origin : 0;
    }

    start() {
        if (this.running)
            return;
        this.running = true;
        this._origin = wallMs();
        if (this._manual)
            return;                 // (the rig's clock keeps its own time across start/stop)
        this._now = 0;
        const tl = new Clutter.Timeline({duration: 3600000, actor: Main.uiGroup});
        this._timeline = tl;
        tl.connectObject('new-frame', () => this._onFrame(wallMs() - this._origin), this);
        tl.start();
    }

    stop() {
        this.running = false;
        this._stopTimeline();
    }

    advanceTo(ms) {
        this._now = ms;
        this._onFrame(ms);
    }

    _stopTimeline() {
        const tl = this._timeline;
        if (!tl)
            return;
        this._timeline = null;
        tl.disconnectObject(this);
        tl.stop();
    }
}

/* One piece of glass drawn by the A17 DripField (blurred backdrop clones cut and finished by one shader, up to
 * `shapes` rounded boxes in a smooth union), placed inside `parent` at a stage-coordinate box. `sources` replaces the
 * default backdrop (wallpaper + windows) with the given actors (the lock dialog's own blurred background). */
export class GlassSheet {
    constructor({parent, above = null, below = null, box, finish, blurRadius = BLUR_RADIUS, brightness, shapes = 5, sources = null,
        name = 'vitre-glass-sheet'}) {
        this._dead = false;
        this._inUse = false;
        this.parked = false;
        this._parent = parent;
        this.field = new DripField({shapes, finish, blurRadius, name});
        this.actor = this.field.actor;
        this.actor.connect('destroy', () => {
            this._dead = true;
        });
        this._sources = sources;
        if (sources) {
            // swap the clones' sources: the default ones are wallpaper and window group
            const clones = this.field._clones;
            clones.forEach((clone, i) => {
                if (!sources[i])
                    clone.visible = false;
                else
                    clone.set_source(sources[i]);
            });
            this.refreshSources();
        }
        if (brightness !== undefined)
            this.field._blur.brightness = brightness;
        if (above)
            parent.insert_child_above(this.actor, above);
        else if (below)
            parent.insert_child_below(this.actor, below);
        else
            parent.add_child(this.actor);
        this.box = {...box};
        this.setBox(box);
        this.actor.opacity = 0;
    }

    get dead() {
        return this._dead;
    }

    // A Clone is as big as its source's PREFERRED size, which is 0 x 0 for an empty widget sized by a constraint (the lock
    // screen's scrim): size every clone from its source's allocation (again whenever the sheet is taken into use).
    refreshSources() {
        if (this._dead || !this._sources)
            return;
        this.field._clones.forEach((clone, i) => {
            const src = this._sources[i];
            if (!src)
                return;
            const box = src.get_allocation_box();
            if (box.get_width() > 0 && box.get_height() > 0)
                clone.set_size(box.get_width(), box.get_height());
        });
        this.field._clonePos = [NaN, NaN];
    }

    // box: stage logical px, already including the blur margin
    setBox(box) {
        if (this._dead)
            return;
        this.box = {...box};
        const [px, py] = this._parent.get_transformed_position();
        const ox = Number.isFinite(px) ? px : 0;
        const oy = Number.isFinite(py) ? py : 0;
        this.actor.set_position(box.x - ox, box.y - oy);
        this.actor.set_size(box.w, box.h);
        this.field.setFieldSize(box.w, box.h);
        this.field.sync(box.x, box.y);
    }

    // shapes in stage px (centre, half sizes, radius)
    setShapes(shapes, k) {
        if (this._dead)
            return;
        const {x, y} = this.box;
        this.field.setShapes(shapes.map(s => ({x: s.x - x, y: s.y - y, w: s.w, h: s.h, r: s.r})), k);
    }

    setOpacity(alpha) {
        if (!this._dead)
            this.actor.opacity = Math.round(255 * Math.min(1, Math.max(0, alpha)));
    }

    // ---- prewarm / reuse: building the clones, effects and buffers and compiling the shader is the expensive part of a
    // first drip, so one sheet is built early, painted once off to the side, and parked (invisible) until it is needed
    warm() {
        if (this._dead)
            return;
        this.parked = false;
        this.actor.visible = true;
        this.setBox({x: 0, y: 0, w: 8, h: 8});
        this.actor.opacity = 1;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            if (!this._dead && !this._inUse)
                this.park();
            return GLib.SOURCE_REMOVE;
        });
    }

    park() {
        if (this._dead)
            return;
        this.parked = true;
        this.actor.visible = false;
        this.actor.opacity = 0;
    }

    // take a parked sheet into use at `box`
    use(box) {
        if (this._dead)
            return;
        this.parked = false;
        this._inUse = true;
        this.actor.visible = true;
        this.refreshSources();
        this.setBox(box);
        this.actor.opacity = 0;
    }

    release() {
        this._inUse = false;
    }

    // tint colour (0..1 rgb); DripField keeps it in plain uniforms
    setTintColor(r, g, b) {
        if (this._dead)
            return;
        this.field._set('u_tcr', r);
        this.field._set('u_tcg', g);
        this.field._set('u_tcb', b);
    }

    setCoverageDebug(on) {
        if (!this._dead)
            this.field.setDebugCoverage(on);
    }

    destroy() {
        if (this._dead)
            return;
        this._dead = true;
        try {
            this.field.destroy();
        } catch (_e) {
            // already gone with its parent
        }
    }
}

// A union box (stage px) around rectangles {x, y, w, h}, grown by pad + the blur margin
export function boxAround(rects, pad = 24) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w);
        y1 = Math.max(y1, r.y + r.h);
    }
    const g = pad + MARGIN;
    const fx = Math.floor(x0 - g);
    const fy = Math.floor(y0 - g);
    return {x: fx, y: fy, w: Math.ceil(x1 + g) - fx, h: Math.ceil(y1 + g) - fy};
}

// stage rect {x, y, w, h} of an actor (transformed), or null while it has no valid geometry yet
export function stageRect(actor) {
    if (!actor || !actor.mapped)
        return null;
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0)
        return null;
    return {x, y, w, h};
}

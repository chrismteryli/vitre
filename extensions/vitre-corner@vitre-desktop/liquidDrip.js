/* Liquid drip controller (plan A17): the glass field, the clock and the hand-over between the field (the
 * glass of the animation) and a surface's own glass and content. One controller per pop-out surface (Control
 * Center, Notification Center, the volume capsule, each top-bar menu). The surface supplies an adapter:
 *
 *   adapter.geometry(rest)          -> {pill: {x, y, w, h, keep}, pieces: [{id, x, y, w, h, r, row}]} in stage px,
 *                                      or null while the surface is not allocated yet
 *                                      (rest = true: the surface is open and settled, no waiting for an allocation)
 *   adapter.begin()                 take over: remember the rest state, show nothing of the surface's own glass/content
 *   adapter.setPiece(id, {real, content, clip})
 *                                   real 0..1: the surface's own glass of this piece; content 0..1 (clip is always
 *                                   null: the content is cut by the glass shape itself, see maskActor)
 *   adapter.maskActor()             the container that holds the surface's content: it gets the ContentMask effect
 *                                   (coverage of the field) while the drip runs, so nothing is drawn outside the glass
 *   adapter.maskBox()               optional: that container's rectangle {x, y, w, h} in stage px, for the frames in which it has no
 *                                   paint volume yet (a pending relayout); only a surface that knows it exactly provides it
 *   adapter.end()                   hand back: the rest state, exactly as remembered
 *   adapter.frame(fr, tau, phase)   optional: per-frame side effects of the surface (the volume HUD's top-bar pill)
 *   adapter.immediate               optional: geometry is known at open(), start without waiting for a frame
 *   adapter.finish                  glass finish of the field (GLASS_FINISH for the clear look)
 *   adapter.blurRadius, adapter.brightness   optional
 *   adapter.handoffMs               optional: the surface's own glass fades in over this long after the bloom
 *
 * The motion itself (shapes as a function of time, the constants table DRIP) is dripMotion.js. Nothing here
 * is measured from the reference; it is Vitre's own design. Time comes from a Clutter.Timeline, which is NOT
 * scaled by St's slow-down factor (Just Perfection sets 0.8), or, in the rig, from advanceTo().
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GlassField} from './glassField.js';
import {DripField, ContentMask} from './dripField.js';
import {MARGIN, GLASS_FINISH} from './glass.js';
import {DRIP, buildContext, frameAt, DripClock, handoffFade, clamp01} from './dripMotion.js';

export {DRIP};

const FIELD_BUCKETS = [12, 16, 24];   // shader sizes (shapes): Control Center has 15 modules + pill, thread and blob = 18 -> 24; Notification Center usually 12
const FIELD_PAD = 16;            // room around the union of the pill and the pieces for dilation and the overshoot
// Rig only: VITRE_MOTION_SLOW=8 plays every drip 8 times slower, for filmstrips. Unset in a session.
const ENV_SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);
const dripSlow = () => Math.max(1, Number(globalThis.__vitreMotionSlow) || ENV_SLOW);     // the rig can change it between filmed moments
// the glass while the drip moves (see _boost): light frosted, bright rim
const DRIP_LIT = {tint: 0.22, color: [0.93, 0.95, 1.0], rimSide: 0.45, rimTop: 1.0, rimBottom: 0.85, rimWidth: 2.6};
const GEOMETRY_TIMEOUT_MS = 500;       // a drip whose geometry stays invalid this long hands the surface back un-animated
const RETARGET_EVERY_MS = 40;          // while a surface opens, its rectangles are read again this often (a widget that loads late moves)
const RETARGET_FINAL_MS = 24;          // ... and in the last frames of the geometry they are followed exactly
const PREWARM_FIRST_MS = 3500;         // the first parked field is built this long after the first controller is created ...
const PREWARM_STEP_MS = 450;           // ... and every further controller waits this much longer than the one before (no login hitch)
let menuSlots = 0;                     // Control Center, Notification Center and the HUD have a fixed slot; every menu takes the next one

// Fields (and content masks) parked between drips are shared by the controllers that opt in (adapter.sharedField: the top-bar menus). One
// menu drips at a time (two while one switches to another), and every menu has the same look, so one parked field serves all of them
// instead of one per menu (each field is a compiled shader and offscreen buffers: ten menus were ten shaders and about 20 MB at login).
const SHARED_FIELDS = [];              // {field, bucket, look}
const SHARED_MASKS = [];               // ContentMask objects, any bucket
const SHARED_MAX = 2;
export function releaseSharedFields() {
    for (const e of SHARED_FIELDS.splice(0)) {
        try {
            if (!e.field._dead)
                e.field.destroy();
        } catch (_e) {
            // gone with the shell
        }
    }
    SHARED_MASKS.splice(0);
}

// The highlight of a top-bar button: the theme draws it as an inset box-shadow inside a transparent border,
// so its rectangle is the button's extents shrunk by the border width.
export function highlightRect(button) {
    const [x, y] = button.get_transformed_position();
    const [w, h] = button.get_transformed_size();
    let b = 0;
    try {
        b = button.get_theme_node().get_border_width(St.Side.TOP);
    } catch (_e) {
        b = 0;
    }
    return {x: x + b, y: y + b, w: w - 2 * b, h: h - 2 * b};
}

// A stage-coordinate rectangle as an actor clip; null removes the clip. The drip never sets a clip any more (the content is
// cut by the glass shape itself, see ContentMask); kept for the adapters' API. Never called on a destroyed actor.
export function clipActor(actor, rect) {
    if (!rect) {
        if (actor.has_clip)
            actor.remove_clip();
        return;
    }
    const [ax, ay] = actor.get_transformed_position();
    if (!Number.isFinite(ax) || !Number.isFinite(ay))
        return;
    actor.set_clip(rect.x - ax, rect.y - ay, Math.max(0, rect.w), Math.max(0, rect.h));
}

// An actor that may be destroyed under us (a tray app quits, a Quick Settings module is removed): remember its destruction
// with a destroy handler, because touching a disposed GObject only logs a warning (try / catch cannot guard it).
export class Lifetimes {
    constructor() {
        this._map = new Map();
    }

    // returns {alive} for an actor (null for null)
    watch(actor) {
        if (!actor)
            return null;
        let life = this._map.get(actor);
        if (!life) {
            life = {actor, alive: true, id: 0};
            try {
                life.id = actor.connect('destroy', () => {
                    life.alive = false;
                });
            } catch (_e) {
                life.alive = false;
            }
            this._map.set(actor, life);
        }
        return life;
    }

    alive(actor) {
        return actor ? this._map.get(actor)?.alive ?? true : false;
    }

    clear() {
        for (const life of this._map.values()) {
            if (life.alive && life.id) {
                try {
                    life.actor.disconnect(life.id);
                } catch (_e) {
                    // gone
                }
            }
        }
        this._map.clear();
    }
}

export const op255 = v => Math.round(255 * clamp01(v));

// Animations on, no reduced motion, and no lock screen / greeter (the shell hides pop-outs there and a drip would
// draw its glass over the lock screen's own chrome).
export function motionAllowed() {
    const settings = St.Settings.get();
    if (!settings.enable_animations || settings.reducedMotion === St.ReducedMotion.REDUCE)
        return false;
    return !(Main.sessionMode.isLocked || Main.sessionMode.isGreeter);
}

export class DripController {
    // prewarm: the number of field shapes whose shader to compile shortly after creation (0 = none); prewarmIf: only when true
    constructor(name, adapter, {prewarm = 0, prewarmIf = null} = {}) {
        this.name = name;
        this.adapter = adapter;
        this._prewarmId = 0;
        if (prewarm > 0) {
            const slot = name === 'cc' ? 0 : name === 'nc' ? 1 : name === 'hud' ? 2 : 3 + (menuSlots++ % 9);
            const delay = PREWARM_FIRST_MS + PREWARM_STEP_MS * slot;
            this._prewarmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, delay, () => {
                this._prewarmId = 0;
                try {
                    if (!prewarmIf || prewarmIf())      // nothing is built while drip-style is classic
                        this._prewarm(prewarm);
                } catch (_e) {
                    // not worth failing for
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        this.callbacks = {onOpened: null, onClosed: null};
        this._phase = 'closed';      // 'closed' | 'opening' | 'open' | 'closing'
        this._started = false;
        this._ctx = null;
        this._field = null;
        this._mask = null;
        this._maskBucket = 0;
        this._parked = null;
        this._fieldBox = null;
        this._clock = new DripClock(DRIP.openMs);
        this._timeline = null;
        this._origin = 0;
        this._manual = false;
        this._now = 0;
        this._pendingSince = 0;
        this._cap = 1;               // content cap: falls while closing, rises again on a reversal
        this._lastCapNow = 0;
        this._lastFrame = null;
        this._lastPieces = [];
        this._measure = null;
        this._log = null;
        this._destroyed = false;
        this._held = false;
        this._faults = 0;            // exceptions in a frame callback; the controller degrades to instant (never stuck)
        this._broken = false;
        this._hideId = 0;
        this._retargetAt = -1e9;
        this._speed = 1;
        this._stats = {frames: 0, openCalls: 0, closeCalls: 0, latencyMs: null};
        this._openCalledAt = 0;
    }

    get phase() {
        return this._phase;
    }

    get active() {
        return this._phase !== 'closed';
    }

    // true from the open call until the drip has handed back (a close in flight counts)
    get busy() {
        return this._phase === 'opening' || this._phase === 'closing';
    }

    get tau() {
        return this._clock.tau;
    }

    // ---- public ----------------------------------------------------------------------------------

    // speed: DRIP.switchOpenSpeed when this pop-out takes over from another one that is closing (its flags are FADE alone), else 1
    open(speed = 1) {
        if (this._destroyed)
            return;
        this._stats.openCalls++;
        this._speed = speed > 0 ? speed : 1;
        if (this._phase === 'opening' || this._phase === 'open')
            return;
        if (this._broken) {
            // a frame callback failed twice: the surface is handed over without animation from now on
            this._phase = 'open';
            this._guard(() => {
                this._begin();
                this._end();
            });
            this.callbacks.onOpened?.('instant');
            return;
        }
        if (this._phase === 'closing') {
            // reverse: continues from the current field state
            this._clock.open(this._nowMs(), this._speed);
            this._phase = 'opening';
            return;
        }
        this._openCalledAt = GLibMonotonicMs();
        if (this.adapter.canDrip && !this.adapter.canDrip()) {
            // the source pill is not on screen (panel hidden, indicator unmapped): nothing to drip from
            this._phase = 'opening';
            this._begin();
            this._abortPending();
            return;
        }
        this._phase = 'opening';
        this._started = false;
        this._pendingSince = this._nowMs();
        this._cap = 1;
        this._ctx = null;
        this._clock = new DripClock(DRIP.openMs);
        this._begin();
        this._startTimeline();
        this._lastCapNow = this._nowMs();
        // a surface whose geometry is known at once (the volume capsule) starts in this very frame
        if (this.adapter.immediate && this._tryStart(this._nowMs()))
            this._applyGuarded(0, this._nowMs());
    }

    // scale: DRIP.switchCloseScale when another top-bar pop-out is taking over
    close(scale = 1) {
        if (this._destroyed)
            return false;
        this._stats.closeCalls++;
        if (this._phase === 'closed' || this._phase === 'closing')
            return this._phase === 'closing';
        if (this._broken) {
            this._finishClose();
            return true;
        }
        if (this._phase === 'opening') {
            if (!this._started) {
                // never started: nothing of the surface was shown yet
                this._finishClose();
                return true;
            }
            this._clock.close(this._nowMs(), scale, this._contentNow());
            this._phase = 'closing';
            return true;
        }
        // 'open' (at rest): the field takes over from the surface's own glass at the final shapes
        const geometry = this.adapter.geometry(true);
        if (!geometry || !geometry.pieces?.length) {
            this._finishClose();
            return true;
        }
        this._ctx = buildContext(geometry, this._handoff());
        this._ensureField();
        this._clock = new DripClock(this._ctx.clockMs, this._ctx.warp);
        this._clock.tau = this._clock.totalMs;
        this._cap = 1;
        this._started = true;
        this._begin();
        this._startTimeline();
        this._lastCapNow = this._nowMs();
        this._clock.close(this._nowMs(), scale, 1);
        this._phase = 'closing';
        this._applyGuarded(this._clock.tau, this._nowMs());
        return true;
    }

    // abandon everything without animating (disable, unmap, animations off): hands the surface back at rest or closed
    reset() {
        this._stopTimeline();
        this._guard(() => this._destroyField());
        this._guard(() => this._end());
        this._phase = 'closed';
        this._started = false;
        this._ctx = null;
    }

    destroy() {
        this._releaseMask();
        if (this._prewarmId) {
            GLib.Source.remove(this._prewarmId);
            this._prewarmId = 0;
        }
        if (this._hideId) {
            GLib.Source.remove(this._hideId);
            this._hideId = 0;
        }
        this.reset();
        this._freeParked();
        this._destroyed = true;
    }

    // true once the geometry is known and the drip clock runs (rig)
    get started() {
        return this._started;
    }

    // an instant open (animations off, animate: false) leaves a settled surface: closing it later drips
    markOpen() {
        if (this._phase === 'closed' && !this._destroyed)
            this._phase = 'open';
    }

    // ---- rig seams -------------------------------------------------------------------------------------

    setManualClock(on) {
        this._manual = on;
        if (on)
            this._stopTimeline();
    }

    // manual clock: move to time `ms` (the same clock domain as open()/close() calls, which stamp `_now`)
    advanceTo(ms) {
        this._now = ms;
        this._tick(ms);
    }

    // coverage: field as bare white coverage, surface's own glass and content hidden; field: the field's glass
    // alone; content: field and glass hidden, content visible; null: normal
    setMeasure(mode) {
        this._measure = mode;
        if (this._field) {
            this._field.setDebugCoverage(mode === 'coverage');
            this._field.actor.visible = mode !== 'content';
            this._field.actor.opacity = mode === 'coverage' ? 255 : Math.round(255 * (this._lastFrame?.fieldAlpha ?? 1));
        }
        if (this._lastFrame)
            this._applyPieces(this._lastFrame, this._clock.tau, this._now);
    }

    setLog(on) {
        this._log = on ? [] : null;
    }

    get log() {
        return this._log;
    }

    snapshot() {
        const fr = this._lastFrame;
        const box = this._fieldBox;
        return {
            name: this.name, phase: this._phase, started: this._started, tau: this._clock.tau,
            mode: this._clock.mode, total: this._ctx?.totalMs ?? null, k: fr?.k ?? null,
            fieldAlpha: fr?.fieldAlpha ?? null, fieldOp: this._field?.actor.opacity ?? null,
            fieldVisible: this._field?.actor.visible ?? false,
            fieldBox: box ? {...box} : null, shapes: fr ? fr.shapes.map(s => ({...s})) : null,
            pieces: this._lastPieces, cap: this._cap, latencyMs: this._stats.latencyMs,
            frames: this._stats.frames, pill: this._ctx?.pill ?? null, pinched: fr?.pinched ?? false,
            closeMs: this._clock._closeMs ?? null, parked: Boolean(this._parked) || (this._shared() && SHARED_FIELDS.length > 0),
        };
    }

    // ---- clock ----------------------------------------------------------------------------------------

    // The drip clock is the monotonic wall clock read at every frame (a Clutter.Timeline only ticks us once per
    // frame): a Timeline's own elapsed time counts from the frame clock's last timestamp, which is stale when the
    // timeline starts out of an idle period (real input after a pause), and made the first frame skip ahead by the idle gap.
    _wallMs() {
        return GLib.get_monotonic_time() / 1000 / dripSlow();
    }

    _nowMs() {
        if (this._manual)
            return this._now;
        return this._timeline ? this._wallMs() - this._origin : 0;
    }

    _startTimeline() {
        if (this._manual || this._timeline)
            return;
        const tl = new Clutter.Timeline({duration: 3600000, actor: Main.uiGroup});
        this._timeline = tl;
        this._origin = this._wallMs();
        tl.connectObject('new-frame', () => this._tick(this._wallMs() - this._origin), this);
        tl.start();
    }

    _stopTimeline() {
        const tl = this._timeline;
        if (!tl)
            return;
        this._timeline = null;
        tl.disconnectObject(this);
        tl.stop();
    }

    _handoff() {
        return this.adapter.handoffMs ?? 0;
    }

    _tick(now) {
        if (this._phase === 'closed' || this._phase === 'open')
            return;
        this._now = now;
        if (this._started && !motionAllowed()) {
            // animations were switched off or the screen locked mid-drip: settle at once
            if (this._phase === 'opening')
                this._finishOpen();
            else if (this._phase === 'closing')
                this._finishClose();
            return;
        }
        if (!this._started) {
            if (!this._tryStart(now)) {
                if (now - this._pendingSince > GEOMETRY_TIMEOUT_MS)
                    this._abortPending();
                return;
            }
        }
        // The clock is advanced and its finish event consumed BEFORE the frame is applied, and the frame is applied under
        // a guard: whatever the surface's adapter does wrong in one frame, the drip still ends on time and the surface is
        // handed back (a stuck surface was the one way a fault here could outlive the fault).
        const u = this._clock.update(now);
        let failed = false;
        try {
            this._apply(u.tau, now);
        } catch (e) {
            failed = true;
            this._fault(e);
        }
        if (this._phase === 'closed' || this._phase === 'open')
            return;
        if (failed) {
            if (this._phase === 'opening')
                this._finishOpen();
            else
                this._finishClose();
        } else if (u.finished === 'open') {
            this._faults = 0;       // a drip that ran clean to its end: an earlier fault was a one-off
            this._finishOpen();
        } else if (u.finished === 'close') {
            this._faults = 0;
            this._finishClose();
        }
    }

    // a frame applied outside the tick: on a failure the drip ends at once and hands the surface back
    _applyGuarded(tau, now) {
        try {
            this._apply(tau, now);
        } catch (e) {
            this._fault(e);
            if (this._phase === 'opening')
                this._finishOpen();
            else if (this._phase === 'closing')
                this._finishClose();
        }
    }

    // one frame callback failed: say so (a failure also ends that drip at once); two failing drips in a row degrade the controller
    // to instant, so a permanent fault costs two log lines, never a stuck surface
    _fault(e) {
        this._faults++;
        console.error(`Liquid drip (${this.name}): frame failed (${this._faults}): ${e?.message ?? e}`);
        if (this._faults >= 2)
            this._broken = true;
    }

    _guard(fn) {
        try {
            fn();
        } catch (e) {
            console.error(`Liquid drip (${this.name}): ${e?.message ?? e}`);
        }
    }

    _tryStart(now) {
        const geometry = this.adapter.geometry();
        if (!geometry || !geometry.pieces?.length)
            return false;
        this._ctx = buildContext(geometry, this._handoff());
        this._ensureField();
        this._clock = new DripClock(this._ctx.clockMs, this._ctx.warp);
        this._clock.open(now, this._speed ?? 1);
        this._started = true;
        this._retargetAt = -1e9;
        this._stats.latencyMs = GLibMonotonicMs() - this._openCalledAt;
        return true;
    }

    _abortPending() {
        // the geometry never became valid: do not leave the surface invisible
        this._stopTimeline();
        this._guard(() => this._end());
        this._phase = 'open';
        this._started = false;
        this.callbacks.onOpened?.('aborted');
    }

    // ---- field -----------------------------------------------------------------------------------------

    // Build the field now and paint it once, off to the side (nothing of it is ever visible: it is empty), so
    // that the first real drip finds the shader compiled and the buffers allocated; then park it for reuse.
    _prewarm(n) {
        if (this._field || this._parked || this._destroyed)
            return;
        if (this._shared() && SHARED_FIELDS.length)
            return;         // another menu has built the field that all of them use
        const bucket = n <= 5 ? 5 : (FIELD_BUCKETS.find(b => b >= n) ?? 24);
        const finish = this.adapter.finish ?? GLASS_FINISH;
        const field = this._makeField(bucket, finish, this.adapter.blurRadius);
        field._bucket = bucket;
        field._look = JSON.stringify([finish, this.adapter.blurRadius, this.adapter.brightness]);
        field.actor.set_position(0, 0);
        field.actor.set_size(8, 8);
        field.setFieldSize(8, 8);
        field.sync(0, 0);
        field.actor.visible = true;
        field.actor.opacity = 1;
        this._park(field);
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._hideId = 0;
            if (!field._dead && !this._destroyed && !field._inUse) {
                field.actor.visible = false;
                field.actor.opacity = 0;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // the menus share their parked field and content mask (adapter.sharedField); every other surface keeps its own
    _shared() {
        return Boolean(this.adapter.sharedField);
    }

    // a parked field that fits (the bucket is large enough, the look is the same), or null
    _takeParked(bucket, look) {
        if (this._parked?._dead)
            this._parked = null;        // the stage took it down with it (shutdown)
        if (this._parked && this._parked._bucket >= bucket && this._parked._look === look) {
            const field = this._parked;
            this._parked = null;
            return field;
        }
        if (this._shared()) {
            for (let i = SHARED_FIELDS.length - 1; i >= 0; i--) {
                const e = SHARED_FIELDS[i];
                if (e.field._dead) {
                    SHARED_FIELDS.splice(i, 1);
                    continue;
                }
                if (e.look === look && e.bucket >= bucket) {
                    SHARED_FIELDS.splice(i, 1);
                    return e.field;
                }
            }
        }
        return null;
    }

    _park(field) {
        field._inUse = false;
        if (this._shared()) {
            SHARED_FIELDS.push({field, bucket: field._bucket, look: field._look});
            while (SHARED_FIELDS.length > SHARED_MAX) {
                const old = SHARED_FIELDS.shift();
                if (!old.field._dead)
                    old.field.destroy();
            }
            return;
        }
        this._freeParked();
        this._parked = field;
    }

    _makeField(bucket, finish, blurRadius) {
        // the byte-identical glassField.js serves the clear finishes with at most 5 shapes; a surface with a tinted /
        // saturated look (Liquid Glass menus) or more shapes uses DripField
        const plain = bucket === 5 && finish.tintColor === undefined && finish.saturation === undefined;
        const field = plain ? new GlassField({finish}) : new DripField({shapes: bucket, finish, name: `${this.name}-drip-field`});
        if (blurRadius !== undefined)
            field.setBlurRadius(blurRadius);
        if (this.adapter.brightness !== undefined && field._blur)
            field._blur.brightness = this.adapter.brightness;
        // the shell destroys uiGroup's children at shutdown: remember it instead of touching a disposed actor
        field.actor.connect('destroy', () => {
            field._dead = true;
        });
        const panelBox = Main.layoutManager.panelBox;
        if (panelBox && panelBox.get_parent() === Main.uiGroup)
            Main.uiGroup.insert_child_below(field.actor, panelBox);
        else
            Main.uiGroup.add_child(field.actor);
        return field;
    }

    _ensureField() {
        if (this._field)
            return;
        const ctx = this._ctx;
        const need0 = ctx.nShapes;
        const {pill, pieces} = ctx;
        let x0 = pill.x;
        let y0 = pill.y;
        let x1 = pill.x + pill.w;
        let y1 = pill.y + pill.h;
        for (const p of pieces) {
            x0 = Math.min(x0, p.x);
            y0 = Math.min(y0, p.y);
            x1 = Math.max(x1, p.x + p.w);
            y1 = Math.max(y1, p.y + p.h);
        }
        // B16: an adapter whose surface opens UPWARD (the Dock's menus) hands its geometry over mirrored (y' = A - y) so the
        // drip falls in that space; the field is placed and drawn back in the real one
        const A = this.adapter.flipAxis;
        if (Number.isFinite(A))
            [y0, y1] = [A - y1, A - y0];
        const pad = FIELD_PAD + MARGIN;
        const fx = Math.floor(x0 - pad);
        const fy = Math.floor(y0 - pad);
        const fw = Math.ceil(x1 + pad) - fx;
        const fh = Math.ceil(y1 + pad) - fy;
        const need = need0;
        const finish = this.adapter.finish ?? GLASS_FINISH;
        const blurRadius = this.adapter.blurRadius;
        const bucket = need <= 5 ? 5 : (FIELD_BUCKETS.find(b => b >= need) ?? FIELD_BUCKETS[FIELD_BUCKETS.length - 1]);
        // reuse the parked field when it is large enough and the look (finish, blur) is the same
        const look = JSON.stringify([finish, blurRadius, this.adapter.brightness]);
        let field = this._takeParked(bucket, look);
        if (field) {
            field.actor.visible = true;
            field._clonePos = [NaN, NaN];
            field.setTint?.(finish.tint);
            field._boostQ = null;          // the next frame sets the boost for its own time
        } else {
            this._freeParked();
            field = this._makeField(bucket, finish, blurRadius);
            field._bucket = bucket;
            field._look = look;
        }
        field._inUse = true;
        field.actor.set_position(fx, fy);
        field.actor.set_size(fw, fh);
        field.setFieldSize(fw, fh);
        field.sync(fx, fy);
        field.actor.opacity = 0;
        this._field = field;
        this._attachMask(bucket);
        this._fieldBox = {x: fx, y: fy, w: fw, h: fh};
        if (this._measure) {
            field.setDebugCoverage(this._measure === 'coverage');
            field.actor.visible = this._measure !== 'content';
        }
    }

    // The field is kept between runs (hidden): creating its clones, effects and offscreen buffers is the
    // expensive part of a drip, and nothing of it is visible while parked. `really` frees it.
    // the content mask: one effect object per controller (rebuilt when the shape bucket grows), attached to the
    // surface's content container for the length of a drip
    _attachMask(bucket) {
        const target = this.adapter.maskActor?.();
        if (!target)
            return;
        if (this._shared()) {
            // the menus take a mask from the shared ones for the length of one drip (gives it back in _destroyField)
            if (!this._mask) {
                const i = SHARED_MASKS.findIndex(m => m.nShapes >= bucket);
                this._mask = i >= 0 ? SHARED_MASKS.splice(i, 1)[0] : new ContentMask(bucket);
            }
        } else if (!this._mask || this._maskBucket < bucket) {
            this._mask?.detach();
            this._mask = new ContentMask(bucket);
            this._maskBucket = bucket;
        }
        this._mask.attach(target);
    }

    _releaseMask() {
        const mask = this._mask;
        if (!mask)
            return;
        mask.detach();
        if (this._shared()) {
            this._mask = null;
            if (SHARED_MASKS.length < SHARED_MAX)
                SHARED_MASKS.push(mask);
        }
    }

    _destroyField(really = false) {
        this._releaseMask();
        if (!this._field)
            return;
        if (this._field._dead) {
            this._field = null;
            this._fieldBox = null;
            return;
        }
        if (!really) {
            this._field.actor.visible = false;
            this._field.actor.opacity = 0;
            this._fieldBox = null;
            this._park(this._field);
            this._field = null;
            return;
        }
        this._field.destroy();
        this._field = null;
        this._fieldBox = null;
    }

    // the controller's own parked field (never the shared ones: they belong to every menu until releaseSharedFields)
    _freeParked() {
        if (this._parked) {
            if (!this._parked._dead)
                this._parked.destroy();
            this._parked = null;
        }
    }

    // ---- one frame -------------------------------------------------------------------------------------

    _contentNow() {
        let best = 0;
        for (const p of this._lastPieces)
            best = Math.max(best, p.content ?? 0);
        return best;
    }

    _apply(tau, now) {
        const ctx = this._ctx;
        if (!ctx)
            return;
        this._retarget(tau, now);
        const fr = frameAt(ctx, Math.min(tau, ctx.totalMs));
        fr.fieldAlpha *= handoffFade(ctx, tau);       // the hand-over tail: the field fades out as the surface's own glass fades in
        this._lastFrame = fr;
        // content cap: falls at 1 / contentOutMs while closing, recovers at the same rate on a reversal
        const dt = Math.max(0, now - this._lastCapNow);
        this._lastCapNow = now;
        if (this._phase === 'closing') {
            const scale = this._clock._contentOutMs ? this._clock._contentOutMs / DRIP.contentOutMs : 1;
            this._cap = Math.max(0, this._cap - dt / (DRIP.contentOutMs * scale));
        } else {
            this._cap = Math.min(1, this._cap + dt / DRIP.contentOutMs);
        }
        const field = this._field;
        if (field && !field._dead) {
            const bx = this._fieldBox.x;
            const by = this._fieldBox.y;
            const A = this.adapter.flipAxis;
            const flip = Number.isFinite(A);
            const shapes = fr.shapes.map(s => ({x: s.x - bx, y: (flip ? A - s.y : s.y) - by, w: s.w, h: s.h, r: s.r}));
            field.setShapes(shapes, fr.k);
            this._boost(field, fr.boost);
            field.actor.opacity = this._measure === 'coverage' ? 255 : Math.round(255 * fr.fieldAlpha);
        }
        this._mask?.update(fr.shapes, fr.k, this.adapter.maskBox?.());
        this._applyPieces(fr, tau, now);
        this.adapter.frame?.(fr, tau, this._phase);
        this._stats.frames++;
        if (this._log)
            this._log.push({now: Math.round(now * 10) / 10, tau: Math.round(tau * 10) / 10, phase: this._phase,
                k: fr.k, fieldAlpha: fr.fieldAlpha, shapes: fr.shapes.map(s => [s.x, s.y, s.w, s.h, s.r].map(v => Math.round(v * 100) / 100)),
                pieces: this._lastPieces.map(p => [p.id, p.real, p.content])});
    }

    // The drop's finish: tint and rim lifted by DRIP.dropBoost x b (b: 1 -> 0 after the pinch-off). A drop is small and its glass is
    // clear, so on a dark wall little more than a hairline of rim shows; the finished surface is not touched (b = 0 is the plain finish).
    _boost(field, b) {
        if (!field._set)
            return;
        const q = Math.round(clamp01(b) * 50) / 50;
        if (field._boostQ === q)
            return;
        field._boostQ = q;
        const f = this.adapter.finish ?? GLASS_FINISH;
        // B21 (2026-10-15): while it moves the glass is
        // LIT, as in the morph lab: a light frosted tint and a bright rim, easing into the surface's own finish as the bloom lands
        // (b falls to 0 by then), so the hand-over is unchanged. Multiplying a dark menu tint made the moving drop darker still:
        // on a dark wall only its outline showed, outline after outline, which read as stop-motion.
        const L = DRIP_LIT;
        const mix = (a, b) => a + (b - a) * q;
        field._set('u_tint', mix(f.tint, L.tint));
        if (f.tintColor) {
            field._set('u_tcr', mix(f.tintColor[0], L.color[0]));
            field._set('u_tcg', mix(f.tintColor[1], L.color[1]));
            field._set('u_tcb', mix(f.tintColor[2], L.color[2]));
        }
        field._set('u_rs', mix(f.rimSide, L.rimSide));
        field._set('u_rt', mix(f.rimTop, L.rimTop));
        field._set('u_rb', mix(f.rimBottom, L.rimBottom));
        field._set('u_rw', mix(f.rimWidth, L.rimWidth));
    }

    // The surface's rectangles can still move while it opens (the weather widget of the Notification Center loads late and shifts a few
    // px): read them again now and then and let the field's final rectangles follow, so that the field ends exactly on the real glass and
    // the hand-over has no step. Smoothed (half the distance per read) until the last frames of the geometry, which follow exactly.
    _retarget(tau, now) {
        const ctx = this._ctx;
        if (!ctx || this._phase !== 'opening' || tau < (ctx.retargetFrom ?? DRIP.pinchMs) || !this.adapter.geometry)
            return;
        const final = tau >= ctx.totalMs - RETARGET_FINAL_MS;
        if (!final && now - this._retargetAt < RETARGET_EVERY_MS)
            return;
        this._retargetAt = now;
        const g = this.adapter.geometry(true);
        if (!g || !g.pieces || g.pieces.length !== ctx.pieces.length)
            return;
        const byId = new Map(g.pieces.map(p => [p.id, p]));
        const step = final ? 1 : 0.5;
        for (const p of ctx.pieces) {
            const t = byId.get(p.id);
            if (!t || ![t.x, t.y, t.w, t.h, t.r].every(Number.isFinite) || t.w < 1 || t.h < 1)
                continue;
            for (const key of ['x', 'y', 'w', 'h', 'r']) {
                const d = t[key] - p[key];
                p[key] = Math.abs(d) < 0.05 ? t[key] : p[key] + d * step;
            }
        }
    }

    _applyPieces(fr, tau, now) {
        const ctx = this._ctx;
        const handoff = this._handoff();
        const out = [];
        for (let i = 0; i < ctx.pieces.length; i++) {
            const piece = ctx.pieces[i];
            const fp = fr.pieces[i];
            const doneTau = ctx.doneAt[i];
            // the surface's own glass: a pure function of tau, in both directions
            let real = handoff > 0 ? clamp01((tau - doneTau) / handoff) : (tau >= doneTau ? 1 : 0);
            let content = Math.min(fp.contentAlpha, this._cap);      // a function of tau (dripMotion.frameAt); the same ramp for every piece
            const clip = null;      // the content is cut by the ContentMask effect (the glass shape itself)
            if (this._measure === 'coverage' || this._measure === 'field') {
                real = 0;
                content = 0;
            } else if (this._measure === 'content') {
                real = 0;
            }
            // no mask to cut the content (the surface has no mask actor): a piece that has not left the drop shows none
            if (!this._mask && !fp.started)
                content = 0;
            out.push({id: piece.id, real, content, clip, solid: Boolean(piece.solid)});
            this.adapter.setPiece(piece.id, {real, content, clip});
        }
        this._lastPieces = out;
    }

    // ---- ends ------------------------------------------------------------------------------------------

    _begin() {
        if (this._held)
            return;
        this._held = true;
        this.adapter.begin();
    }

    _end() {
        if (!this._held)
            return;
        this._held = false;
        this.adapter.end();
    }

    _finishOpen() {
        this._stopTimeline();
        this._guard(() => this._destroyField());
        this._phase = 'open';
        this._guard(() => this._end());
        this.callbacks.onOpened?.('finished');
    }

    _finishClose() {
        this._stopTimeline();
        this._guard(() => this._destroyField());
        this._phase = 'closed';
        this._started = false;
        this._ctx = null;
        // hand the surface's own state back (rest) before the caller hides it, so the next open starts clean
        this._guard(() => this._end());
        this.callbacks.onClosed?.();
    }
}

function GLibMonotonicMs() {
    return Math.round(GLib.get_monotonic_time() / 1000);
}

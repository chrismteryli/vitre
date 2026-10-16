// Swipe Depth (plan A20, concept 3 "Depth and parallax", picked by 2026-10-12).
//
// The three-finger swipe up into the overview (and the swipe down out of it). The finger only drives ONE number, the
// overview state value of GNOME's OverviewAdjustment (0 desktop, 1 window picker); everything else here is derived from it
// (plans/a20-concepts/depth-src/model.cjs is the authored model, plans/a20-concepts/depth.html its rendering):
//   - the finger -> progress map: a dead zone, then linear (makeRemap in motion.js), only for gestures;
//   - the release: a critically damped spring that carries the finger's position and speed (the same family as
//     gesture-history v2 / A5; its estimator and spring are copied into motion.js); cancel glides back the same way;
//   - the wallpaper: a full-screen copy of the wallpaper behind the overview that recedes (zoom), drifts in two layers (the second is
//     a soft light bitmap),
//     blurs and dims (the stock workspace "card" is hidden while depth is on, so the wallpaper does not shrink);
//   - the Spaces strip: a 40 px glass bar at the top that fades in; the window rows start 24 px below it;
//   - the windows rise as they spread and land with one small overshoot;
//   - the Vitre Stage piles fan open (additive transform on Stage's rail actors).
// style = stock (gsettings) turns every one of these off again; the overview is then GNOME's own.
// Everything is installed with guarded overrides and restored in disable().
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwipeTrackerModule from 'resource:///org/gnome/shell/ui/swipeTracker.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as WorkspaceModule from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WindowPreviewModule from 'resource:///org/gnome/shell/ui/windowPreview.js';
import Graphene from 'gi://Graphene';

import {
    clamp, smooth, lerp, makeRemap, slopeOf, estimateReleaseVelocity, planRelease, springProgress, lagged, bump,
    shadowRebound, stepFollower,
} from './motion.js';

// =================================================================================================================
// THE CONSTANTS TABLE. Every number that shapes the motion lives here (lengths in logical px unless said otherwise;
// "concept px" are px of the 1280x800 concept and are scaled by monitor width / designWidth).
// =================================================================================================================
const TUNE = {
    // --- finger -> overview progress (gestures only) ------------------------------------------------------------
    deadZone: 0.20,          // fraction of the finger's travel (tracker progress 0..1) that moves nothing (concept 0.24, reference clip ~0.25)
    trackEnd: 1.00,          // overview progress reached at finger progress 1. Concept/reference: 0.53 at the end of the finger's travel,
                             // the release then carries on; 0.56 here would match that but a held swipe would never open fully
    // --- release (critically damped spring, same constants as gesture-history v2 / A5) ------------------------------
    omegaRef: 0.025,         // 1/ms at slow-down 1.0
    cStiff: 2.35,            // stiffness per unit of v0/|e0| (fast flicks never overshoot the target)
    // --- landing ------------------------------------------------------------------------------------------------
    overshoot: 0.010,        // window scale pop on landing: 1.010 once (not in depth.html; asked for in the brief)
    popDelayMs: 100,         // pop starts this long after the release ...
    popTauMs: 90,            // ... peaks at delay + tau and is gone (< 0.1 %) well inside 550 ms
    shadowRebound: 0.12,     // concept SD: window shadow x(1 + 0.12 sd) over 100..620 ms after the release
    // --- wallpaper (W = overview progress lagged by wallLagMs) -----------------------------------------------------
    wallLagMs: 40,
    wallZoom: 0.03,          // wallpaper scale 1 -> 1.03 (B8: was 1.02)
    wallDim: 0.26,           // black-blue overlay, 26 % at W = 1 (concept #000414; B8: 12 % read as "plain" on the real screen)
    wallBlurPx: 8,           // Shell.BlurEffect radius of the blurred wallpaper copy (logical px; B8 tried 16: frames of 20-63 ms in his live swipes)
    wallBlurMix: 0.85,       // opacity of the blurred copy at W = 1 (concept .85)
    vignette: 1.0,           // vignette strength (concept: W^2, radial rgba(4,10,40,.25) at the corners)
    vignetteAlpha: 0.25,
    parallax: {
        // concept px at 1280 wide: the wallpaper itself drifts up-left and zooms a little, the light layer drifts down-right
        wallpaper: {x: -8, y: -5, scale: 0.012},
        glow: {x: 6, y: 4},
    },
    glowAlpha: 0.55,         // multiplier of the concept's two light blobs (.28 and .30)
    designWidth: 1280,
    // --- window lift (R) ------------------------------------------------------------------------------------------
    liftScale: 0.03,         // window scale 1 + 0.03 R
    liftRest: 0.42,          // R once landed (concept R_REST): windows stay 1.26 % larger
    liftRise: 0.32,          // finger travel over which R rises 0 -> 1, starting where the dead zone ends (concept .08 .. .40)
    liftLagMs: 30,
    carryMs: 80,             // a new gesture that grabs a landing in flight: the lift difference it finds fades out over this long (no jump)
    // --- Spaces strip ---------------------------------------------------------------------------------------------
    stripHeight: 40,         // glass bar at the top of the monitor
    rowsBelowStrip: 24,      // the window rows start this far below the strip
    previewIcon: false,      // GNOME's app icon over the bottom edge of each window preview
    stripGlassSlope: 1.4,    // glass opacity = min(1, slope * P)
    stripContentFrom: 0.25,  // thumbnails / label fade in from this progress ...
    stripContentSlope: 1.4,  // ... with this slope
    panelFadeSlope: 2.2,     // GNOME's top bar fades out with this slope (menu opacity = 1 - 2.2 P)
    // --- Vitre Stage piles (G follower and fan) ----------------------------------------------------------------
    fanOmega: 23,            // rad/s of the second-order follower (concept G_WN)
    fanZeta: 0.5,            // its damping (concept G_ZETA): one small rebound
    fanTiltDeg: 32,          // the rail's resting tilt of a pile (Stage's own look, concept rotateY 32)
    fanRelaxDeg: 12,         // the fan opens the tilt by this many degrees at g = 1 (concept 32 -> 20)
    fanOffsetPx: 6,          // concept px each layer moves further out (13 -> 19): needs the Stage hook, see the report
    fanLiftPx: 3,            // concept px each layer rises further (8 -> 11): needs the Stage hook
    fanRollDeg: 2,           // layer k rolls by -k * 2 g degrees: needs the Stage hook
    // --- reduced motion (Settings animations off) -----------------------------------------------------------------
    reducedFadeMs: 120,
    // --- hover -------------------------------------------------------------------------------------------------------
    hover: false,            // false = the pointer over a window shows no title pill, close button or grow (hover removed, brief);
                             // long press and keyboard focus still show them
};

const IDLE_GAP_MS = 50;      // a gap between two ticks longer than this is the overview resting (nothing was painted), not a slow frame
const POP_END_TAUS = 12;     // the landing pop (x e^(1-x), x = t / tau) is below 0.0002 after this many tau
const MAX_DT_MS = 100;       // the longest step the follower integrates for one tick
const HIDDEN = 0;
const PICKER = 1;
const GRID = 2;
const LIQUID_UUID = 'vitre-menus@vitre-desktop';
const STAGE_UUID = 'vitre-stage@vitre-desktop';
const LOG_TAG = '[swipe-depth]';
const warned = new Set();

function warnOnce(key, message) {
    if (warned.has(key))
        return;
    warned.add(key);
    console.warn(`${LOG_TAG} ${message}`);
}

// Idle means idle. A Clutter setter queue_redraw()s even when it is handed the value the actor already has, and the tick runs in the
// stage's before-update: a redundant write there schedules the next frame, whose tick writes again, and the compositor repaints at
// 120 Hz for as long as the overview is open, nothing moving (42-46 % GPU, 14-22 % of a CPU core, vlook2/out/idle). So every per-tick
// write of a transform goes through these: it happens only when the LIVE value differs (not "when the model changed": GNOME resets
// some of these properties itself, e.g. the workspace card, and the next tick has to put ours back). The tolerances are far below a
// pixel and above the float32 rounding of the property read-back.
const nearScale = (a, b) => Math.abs(a - b) < 1e-5;
const nearPx = (a, b) => Math.abs(a - b) < 1e-3;
const setScaleIf = (a, x, y) => {
    if (!nearScale(a.scale_x, x) || !nearScale(a.scale_y, y))
        a.set_scale(x, y);
};
const setTransIf = (a, x, y, z = 0) => {
    if (!nearPx(a.translation_x, x) || !nearPx(a.translation_y, y) || !nearPx(a.translation_z, z))
        a.set_translation(x, y, z);
};
const setPosIf = (a, x, y) => {
    if (!nearPx(a.x, x) || !nearPx(a.y, y))
        a.set_position(x, y);
};

const nowMs = () => GLib.get_monotonic_time() / 1000;

// teardown can run after GNOME Shell already destroyed our actors (session shutdown): never throw from it
function safe(fn) {
    try {
        fn();
    } catch (_e) { /* already disposed */ }
}
const slowDown = () => St.Settings.get().slow_down_factor;
const animationsOn = () => St.Settings.get().enable_animations;

// the one live engine (set while the extension is enabled); the hooks below ask it
let engine = null;
// the release being handled inside SwipeTracker._endGesture (null at all other times)
let pendingRelease = null;

// -- release transition (same device as gesture-history v2: a PropertyTransition whose value follows the spring) -------------
let ReleaseTransition = null;

function getReleaseTransition() {
    if (ReleaseTransition)
        return ReleaseTransition;
    ReleaseTransition = GObject.registerClass(
    class SwipeDepthReleaseTransition extends Clutter.PropertyTransition {
        vfunc_compute_value(animatable, interval, progress) {
            const plan = this._plan;
            let p = progress;
            if (plan) {
                try {
                    p = springProgress(progress * plan.T, plan.e0, plan.v0, plan.w, plan.T);
                    if (progress >= 1 || !Number.isFinite(p))
                        p = 1;
                } catch (e) {
                    warnOnce('compute', `spring failed (${e.message}); using the stock curve`);
                    p = 1 - Math.pow(1 - progress, 3);
                }
            }
            super.vfunc_compute_value(animatable, interval, p);
        }
    });
    return ReleaseTransition;
}

// =================================================================================================================
// Soft layers as small bitmaps. The light blobs and the corner shade are smooth gradients with no detail, so each is computed ONCE
// into a 384 x 240 bitmap and shown stretched over the monitor (bilinear). A St.DrawingArea / a CSS gradient re-rasterised a
// full-screen cairo surface every time it was shown: ~100 ms before the first frame of EVERY overview, plus a ~175 ms one-off hitch
// at the first paint of the shade (rig profile, rig/work/a20b/results-p2).
// =================================================================================================================

const SOFT_W = 384;
const SOFT_H = 240;
let softCache = null;

// the concept's CSS: radial-gradient(RXw RYh at CX CY, rgba(color, alpha), transparent STOP)
function blobAlpha(u, v, b) {
    const t = Math.hypot((u - b.cx) / b.rx, (v - b.cy) / b.ry);
    return t >= b.stop ? 0 : b.alpha * (1 - t / b.stop);
}

function makeSoftContent(pixel) {
    const data = new Uint8Array(SOFT_W * SOFT_H * 4);
    const out = [0, 0, 0, 0];
    let o = 0;
    for (let y = 0; y < SOFT_H; y++) {
        const v = (y + 0.5) / SOFT_H;
        for (let x = 0; x < SOFT_W; x++) {
            pixel((x + 0.5) / SOFT_W, v, out);        // premultiplied r, g, b, a in 0..1
            data[o++] = Math.round(out[0] * 255);
            data[o++] = Math.round(out[1] * 255);
            data[o++] = Math.round(out[2] * 255);
            data[o++] = Math.round(out[3] * 255);
        }
    }
    const content = St.ImageContent.new_with_preferred_size(SOFT_W, SOFT_H);
    content.set_bytes(global.stage.context.get_backend().get_cogl_context(), new GLib.Bytes(data),
        Cogl.PixelFormat.RGBA_8888_PRE, SOFT_W, SOFT_H, SOFT_W * 4);
    return content;
}

function softContents(tune) {
    if (softCache)
        return softCache;
    const k = tune.glowAlpha;
    // listed top first, like the concept's background-image
    const blobs = [
        {cx: 0.46, cy: 0.58, rx: 0.34, ry: 0.30, stop: 0.7, alpha: 0.28 * k, rgb: [120, 190, 255]},
        {cx: 0.86, cy: 0.74, rx: 0.22, ry: 0.26, stop: 0.7, alpha: 0.30 * k, rgb: [130, 110, 255]},
    ];
    const glow = makeSoftContent((u, v, out) => {
        out[0] = out[1] = out[2] = out[3] = 0;
        for (let i = blobs.length - 1; i >= 0; i--) {            // paint bottom to top
            const b = blobs[i];
            const a = blobAlpha(u, v, b);
            if (a <= 0)
                continue;
            const keep = 1 - a;
            out[0] = out[0] * keep + a * b.rgb[0] / 255;
            out[1] = out[1] * keep + a * b.rgb[1] / 255;
            out[2] = out[2] * keep + a * b.rgb[2] / 255;
            out[3] = out[3] * keep + a;
        }
    });
    // radial-gradient(120% 110% at 50% 48%, transparent 52%, rgba(4,10,40,alpha) 100%)
    const va = tune.vignetteAlpha;
    const shade = makeSoftContent((u, v, out) => {
        const t = Math.hypot((u - 0.5) / 1.2, (v - 0.48) / 1.1);
        const a = va * clamp((t - 0.52) / 0.48);
        out[0] = a * 4 / 255;
        out[1] = a * 10 / 255;
        out[2] = a * 40 / 255;
        out[3] = a;
    });
    softCache = {glow, shade};
    return softCache;
}

// =================================================================================================================
// Wallpaper layers
// =================================================================================================================

class Backdrop {
    constructor(tune) {
        this._tune = tune;
        this.actor = new Clutter.Actor({
            name: 'swipeDepthBackdrop', reactive: false, visible: false, clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });
        Shell.util_set_hidden_from_pick(this.actor, true);
        this._monitorIndex = -1;
        this._built = false;
        this._size = [0, 0];
    }

    _group() {
        return new Meta.BackgroundGroup({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
    }

    _build(monitorIndex) {
        this._destroyLayers();
        const fill = {x_expand: true, y_expand: true, reactive: false};
        const makeWall = blur => {
            const group = this._group();
            const manager = new Background.BackgroundManager({
                container: group, monitorIndex, controlPosition: false, useContentSize: false,
            });
            group.set_pivot_point(0.5, 0.5);
            if (blur) {
                group.add_effect_with_name('swipe-depth-blur',
                    new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: this._tune.wallBlurPx, brightness: 1.0}));
            }
            return {group, manager};
        };
        // zoom scales both wallpaper copies and the light layer together
        this.zoom = new Clutter.Actor({name: 'swipeDepthZoom', layout_manager: new Clutter.BinLayout(), ...fill});
        this.zoom.set_pivot_point(0.5, 0.5);
        this.sharp = makeWall(false);
        this.blurred = makeWall(true);
        this.blurred.group.opacity = 0;
        const soft = softContents(this._tune);
        const bitmap = (name, content) => new Clutter.Actor({
            name, opacity: 0, content, content_gravity: Clutter.ContentGravity.RESIZE_FILL, ...fill,
        });
        this.glow = bitmap('swipeDepthGlow', soft.glow);
        this.zoom.add_child(this.sharp.group);
        this.zoom.add_child(this.blurred.group);
        this.zoom.add_child(this.glow);
        this.actor.add_child(this.zoom);
        this.dim = new St.Widget({name: 'swipeDepthDim', opacity: 0, style: 'background-color: #000414;', ...fill});
        this.actor.add_child(this.dim);
        this.vignette = bitmap('swipeDepthVignette', soft.shade);
        this.actor.add_child(this.vignette);
        this._monitorIndex = monitorIndex;
        this._built = true;
    }

    // size and place it on the monitor (rebuilds the wallpaper layers when the monitor changed)
    layout(monitor) {
        if (!this._built || this._monitorIndex !== monitor.index)
            this._build(monitor.index);
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, monitor.height);
        this._size = [monitor.width, monitor.height];
        this.scale = monitor.width / this._tune.designWidth;
    }

    // W 0..1: how far the wallpaper has receded
    apply(W, motion) {
        if (!this._built)
            return;
        const t = this._tune;
        const k = this.scale;
        const zoom = motion ? 1 + t.wallZoom * W : 1;
        setScaleIf(this.zoom, zoom, zoom);
        const pw = t.parallax.wallpaper;
        const gx = motion ? pw.x * k * W : 0;
        const gy = motion ? pw.y * k * W : 0;
        const gs = motion ? 1 + pw.scale * W : 1;
        for (const layer of [this.sharp.group, this.blurred.group]) {
            setTransIf(layer, gx, gy, 0);
            setScaleIf(layer, gs, gs);
        }
        setTransIf(this.glow, motion ? t.parallax.glow.x * k * W : 0, motion ? t.parallax.glow.y * k * W : 0, 0);
        // Never below 1/255 while the overview is up: an actor at opacity 0 is not painted, so the blur effect's offscreen buffer, the
        // glass shader and the other layers would all be set up on the first frame their opacity leaves 0, i.e. right at the end of
        // the dead zone (25-60 ms stalls, vlook/out/gpu8-depth-*). At 1/255 they are painted from the first frame of the overview, while
        // nothing moves yet, and the result is not visible.
        this.blurred.group.opacity = Math.max(1, Math.round(255 * t.wallBlurMix * W));
        this.glow.opacity = Math.max(1, Math.round(255 * W));
        this.dim.opacity = Math.max(1, Math.round(255 * t.wallDim * W));
        this.vignette.opacity = Math.max(1, Math.round(255 * t.vignette * (motion ? W * W : W)));
    }

    reset() {
        if (!this._built)
            return;
        this.apply(0, false);
    }

    destroy() {
        this._destroyLayers();
        safe(() => this.actor.destroy());
    }

    _destroyLayers() {
        if (!this._built)
            return;
        safe(() => this.sharp.manager.destroy());
        safe(() => this.blurred.manager.destroy());
        for (const a of [this.zoom, this.dim, this.vignette])
            safe(() => a.destroy());
        this._built = false;
    }
}

// =================================================================================================================
// The Spaces strip: a thin glass bar at the top (GlassField from liquid-menus when it is installed, a plain translucent
// bar otherwise); GNOME's own workspace thumbnails are moved into it by the layout hook.
// =================================================================================================================

class Strip {
    constructor(tune) {
        this._tune = tune;
        this.actor = new Clutter.Actor({name: 'swipeDepthStrip', reactive: false, visible: false});
        Shell.util_set_hidden_from_pick(this.actor, true);
        this._glass = null;
        this._glassKind = 'none';
        this._plain = new St.Widget({
            name: 'swipeDepthStripPlain', reactive: false,
            style: 'background-color: rgba(255,255,255,0.14); border-bottom: 1px solid rgba(255,255,255,0.22); ' +
                   'box-shadow: 0 8px 24px rgba(0,10,50,0.25);',
        });
        this.actor.add_child(this._plain);
        // the concept's glass finish on top of the blur: a light vertical gradient, a hairline and a soft shadow below
        this._tint = new St.Widget({
            name: 'swipeDepthStripTint', reactive: false,
            style: 'background-gradient-direction: vertical; background-gradient-start: rgba(255,255,255,0.20); ' +
                   'background-gradient-end: rgba(255,255,255,0.08); border-bottom: 1px solid rgba(255,255,255,0.24); ' +
                   'box-shadow: 0 8px 24px rgba(0,10,50,0.25);',
        });
        this.actor.add_child(this._tint);
        this.label = new St.Label({
            name: 'swipeDepthStripLabel', reactive: false, opacity: 0,
            style: 'color: rgba(255,255,255,0.9); font-weight: 600; font-size: 13px;',
        });
        this.actor.add_child(this.label);
        // the current desktop as a small card (a scaled copy of the wallpaper layers) next to its name, like the concept; only
        // shown when GNOME's own workspace thumbnails are not (one workspace)
        this._card = new St.Bin({
            name: 'swipeDepthStripCard', reactive: false, opacity: 0,
            style: 'border: 1.5px solid rgba(255,255,255,0.85); border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.35);',
        });
        this.actor.add_child(this._card);
        this._cardClone = null;
        this._monitor = null;
        this._height = 0;
    }

    setCardSource(backdropActor) {
        if (this._cardClone)
            return;
        this._cardClone = new Clutter.Clone({source: backdropActor});
        this._card.set_child(this._cardClone);
    }

    // called once the glass helper module has been imported
    setGlassModule(mod, backdropActor) {
        if (this._glass || !mod?.GlassField)
            return;
        try {
            const field = new mod.GlassField({});
            // the field blurs OUR wallpaper (zoomed, dimmed), not the desktop that the overview hides
            for (const clone of field._clones ?? [])
                clone.destroy();
            field._clones = [];
            const clone = new Clutter.Clone({source: backdropActor});
            field.actor.add_child(clone);
            field._clones.push(clone);
            this._glass = field;
            this._glassKind = 'GlassField';
            this.actor.insert_child_below(field.actor, this.label);
            this._plain.hide();
            this._fieldOffset = null;
        } catch (e) {
            warnOnce('glass', `glass helper unavailable (${e.message}); using a plain translucent bar`);
        }
    }

    get glassKind() {
        return this._glassKind;
    }

    layout(monitor) {
        this._monitor = monitor;
        this._cardKey = null;
        this._shapeKey = null;
        this._plainKey = null;
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, this._tune.stripHeight);
        if (this._glass) {
            const M = 40;                 // GlassField MARGIN
            const over = 60;              // the bar extends past the screen edges so the rim only shows along its bottom
            const fw = monitor.width + 2 * over + 2 * M;
            const fh = this._tune.stripHeight + over + 2 * M;
            this._glass.actor.set_size(fw, fh);
            this._glass.actor.set_position(-over - M, -over - M);
            this._glass.setFieldSize(fw, fh);
            this._glass.sync(monitor.x - over - M, monitor.y - over - M);
            this._fieldGeom = {over, M, fw, fh};
        }
        this._tint.set_position(0, 0);
        this._tint.set_size(monitor.width, this._tune.stripHeight);
        this.label.set_position(0, 0);
    }

    // glassOpacity / contentOpacity 0..1, height in px (grows from the top bar's height to the strip height)
    apply(height, glassOpacity, contentOpacity, text) {
        const m = this._monitor;
        if (!m)
            return;
        this._height = height;
        this.actor.opacity = Math.max(1, Math.round(255 * glassOpacity));       // 1/255 at least: painted (and set up) from the first frame, see Backdrop.apply
        if (this._glass && this._fieldGeom) {
            const {over, M, fw, fh} = this._fieldGeom;
            const sw = m.width + 2 * over, sh = over + height;
            const key = `${sw}|${sh}`;
            if (this._shapeKey !== key) {
                this._shapeKey = key;
                this._glass.setShapes([{x: M + sw / 2, y: M + sh / 2, w: sw / 2, h: sh / 2, r: 0}], 3);
            }
            void fw;
            void fh;
        } else {
            const key = `${m.width}|${Math.round(height)}`;
            if (this._plainKey !== key) {
                this._plainKey = key;
                this._plain.set_position(0, 0);
                this._plain.set_size(m.width, Math.round(height));
            }
        }
        if (text !== undefined && this.label.text !== text)
            this.label.text = text;
        const [lw, lh] = this.label.get_size();
        const cardH = Math.max(16, Math.round(Math.min(30, height - 10)));
        const cardW = Math.round(cardH * 1.6);
        const gap = 9;
        const x0 = Math.round((m.width - (cardW + gap + lw)) / 2);
        const ck = `${cardW}|${cardH}|${x0}|${height}|${lw}|${lh}`;
        if (this._cardKey !== ck) {
            this._cardKey = ck;
            this._card.set_size(cardW, cardH);
            this._card.set_position(x0, Math.round((height - cardH) / 2));
            this._cardClone?.set_size(cardW - 3, cardH - 3);
            this.label.set_position(x0 + cardW + gap, Math.round((height - lh) / 2));
        }
        this.label.opacity = Math.round(255 * contentOpacity);
        this._card.opacity = Math.round(255 * contentOpacity);
    }

    destroy() {
        safe(() => this._glass?.destroy());
        this._glass = null;
        safe(() => this.actor.destroy());
    }
}

// =================================================================================================================
// Window shadows that deepen as the windows rise. One soft shadow actor per window preview, a single bitmap computed ONCE (shared by
// every actor, kept across overviews) and scaled to the preview (no per-frame CSS), placed in a layer below the previews.
// A St box-shadow (CSS) was rasterised on the CPU for every window at its first paint: a 91 px blur at 700 x 440 each, which landed on
// the first frame after the dead zone (25-60 ms stall on every swipe, vlook/out/gpu8-depth-*). The bitmap costs one upload.
// =================================================================================================================

// A zero-size layer that FILLS its workspace: with no preferred size it neither widens the workspace (a plain actor with size 0 x 0
// did not either, but BinLayout then centred it: every shadow was displaced by half the workspace, +912/+517 px on a 1824 x 1035 one)
const ShadowLayer = GObject.registerClass(
class SwipeDepthShadowLayer extends Clutter.Actor {
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }
});

const SHADOW_REF = {w: 700, h: 440};
const SHADOW_BMP = 0.25;            // bitmap px per logical px (the shadow is a smooth gradient: bilinear stretching is exact enough)
const shadowCache = new Map();      // scale key -> {content, mx, my}

// Abramowitz and Stegun 7.1.26 (|error| < 1.5e-7)
function erf(x) {
    const a = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * a);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
    return x < 0 ? -y : y;
}

// The concept's shadow at its strongest (y 34, blur 61 px at 1280 wide), as St drew it with box-shadow: 0 y blur rgba(0,0,10,0.60)
// (measured in the rig, scenario shadowcal): a Gaussian of sigma 0.6 x blur around a box that is 0.3 x blur larger than the widget on
// every side, peak alpha 0.58. Drawn as the product of two 1-D Gaussian-blurred box profiles (the box's corner radius is far below the
// blur and is left out). Premultiplied (0,0,10) colour on the box SHADOW_REF.w x SHADOW_REF.h shifted down by the offset, with a
// margin on every side that holds the whole blur and the offset: the actor that shows it is (w + 2 mx) x (h + 2 my), centred on the window.
function shadowContent(k) {
    const key = Math.round(k * 100);
    const cached = shadowCache.get(key);
    if (cached)
        return cached;
    const blur = Math.round(61 * k), dy = Math.round(34 * k), A = 0.58;
    const sigma = 0.6 * blur, grow = 0.3 * blur;
    const margin = Math.ceil(3 * sigma + dy + grow);
    const s = SHADOW_BMP;
    const wb = Math.ceil((SHADOW_REF.w + 2 * margin) * s), hb = Math.ceil((SHADOW_REF.h + 2 * margin) * s);
    const mx = (wb / s - SHADOW_REF.w) / 2, my = (hb / s - SHADOW_REF.h) / 2;
    const prof = (n, margin2, len, shift) => {
        const out = new Float64Array(n);
        const d = sigma * Math.SQRT2;
        for (let i = 0; i < n; i++) {
            const u = (i + 0.5) / s - margin2 - shift;
            out[i] = 0.5 * (erf(u / d) - erf((u - len) / d));
        }
        return out;
    };
    const fx = prof(wb, mx, SHADOW_REF.w + 2 * grow, -grow), fy = prof(hb, my, SHADOW_REF.h + 2 * grow, dy - grow);
    const data = new Uint8Array(wb * hb * 4);
    let o = 0;
    for (let y = 0; y < hb; y++) {
        for (let x = 0; x < wb; x++) {
            const a = A * fx[x] * fy[y];
            data[o++] = 0;
            data[o++] = 0;
            data[o++] = Math.round(a * 10);                 // 10/255 of the colour, premultiplied: a * 10 on the 0..255 scale
            data[o++] = Math.round(a * 255);
        }
    }
    const content = St.ImageContent.new_with_preferred_size(wb, hb);
    content.set_bytes(global.stage.context.get_backend().get_cogl_context(), new GLib.Bytes(data),
        Cogl.PixelFormat.RGBA_8888_PRE, wb, hb, wb * 4);
    const entry = {content, mx, my};
    shadowCache.set(key, entry);
    return entry;
}

class WindowShadows {
    constructor(tune) {
        this._tune = tune;
        this._ws = null;
        this._layer = null;
        this._map = new Map();
    }

    _ensureLayer(ws, scale) {
        if (this._ws === ws && this._layer)
            return;
        this.dispose();
        this._ws = ws;
        this._scale = scale;
        this._bmp = shadowContent(scale);
        this._layer = new ShadowLayer({name: 'swipeDepthShadows', reactive: false, x_expand: true, y_expand: true});
        Shell.util_set_hidden_from_pick(this._layer, true);
        const layer = this._layer;
        layer.connect('destroy', () => {
            // destroyed with its workspace (a dynamic workspace went away): nothing in it is ours to touch any more
            if (this._layer === layer) {
                this._map.clear();
                this._layer = null;
                this._ws = null;
            }
        });
        ws.insert_child_above(this._layer, ws._background ?? null);
    }

    // R, sd: model values; k: monitor width / design width; previews: [[preview, weight 0..1]] (a window Stage parked has a tilted
    // preview while it flies in from the rail, so its shadow only fades in once it is nearly flat)
    sync(ws, previews, R, sd, k) {
        if (!ws)
            return;
        this._ensureLayer(ws, k);
        const seen = new Set();
        const lift = this._tune.liftScale;
        for (const [p, weight] of previews) {
            if (!p.get_parent() || !p.visible)
                continue;
            seen.add(p);
            let sh = this._map.get(p);
            if (!sh) {
                const {content, mx, my} = this._bmp;
                sh = new Clutter.Actor({
                    name: 'swipeDepthShadow', reactive: false, opacity: 0, content,
                    content_gravity: Clutter.ContentGravity.RESIZE_FILL,
                    width: SHADOW_REF.w + 2 * mx, height: SHADOW_REF.h + 2 * my,
                });
                sh.set_pivot_point(0.5, 0.5);
                Shell.util_set_hidden_from_pick(sh, true);
                this._layer.add_child(sh);
                this._map.set(p, sh);
            }
            const box = p.get_allocation_box();
            const w = box.get_width(), h = box.get_height();
            if (!(w > 1 && h > 1)) {
                sh.opacity = 0;
                continue;
            }
            const cx = box.x1 + w / 2, cy = box.y1 + h / 2;
            const grow = (1 + lift * R) * (1 + this._tune.shadowRebound * sd);
            setPosIf(sh, Math.round(cx - sh.width / 2), Math.round(cy - sh.height / 2));
            setScaleIf(sh, grow * w / SHADOW_REF.w, grow * h / SHADOW_REF.h);
            // alpha: .38 + .22 R of the .60 the style is drawn with; invisible while the window is still at rest
            const amount = clamp(R * 4);
            const a = ((0.38 + 0.22 * R) / 0.60) * amount;
            sh.opacity = Math.round(255 * clamp(a) * clamp(p.opacity / 255) * weight);
        }
        for (const [p, sh] of this._map) {
            if (!seen.has(p)) {
                sh.destroy();
                this._map.delete(p);
            }
        }
    }

    dispose() {
        const layer = this._layer;
        this._layer = null;
        this._ws = null;
        this._map.clear();
        layer?.destroy();          // takes the shadows with it
    }
}

// =================================================================================================================
// Rail piles of the Vitre Stage (the fan). While the overview is up the rail stays painted and its piles fan open; Stage itself is
// not edited: StageHook wraps four of its own methods from here (it replaces the five-line patch rig/work/a20b/stage-hook.diff), the
// wrappers are installed while piles = stay and the style is depth, and removed again otherwise (and in disable()).
// =================================================================================================================

function stageManager() {
    return Extension.lookupByUUID(STAGE_UUID)?._manager ?? null;
}

function stageStrip() {
    return stageManager()?._strip ?? null;
}

// true while the Stage hook is installed: windows Stage parked are not in the grid (their piles stay on the left instead)
let stageKeep = false;

// The fan: Stage's quad matrix of every thumbnail (local px -> screen) with the fan added. The previews carry a custom matrix
// (Clutter.Actor.set_transform), so translation_* and rotation_angle_* are ignored on them. Two levers: CastItem.setTiltBoost() scales
// the tilt (rotateY 32 -> 20 degrees = fanRelaxDeg 12 of fanTiltDeg 32), and the matrix itself is decorated after every
// CastItem.syncTilt() (see StageHook): each layer rolls about its bottom-left corner and moves further out and up.
class PileFan {
    constructor(tune) {
        this._tune = tune;
        this._touched = new Set();
        this.g = 0;
        this.scale = 1.5;
        this.hook = null;
    }

    // Stage's matrix m for one thumbnail with the fan added: the layer rolls about its bottom-left corner (before the tilt projection)
    // and moves out and up (after it).
    matrix(slot, m, w, h) {
        const g = this.g;
        if (!(g > 1e-4) || slot < 1)
            return null;
        const t = this._tune;
        const roll = new Graphene.Matrix();
        roll.init_identity();
        roll.translate(new Graphene.Point3D({x: 0, y: -h, z: 0}));
        roll.rotate_z(-slot * t.fanRollDeg * g);
        roll.translate(new Graphene.Point3D({x: 0, y: h, z: 0}));
        const move = new Graphene.Matrix();
        move.init_translate(new Graphene.Point3D({
            x: -slot * t.fanOffsetPx * this.scale * g, y: -slot * t.fanLiftPx * this.scale * g, z: 0,
        }));
        return roll.multiply(m).multiply(move);
    }

    // called by the CastItem.syncTilt wrapper right after Stage set the plain matrices
    decorate(item) {
        if (!(this.g > 1e-4) || !item._previews)
            return;
        for (const preview of item._previews.values()) {
            const slot = item.slots?.get(preview.win) ?? 0;
            if (slot < 1)
                continue;
            // Actor.transform reads back the whole local-to-parent matrix, the allocation origin included; set_transform() adds that
            // origin again, so the origin is taken out first (without this layer 1 lost its pile offset: 14 px, 8 px)
            const origin = new Graphene.Matrix();
            origin.init_translate(new Graphene.Point3D({x: -preview.actor.x, y: -preview.actor.y, z: 0}));
            const m = this.matrix(slot, preview.actor.transform.multiply(origin), preview.w, preview.h);
            if (m)
                preview.actor.set_transform(m);
        }
    }

    apply(g, active, scale = 1.5) {
        const gg = active ? g : 0;
        const changed = Math.abs(gg - this.g) > 1e-5;
        this.g = gg;
        this.scale = scale;
        const strip = stageStrip();
        if (!strip)
            return;
        const fanning = gg > 1e-4;
        const boost = fanning ? Math.round((1 - (this._tune.fanRelaxDeg / this._tune.fanTiltDeg) * clamp(g, 0, 1.2)) * 1000) / 1000 : 1;
        for (const item of strip.get_children()) {
            if (!item._previews || typeof item.setTiltBoost !== 'function' || typeof item.syncTilt !== 'function')
                continue;
            const visible = [...item._previews.values()].some(p => p.actor.opacity > 0);
            if (visible && fanning) {
                this.hook?.ensureTiltWrapper(item);
                const before = item._tiltBoost ?? 1;
                item.setTiltBoost(boost);                  // syncs when the boost changed
                if (before === boost && changed)
                    item.syncTilt();
                if (!this._touched.has(item)) {
                    this._touched.add(item);
                    item.connectObject('destroy', () => this._touched.delete(item), this);   // Stage destroyed it: nothing to put back
                }
            } else if (this._touched.has(item)) {
                this._touched.delete(item);
                item.disconnectObject(this);
                item.setTiltBoost(1);
                item.syncTilt();                           // g is 0 (or the rail is hidden): Stage's own matrices again
            }
        }
    }

    reset() {
        this.g = 0;
        for (const item of this._touched) {
            try {
                item.disconnectObject(this);
                item.setTiltBoost(1);
                item.syncTilt();
            } catch (_e) { /* destroyed */ }
        }
        this._touched.clear();
    }
}

// The window grid is built when the overview opens, from the windows GNOME counts as overview windows at that moment (our
// _isOverviewWindow override leaves out the ones Stage parked). A Stage swap while the overview is up changes that set: the window that
// came to the stage has no preview and the one that went to the rail still has. Put the grid right: drop the previews of windows that
// are kept out now and add the ones that are back (at full size at once: GNOME's own 250 ms scale-in would be cut off at 0 by a close
// that follows, see StageHook._gridChanged).
// `hide`: a Set of windows whose new previews join the grid invisible (a picture is flying to their slots, see Stage's overviewDrag.js)
// `unfreeze`: after a removal the grid closes the gap now (GNOME waits until the pointer has rested for 750 ms)
function syncGrid({hide = null, unfreeze = false} = {}) {
    const view = Main.overview._overview?.controls?._workspacesDisplay?._workspacesViews?.[Main.layoutManager.primaryIndex];
    for (const ws of view?._workspaces ?? []) {
        if (!ws._windows || typeof ws._doAddWindow !== 'function' || typeof ws._doRemoveWindow !== 'function')
            continue;
        let removed = false;
        for (const p of [...ws._windows]) {
            if (p.metaWindow && !ws._isOverviewWindow(p.metaWindow)) {
                safe(() => ws._doRemoveWindow(p.metaWindow));
                removed = true;
            }
        }
        for (const actor of global.get_window_actors()) {
            const meta = actor.meta_window;
            if (!meta || ws.containsMetaWindow(meta) || !ws._isMyWindow(meta) || !ws._isOverviewWindow(meta))
                continue;
            safe(() => {
                ws._doAddWindow(meta);
                const clone = ws._windows.find(c => c.metaWindow === meta);
                if (clone) {
                    clone.remove_all_transitions();
                    clone.set_scale(1, 1);
                    clone.set_pivot_point(0, 0);
                    if (hide?.has(meta))
                        clone.opacity = 0;
                }
            });
        }
        if (unfreeze && removed) {
            safe(() => {
                const layout = ws._container?.layout_manager;
                if (layout)
                    layout.layout_frozen = false;
                if (ws._layoutFrozenId > 0) {
                    GLib.source_remove(ws._layoutFrozenId);
                    ws._layoutFrozenId = 0;
                }
            });
        }
    }
}

class StageHook {
    constructor(ext, manager, fan) {
        this._ext = ext;
        this.manager = manager;
        this._fan = fan;
        this._undo = [];
        this._syncId = 0;
        this._closeAfter = false;
        this._closeTimer = 0;
        this._afterTag = {};
    }

    // false when this Stage build does not have what the hook needs (the piles are then carried into the grid, like A1)
    install() {
        const m = this.manager;
        for (const name of ['_applyOverviewMode', '_syncBadges', 'overviewRectFor']) {
            if (typeof m[name] !== 'function')
                return false;
        }
        if (!m._strip)
            return false;
        // 1. the rail stays painted: Stage hides its thumbnails while the overview is up (setOverviewMode(true))
        this._wrap('_applyOverviewMode', () => function () {
            if (this._stripGone)
                return;
            for (const item of this._strip.get_children())
                item.setOverviewMode(false);
        });
        // 2. parked windows are not laid out from/to the rail: they stay out of the grid (see _isOverviewWindow in the extension)
        this._wrap('overviewRectFor', () => function () {
            return null;
        });
        // 3. the app badges stay
        this._wrap('_syncBadges', () => function () {
            if (this._stripGone)
                return;
            for (const item of this._strip.get_children())
                item.setBadgeOpacity(255);
        });
        // 4. a swap made while the overview is up (a pile click, a pile dropped on the stage, a parked window activated from elsewhere)
        //    changes which windows Stage parks: the grid is brought in line afterwards. A click on a pile (a swap made by an input event,
        //    for no particular window and not by a drag) chooses that stage and the overview closes after it, like a click on a window of
        //    the grid does; before, it stayed open on the old stage's grid, where the next click swapped back. The pile cannot be watched
        //    for 'clicked' here: its swap destroys it (its group became the stage) and takes our handler along.
        const hook = this;
        if (typeof m._switchTo === 'function') {
            this._wrap('_switchTo', original => function (group, options, ...rest) {
                const result = original.call(this, group, options, ...rest);
                try {
                    hook._gridChanged(Boolean(Clutter.get_current_event()) && !options?.focusWin && !options?.drag);
                } catch (e) {
                    warnOnce('switch', `could not follow a Stage swap (${e.message})`);
                }
                return result;
            });
        }
        // 5. the fan matrix (the CastItem class is only reachable through an instance, see ensureTiltWrapper)
        this._fan.hook = this;
        stageKeep = true;
        // the strip stays painted: Stage lets it animate and take drops, and asks for the grid to be put right after one
        m._railStays = true;
        m._gridSync = opts => syncGrid(opts);
        for (const item of m._strip.get_children())
            this.ensureTiltWrapper(item);
        // bring the rail to the state the wrappers want (Stage may have hidden it already for this overview)
        safe(() => m._applyOverviewMode());
        safe(() => m._syncBadges());
        return true;
    }

    _wrap(name, make) {
        const m = this.manager;
        const own = Object.prototype.hasOwnProperty.call(m, name);
        const original = m[name];
        const wrapper = make(original);
        m[name] = wrapper;
        this._undo.push(() => {
            if (m[name] !== wrapper)
                return;                      // wrapped again by somebody else: leave their chain alone
            if (own)
                m[name] = original;
            else
                delete m[name];
        });
    }

    ensureTiltWrapper(item) {
        this._ext.wrapTilt(item);
    }

    // The grid follows the swap on the next idle (after Stage finished its own bookkeeping); `close`: the overview closes after that, once
    // a frame has been painted with the corrected grid (hiding freezes the layout: a window that has no slot yet would not be placed)
    _gridChanged(close) {
        if (!Main.overview.visible || !stageKeep)
            return;
        if (close)
            this._closeAfter = true;
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._runSync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _runSync() {
        const close = this._closeAfter;
        this._closeAfter = false;
        if (!Main.overview.visible || !stageKeep)
            return;
        safe(() => syncGrid());
        if (!close || Main.overview.closing)
            return;
        const go = () => {
            this._clearClose();
            if (Main.overview.visible && !Main.overview.closing)
                Main.overview.hide();
        };
        this._clearClose();
        try {
            global.stage.connectObject('after-update', go, this._afterTag);
        } catch (_e) { /* no such signal: the timer does it */ }
        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._closeTimer = 0;
            go();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearClose() {
        safe(() => global.stage.disconnectObject(this._afterTag));
        if (this._closeTimer) {
            GLib.source_remove(this._closeTimer);
            this._closeTimer = 0;
        }
    }

    remove() {
        stageKeep = false;
        safe(() => {
            this.manager._railStays = false;
            delete this.manager._gridSync;
        });
        if (this._fan.hook === this)
            this._fan.hook = null;
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        this._closeAfter = false;
        this._clearClose();
        for (const undo of this._undo.splice(0).reverse())
            safe(undo);
        // the overview may be up: Stage's own logic puts the rail and the badges back, and the windows it kept out of the grid return to it
        if (Main.overview.visible && !engine?.shutdown) {
            safe(() => this.manager._applyOverviewMode());
            safe(() => this.manager._syncBadges());
            // The grid is only worth putting right while the overview stays: a lock (session mode change disables us while the overview is
            // still up) or a close in flight destroys the previews a moment later, and other extensions that patch new previews
            // (rounded-window-corners) then touch disposed objects (round 10: Gjs-CRITICAL "already disposed" + unhandled rejection)
            const shown = Main.overview._shownState;
            if (Main.sessionMode.hasOverview && !Main.sessionMode.isLocked && (shown === 'SHOWING' || shown === 'SHOWN'))
                safe(() => syncGrid());
        }
    }
}

// =================================================================================================================
// The engine: everything that follows the overview state value
// =================================================================================================================

class DepthEngine {
    constructor(ext, tune) {
        this._ext = ext;
        this._tune = tune;
        this.depth = true;                 // style === depth
        this.reduced = false;              // enable-animations off
        this.attached = false;
        this.gesture = null;               // {f0, remap, f, v} while the fingers are down
        this.rel = null;                   // the last release {t, P0, R0, target, up}
        this._hist = [];
        this._g = {g: 0, v: 0};
        this._lastTick = 0;
        this._lastP = 0;
        this._popT0 = -1e9;
        this.grabbing = false;             // true while a finger gesture begins (it may grab a running close: see detach)
        this._keep = null;                 // derived state a grab carries across the hidden -> showing pair
        this._dbg = {};
        this.backdrop = new Backdrop(tune);
        this.strip = new Strip(tune);
        this.piles = new PileFan(tune);
        this.shadows = new WindowShadows(tune);
        this.shutdown = false;
        this._cost = {n: 0, total: 0, max: 0, last: 0};
        this._saved = {};
        this._cards = new Map();
    }

    get controls() {
        return Main.overview._overview?.controls ?? null;
    }

    get adjustment() {
        return this.controls?._stateAdjustment ?? null;
    }

    get active() {
        return this.depth;
    }

    // ---- gesture bookkeeping (called from the hooks) ----
    onGestureBegin(f0) {
        this.rel = null;
        // a gesture that grabs the landing while it still rings keeps the pop and the shadow rebound going (they end by themselves);
        // the lift R it finds is carried over and fades into the new model (see _tick), so nothing jumps at the grab
        this._carry = {R: this._R ?? 0, pending: true, t0: 0, d: 0};
        if (!this.depth) {
            this.gesture = null;
            return;
        }
        const up = Math.round(f0) === 0;
        if (!animationsOn()) {
            // reduced motion: the fingers only decide; the overview jumps and the group fades through
            this.gesture = {reduced: true, f0, f: f0, v: f0, up, faded: !up && f0 >= 1, remap: f => f};
            return;
        }
        this.gesture = {f0, remap: makeRemap(this._tune, f0), f: f0, v: f0, up};
    }

    _fade(opacity, onComplete) {
        const group = Main.layoutManager.overviewGroup;
        group.remove_all_transitions();
        this._pendingFade = onComplete ?? null;
        group.ease({
            opacity, duration: this._tune.reducedFadeMs / slowDown(), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            animationRequired: true,
            onComplete: () => {
                this._pendingFade = null;
                onComplete?.();
            },
        });
    }

    // reduced-motion gesture: crossing the dead zone is the whole gesture (value jumps, the group fades)
    reducedProgress(f) {
        const g = this.gesture;
        const adj = this.adjustment;
        const dz = this._tune.deadZone;
        g.f = f;
        if (g.up) {
            if (!g.faded && f > dz) {
                g.faded = true;
                adj.value = PICKER;
                this._fade(255);
            } else if (g.faded && f <= dz) {
                g.faded = false;
                this._fade(0);
            }
        } else if (g.f0 >= PICKER) {
            if (!g.faded && f < PICKER - dz) {
                g.faded = true;
                this._fade(0);
            } else if (g.faded && f >= PICKER - dz) {
                g.faded = false;
                this._fade(255);
            }
        }
    }

    reducedEnd(controls, target, onComplete) {
        const g = this.gesture;
        this.gesture = null;
        const adj = this.adjustment;
        const done = () => {
            adj.value = target;
            onComplete?.();
        };
        if (target === HIDDEN)
            controls.prepareToLeaveOverview();
        controls.dash.showAppsButton.checked = target === GRID;
        adj.remove_transition('value');
        adj.gestureInProgress = false;
        const group = Main.layoutManager.overviewGroup;
        if (target >= PICKER) {
            adj.value = target;
            if (group.opacity < 255)
                this._fade(255, () => onComplete?.());
            else
                onComplete?.();
        } else if (g.faded || !g.up) {
            this._fade(0, done);
        } else {
            done();
        }
    }

    onGestureProgress(f) {
        const g = this.gesture;
        const v = g.remap(f);
        g.f = f;
        g.v = v;
        return v;
    }

    // the finger lifted: remember where the visual state and the lift were
    onRelease(target, vRel) {
        const g = this.gesture;
        const P0 = clamp(this.adjustment?.value ?? 0);
        this.rel = {
            t: nowMs(), P0, target, up: g?.up ?? false, R0: this._R ?? 0, f: g?.f ?? 0, v: vRel,
        };
        if (target >= PICKER && g?.up)
            this._popT0 = nowMs();
        this.gesture = null;
    }

    // ---- attach / detach (overview showing / hidden) ----
    // A throw while the overview attaches must not leave a half-built look behind (each overview would log it again): back to stock
    attach() {
        try {
            this._attach();
        } catch (e) {
            this.failSafe('attach', e);
        }
    }

    _attach() {
        const controls = this.controls;
        if (!controls || this.attached || !this.depth)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.attached = true;
        this._lastTick = 0;                    // dt of the first tick is the default, not the time since the previous overview
        const keep = this._keep;
        this._keep = null;
        if (keep && this.gesture && nowMs() - keep.t < 1500) {
            // a finger grabbed a Super / Esc / click close that was still running: GNOME hid the overview and shows it again with the
            // first update, but the wallpaper, lift and piles are one continuous thing (see detach)
            this._hist = keep.hist;
            this._g = keep.g;
            this._R = keep.R;
        } else {
            this._hist = [];
            this._g = {g: 0, v: 0};
            if (!this.gesture) {
                this._R = 0;
                this.rel = null;
            }
        }
        this.backdrop.layout(monitor);
        this.strip.layout(monitor);
        this.strip.setCardSource(this.backdrop.actor);
        const group = Main.layoutManager.overviewGroup;
        if (!this.backdrop.actor.get_parent())
            group.insert_child_at_index(this.backdrop.actor, 0);
        if (!this.strip.actor.get_parent())
            group.insert_child_below(this.strip.actor, Main.overview._overview);
        this.backdrop.actor.show();
        this.strip.actor.show();
        this._saved.maxThumbScale = controls._thumbnailsBox?._maxThumbnailScale;
        this._fitThumbnails();
        this.reduced = !animationsOn();
        if (this.reduced) {
            // 120 ms fade-through: the overview itself jumps, its group fades in (a gesture decides when, see reducedProgress)
            group.remove_all_transitions();
            group.opacity = 0;
            if (!this.gesture?.reduced)
                this._fade(255);
        }
        global.stage.connectObject('before-update', () => this._guardedTick(), this);
        controls.layout_manager.layout_changed();
        safe(() => controls._updateThumbnailsBox());
        try {
            this._tick(true);
        } catch (e) {
            this.failSafe('tick', e);
        }
    }

    detach() {
        if (!this.attached)
            return;
        this.attached = false;
        // A finger swipe that grabs a close in flight (Super, Esc, a click: stock eases) makes GNOME stop that ease inside gestureBegin,
        // whose onStopped runs _hideDone: 'hidden' now, 'showing' again with the first update. The overview goes down and up within a
        // few ms; what is derived from the state value (lift, wallpaper lag, pile follower) must not restart from zero in between.
        const keep = this.grabbing
            ? {t: nowMs(), hist: this._hist, g: this._g, R: this._R ?? 0} : null;
        // every step on its own: one that throws must not skip the rest of the restore
        safe(() => global.stage.disconnectObject(this));
        const controls = this.controls;
        safe(() => this._restoreUi());
        safe(() => this.backdrop.reset());
        safe(() => this.backdrop.actor.hide());
        safe(() => this.strip.actor.hide());
        safe(() => this.piles.apply(0, false));
        safe(() => this.piles.reset());
        safe(() => this.shadows.dispose());
        this._keep = keep;
        if (!keep)
            this._R = 0;                       // (a grab hands the lift to onGestureBegin's carry)
        this._carry = null;
        this._popT0 = -1e9;
        this.rel = null;                       // a release must not outlive the overview it belonged to (stale lift on the next API open/close)
        safe(() => Main.layoutManager.overviewGroup.remove_all_transitions());
        safe(() => { Main.layoutManager.overviewGroup.opacity = 255; });
        if (controls && this._saved.maxThumbScale !== undefined && controls._thumbnailsBox)
            safe(() => { controls._thumbnailsBox._maxThumbnailScale = this._saved.maxThumbScale; });
        this._saved = {};
        this.gesture = null;
        // a fade that was cut short (disable, style switch) still owes GNOME its _hideDone / _showDone
        const pending = this._pendingFade;
        this._pendingFade = null;
        if (pending)
            safe(() => pending());
    }

    _restoreUi() {
        const controls = this.controls;
        Main.panel.opacity = 255;
        for (const [bg] of this._cards)
            bg.opacity = 255;
        this._cards.clear();
        const ws = this._activeWorkspace();
        for (const p of ws?._windows ?? []) {
            if (!p._depthScaled)
                continue;
            p.set_scale(1, 1);
            p.set_pivot_point(0, 0);
            p._depthScaled = false;
        }
        if (controls?._searchEntryBin)
            controls._searchEntryBin.opacity = 255;
        try {
            controls?._updateThumbnailsBox?.();
        } catch (_e) { /* torn down */ }
    }

    _fitThumbnails() {
        const tb = this.controls?._thumbnailsBox;
        if (!tb || !tb._porthole)
            return;
        const node = tb.get_theme_node();
        const pad = node.get_vertical_padding() + node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
        const inner = Math.max(8, this._tune.stripHeight - 10 - pad);
        tb._maxThumbnailScale = inner / tb._porthole.height;
        tb.queue_relayout();
    }

    _activeWorkspace() {
        const view = this.controls?._workspacesDisplay?._workspacesViews?.[Main.layoutManager.primaryIndex];
        return view?._workspaces?.[global.workspace_manager.get_active_workspace_index()] ?? null;
    }

    // ---- per frame ----
    // A throw in the frame handler must never strand the desktop: log once, restore the stock look, stay out of the way
    _guardedTick() {
        try {
            this._tick();
        } catch (e) {
            this.failSafe('tick', e);
        }
    }

    // reset to stock: the gesture is dropped, the layers and the panel are put back, depth stays off until the extension is re-enabled
    failSafe(where, e) {
        warnOnce(`failsafe-${where}`, `${where} failed (${e?.message ?? e}); the stock overview takes over`);
        this.depth = false;
        this.gesture = null;
        this.rel = null;
        this._carry = null;
        safe(() => this.detach());
    }

    _tick(force = false) {
        if (this.shutdown)
            return;
        const adj = this.adjustment;
        if (!adj || !this.attached)
            return;
        const nowUs = GLib.get_monotonic_time();
        if (!force && nowUs - this._lastTick < 1500)
            return;
        const costStart = nowUs;
        const t = nowUs / 1000;
        // The tick only runs while frames are painted, and an overview that has nothing to move paints none (see setScaleIf). The first
        // tick after such a gap must not integrate the whole gap (the pile follower steps in 0.5 ms: a 10 s gap was 20000 iterations in the
        // first frame of a swipe), and the lag histories must not interpolate across it. Nothing moved during a gap with a settled
        // follower, so it counts as one frame with the old value held right up to now; any other long gap (a real stall) is capped.
        let dt = 8.333;
        if (this._lastTick) {
            const gap = (nowUs - this._lastTick) / 1000;
            const settled = Math.abs(this._g.g - this._lastP) < 1e-3 && Math.abs(this._g.v) < 1e-3;
            if (gap > IDLE_GAP_MS && settled)
                this._hist.push({t: t - 1, p: this._lastP});
            else
                dt = Math.min(MAX_DT_MS, gap);
        }
        this._lastTick = nowUs;
        const tune = this._tune;
        const slow = slowDown();
        const v = adj.value;
        const P = clamp(v);
        this._lastP = P;
        if (v < 0.001)
            this._syncPreviewOpacity();
        this._hist.push({t, p: P});
        while (this._hist.length > 2 && this._hist[1].t < t - 700)
            this._hist.shift();
        this.reduced = !animationsOn();
        const motion = !this.reduced;
        const W = motion ? lagged(this._hist, t, tune.wallLagMs) : P;
        // lift R (see the model: rises with the finger, relaxes to liftRest as the release lands)
        const Pl = motion ? lagged(this._hist, t, tune.liftLagMs) : P;
        let R;
        const g = this.gesture;
        // a release only shapes the lift while ITS OWN spring is still running: once it has landed, or something else (Super, Esc,
        // a click on a window: a stock ease; a cancelled glide) took the state value over, the plain model applies
        if (this.rel && !g) {
            const tr = adj.get_transition('value');
            if (tr && !(ReleaseTransition && tr instanceof ReleaseTransition)) {
                this.rel = null;
                this._popT0 = -1e9;
            } else if (!tr && !adj.gestureInProgress) {
                this.rel = null;
            }
        }
        const rel = this.rel;
        if (g && g.up) {
            R = smooth(tune.deadZone, tune.deadZone + tune.liftRise, g.f);
        } else if (rel && rel.up && rel.target >= PICKER) {
            const sigma = clamp((Pl - rel.P0) / Math.max(1e-6, 1 - rel.P0));
            R = lerp(rel.R0, tune.liftRest, sigma);
        } else if (rel && rel.target === HIDDEN && rel.R0 > 0) {
            R = rel.R0 * smooth(0, 1, Pl / Math.max(rel.P0, 1e-3));
        } else {
            R = tune.liftRest * smooth(0, 0.7, Pl);
        }
        const carry = this._carry;
        if (carry) {
            if (carry.pending) {
                carry.pending = false;
                carry.t0 = t;
                carry.d = carry.R - R;
            }
            const k = Math.exp(-(t - carry.t0) / (tune.carryMs * slow));
            R += carry.d * k;
            if (k < 0.01)
                this._carry = null;
        }
        if (!motion)
            R = 0;
        this._R = R;
        // pile follower
        if (motion)
            stepFollower(this._g, P, dt, tune.fanOmega, tune.fanZeta);
        else
            this._g.g = P;
        const G = Math.max(0, this._g.g);
        // landing pop and shadow rebound (clock in animation time: slow-down scales it like every other animation)
        const since = (nowMs() - this._popT0) / slow;
        const pop = motion ? bump(since, tune.popDelayMs, tune.popTauMs) : 0;
        const sd = motion ? shadowRebound(since) : 0;
        const stripP = clamp(v);
        const glassOp = Math.min(1, tune.stripGlassSlope * stripP);
        const contentOp = clamp((stripP - tune.stripContentFrom) * tune.stripContentSlope);
        const panelOp = 1 - Math.min(1, tune.panelFadeSlope * stripP);
        const panelH = Main.panel.height || tune.stripHeight - 8;
        const stripH = lerp(Math.min(panelH, tune.stripHeight), tune.stripHeight, Math.min(1, P));

        this.backdrop.apply(v >= PICKER ? 1 : W, motion);
        const tb = this.controls?._thumbnailsBox;
        const thumbsShown = Boolean(tb?.visible) && (tb?._thumbnails?.length ?? 0) > 0;
        this.strip.apply(stripH, glassOp, thumbsShown ? 0 : contentOp, this._stripText());
        Main.panel.opacity = Math.round(255 * panelOp);
        this._cardsOpacity(v);
        this._searchFade();
        this._applyPreviews(R, pop, sd, P);
        this.piles.apply(G, motion && this.depth, this.backdrop.scale ?? 1.5);
        // The guarded writes (setScaleIf & co) produce no frame when nothing changed, so a curve that runs on the clock or follows the
        // value with a lag (landing pop, shadow rebound, wallpaper / lift lag, pile follower, carry) would stop a hair short of its end:
        // its last steps are smaller than the "did it change" tolerance and the frame that would show the next one is never asked for
        // (pop left at 0.01-0.05 of 1.010, vlook2 sheet). Ask for frames until they have landed. It ends by itself (the longest is the
        // pop, 1.2 s after a release); the overview at rest stays at 0 paints/s.
        if (motion && (since < tune.popDelayMs + POP_END_TAUS * tune.popTauMs || this._carry || Math.abs(W - P) > 1e-3 || Math.abs(Pl - P) > 1e-3 ||
            Math.abs(G - P) > 1e-3 || Math.abs(this._g.v) > 1e-3))
            safe(() => this.strip.actor.queue_redraw());
        const cost = GLib.get_monotonic_time() - costStart;
        this._cost.n++;
        this._cost.total += cost;
        this._cost.last = cost;
        this._cost.max = Math.max(this._cost.max, cost);
        this._dbg = {
            v, P, W, R, G, pop, sd, stripH, glassOp, contentOp, panelOp, motion,
            g: g ? {f: g.f, v: g.v} : null,
            rel: rel ? {P0: rel.P0, target: rel.target, up: rel.up} : null,
            wall: {zoom: this.backdrop.zoom?.scale_x ?? 1, bx: this.backdrop.sharp?.group.translation_x ?? 0,
                by: this.backdrop.sharp?.group.translation_y ?? 0, bs: this.backdrop.sharp?.group.scale_x ?? 1,
                cx: this.backdrop.glow?.translation_x ?? 0, cy: this.backdrop.glow?.translation_y ?? 0,
                blurOp: this.backdrop.blurred?.group.opacity ?? 0, dim: this.backdrop.dim?.opacity ?? 0,
                vig: this.backdrop.vignette?.opacity ?? 0},
        };
    }

    _stripText() {
        return `Desktop ${global.workspace_manager.get_active_workspace_index() + 1}`;
    }

    // The dead zone keeps the overview state at exactly 0 for the first 20 % of the finger's travel. GNOME re-syncs the opacity of the
    // window previews that are not showing on their workspace (Stage's parked windows) only when the workspace state value CHANGES
    // (WorkspaceLayout._syncOpacities, with Stage's override that starts them at their rail thumbnail's opacity). Until then they keep the
    // opacity they were created with (0) while Stage has already hidden its rail thumbnails: the piles would vanish for the whole dead
    // zone (224 ms in rig/work/a20b/results-f3/s5-stage/s1; stock has it for one frame). So the sync is run by hand while the state is 0.
    _syncPreviewOpacity() {
        const view = this.controls?._workspacesDisplay?._workspacesViews?.[Main.layoutManager.primaryIndex];
        for (const ws of view?._workspaces ?? [])
            safe(() => ws._container?.layout_manager?._syncOpacities?.());
    }

    // the stock workspace card is hidden (the full-screen wallpaper layers replace it); the small cards of the app grid return with it
    _cardsOpacity(v) {
        const view = this.controls?._workspacesDisplay?._workspacesViews?.[Main.layoutManager.primaryIndex];
        if (!view?._workspaces)
            return;
        const op = Math.round(255 * clamp(v - PICKER));
        for (const ws of view._workspaces) {
            const bg = ws._background;
            if (!bg)
                continue;
            if (bg.opacity !== op)
                bg.opacity = op;
            if (!this._cards.has(bg)) {
                this._cards.set(bg, true);
                bg.connect('destroy', () => this._cards.delete(bg));
            }
        }
    }

    _searchFade() {
        const controls = this.controls;
        const bin = controls?._searchEntryBin;
        if (!bin)
            return;
        const op = controls._searchController?.searchActive ? 255 : 0;
        if (bin.opacity !== op)
            bin.opacity = op;
    }

    _previewOf(win) {
        return this._activeWorkspace()?._windows?.find(p => p.metaWindow === win) ?? null;
    }

    // Called inside the preview's own drag-begin, before DND measures it: back to a plain preview, so DND shrinks it the way it
    // does everywhere else and the picture stays under the pointer.
    dragBegin(win) {
        const p = this._previewOf(win);
        if (!p)
            return;
        p._depthDrag = true;
        p.remove_transition('scale-x');
        p.remove_transition('scale-y');
        if (p._depthScaled) {
            p.set_scale(1, 1);
            p.set_pivot_point(0, 0);
            p._depthScaled = false;
        }
    }

    dragEnd(win) {
        const p = this._previewOf(win);
        if (p)
            p._depthDrag = false;
    }

    _applyPreviews(R, pop, sd, P) {
        const ws = this._activeWorkspace();
        if (!ws?._windows)
            return;
        const tune = this._tune;
        const s = (1 + tune.liftScale * R) * (1 + tune.overshoot * pop);
        const stage = Extension.lookupByUUID(STAGE_UUID)?._manager;
        // a window Stage parked has its preview carried by Stage's own matrix (a custom transform replaces scale and pivot, and
        // Stage rebuilds it on every allocation): it is not lifted here (the Stage hook's optional sixth line does that), but it
        // gets its shadow once it is nearly flat
        const isParked = p => Boolean(p._stageTilted || stage?.overviewRectFor?.(p.metaWindow));
        const parkedWeight = smooth(0.7, 1.0, P);
        const lifted = [];
        const shadowed = [];
        for (const p of ws._windows) {
            if (p._depthDrag || p.inDrag)
                continue;                      // in DND's hands
            if (isParked(p)) {
                shadowed.push([p, parkedWeight]);
            } else {
                lifted.push(p);
                shadowed.push([p, 1]);
            }
        }
        if (this.depth && !this.reduced)
            this.shadows.sync(ws, shadowed, R, sd, this.backdrop.scale ?? 1.5);
        for (const p of lifted) {
            if (p.get_transition('scale-x'))
                continue;                      // GNOME's own appear animation
            if (!p._depthScaled) {
                p.set_pivot_point(0.5, 0.5);
                p._depthScaled = true;
            }
            setScaleIf(p, s, s);
        }
    }

    debugState() {
        const adj = this.adjustment;
        return {
            style: this.depth ? 'depth' : 'stock', attached: this.attached, reduced: this.reduced,
            busy: Boolean(this.gesture) || Boolean(adj?.get_transition('value')),
            glass: this.strip.glassKind, stripOp: this.strip.actor.opacity, panelOpAct: Main.panel.opacity,
            ovgOp: Main.layoutManager.overviewGroup.opacity, tickUs: this._cost.last, tickN: this._cost.n, tickTotalUs: this._cost.total,
            tickMaxUs: this._cost.max, ...this._dbg,
        };
    }

    destroy() {
        if (this.shutdown) {
            // the session is going down: GNOME already destroyed every actor, touching them only logs criticals
            this.attached = false;
            return;
        }
        safe(() => this.detach());
        safe(() => this.piles.reset());
        safe(() => this.shadows.dispose());
        this.backdrop.destroy();
        this.strip.destroy();
    }
}

// =================================================================================================================
// the extension
// =================================================================================================================

export default class SwipeDepth extends Extension {
    get engine() {
        return engine;
    }

    get pilesStay() {
        return this._settings?.get_string('piles') === 'stay';
    }

    // The Stage hook (StageHook above): installed while the style is depth, piles = stay and the running Stage has the four methods it
    // wraps; removed otherwise. Called at every overview that opens too (Stage may have been enabled, or re-created, since).
    _syncStageHook() {
        const manager = stageManager();
        // Stage's own overview continuity (A1) must be running: without it Stage shows no rail in the overview and its parked windows
        // are only reachable through the grid
        const want = Boolean(engine?.depth && this.pilesStay && manager && manager._continuity);
        if (this._stageHook && (!want || this._stageHook.manager !== manager)) {
            this._stageHook.remove();
            this._stageHook = null;
        }
        if (want && !this._stageHook) {
            const hook = new StageHook(this, manager, engine.piles);
            let ok = false;
            try {
                ok = hook.install();
            } catch (e) {
                warnOnce('hook', `the Stage hook failed (${e.message}); the piles are carried into the grid`);
            }
            if (ok) {
                this._stageHook = hook;
            } else {
                hook.remove();
                if (this._settings.get_user_value('piles') !== null)
                    warnOnce('hook', 'piles = stay needs a Stage with _applyOverviewMode, _syncBadges and overviewRectFor; the piles are carried into the grid');
            }
        }
    }

    // CastItem.syncTilt sets the plain matrices; the fan is added right after (the class is only reachable through an instance)
    wrapTilt(item) {
        if (this._tiltWrapped || typeof item?.syncTilt !== 'function')
            return;
        const proto = Object.getPrototypeOf(item);
        if (typeof proto?.syncTilt !== 'function')
            return;
        this._tiltWrapped = true;
        this._override(proto, 'syncTilt', original =>
            function (...args) {
                const result = original.apply(this, args);
                try {
                    engine?.piles.decorate(this);
                } catch (e) {
                    warnOnce('fan', `the fan failed (${e.message})`);
                }
                return result;
            });
    }

    debugState() {
        return engine?.debugState() ?? null;
    }

    get tune() {
        return TUNE;
    }

    // rig only: the shared shadow bitmap for a monitor scale
    shadowBitmap(k) {
        return shadowContent(k);
    }

    enable() {
        this._injection = new InjectionManager();
        this._installed = [];
        this._stageHook = null;
        this._tiltWrapped = false;
        this._settings = this.getSettings();
        engine = new DepthEngine(this, TUNE);
        engine.depth = this._settings.get_string('style') !== 'stock';
        // at session shutdown GNOME destroys the overview group (and everything in it) before it disables extensions
        const gone = () => {
            if (engine)
                engine.shutdown = true;
        };
        global.connectObject('shutdown', gone, this);
        Main.layoutManager.overviewGroup.connectObject('destroy', gone, this);
        Main.panel.connectObject('destroy', gone, this);
        this._settings.connectObject('changed::style', () => this._styleChanged(), 'changed::piles', () => this._syncStageHook(), this);
        try {
            this._installHooks();
        } catch (e) {
            warnOnce('install', `hooks not installed (${e.message}); GNOME's overview is left as is`);
            this._restoreProtos();
            engine.depth = false;              // the layers need the hooks: without them stay completely stock
        }
        Main.overview.connectObject(
            'showing', () => {
                this._syncStageHook();
                engine?.attach();
            },
            'hidden', () => engine?.detach(),
            // a window picked up in the grid is DND's: the lift (scale 1.0126 about the centre) must not fight its shrink (DND scales about
            // the top-left corner), and its shadow stays behind in the grid
            'window-drag-begin', (_o, win) => safe(() => engine?.dragBegin(win)),
            'window-drag-end', (_o, win) => safe(() => engine?.dragEnd(win)),
            'window-drag-cancelled', (_o, win) => safe(() => engine?.dragEnd(win)),
            this);
        this._syncStageHook();
        this._loadGlass();
        this._prewarm();
        if (Main.overview.visible && engine.depth)
            engine.attach();
    }

    // The bitmaps (light layers, shade, window shadow) are computed once, when the shell is idle after enable, so the first overview
    // does not pay for them
    _prewarm() {
        this._prewarmId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._prewarmId = 0;
            try {
                const monitor = Main.layoutManager.primaryMonitor;
                if (engine && engine.depth && monitor) {
                    softContents(TUNE);
                    shadowContent(monitor.width / TUNE.designWidth);
                }
            } catch (e) {
                warnOnce('prewarm', `could not pre-draw the bitmaps (${e.message})`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        Main.overview.disconnectObject(this);
        global.disconnectObject(this);
        safe(() => Main.layoutManager.overviewGroup.disconnectObject(this));
        safe(() => Main.panel.disconnectObject(this));
        this._settings?.disconnectObject(this);
        this._restoreProtos();
        this._injection = null;
        this._stageHook?.remove();
        this._stageHook = null;
        if (this._prewarmId) {
            GLib.source_remove(this._prewarmId);
            this._prewarmId = 0;
        }
        engine?.destroy();
        engine = null;
        pendingRelease = null;
        softCache = null;
        shadowCache.clear();
        stageKeep = false;
        this._settings = null;
        this._glassLoading = false;
    }

    _styleChanged() {
        if (!engine)
            return;
        const depth = this._settings.get_string('style') !== 'stock';
        if (depth === engine.depth)
            return;
        engine.depth = depth;
        this._syncStageHook();
        if (!depth) {
            engine.detach();
        } else if (Main.overview.visible) {
            engine.attach();
        }
        engine.controls?.layout_manager?.layout_changed();
    }

    async _loadGlass() {
        this._glassLoading = true;
        try {
            const liquid = Main.extensionManager.lookup(LIQUID_UUID);
            const dir = liquid?.path ?? GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', LIQUID_UUID]);
            // GJS logs an import failure as a JS ERROR even when it is caught, so look before importing
            if (!GLib.file_test(`${dir}/glassField.js`, GLib.FileTest.EXISTS)) {
                warnOnce('glass', 'liquid-menus is not installed; the strip is a plain translucent bar');
                return;
            }
            const mod = await import(`file://${dir}/glassField.js`);
            if (!this._glassLoading || !engine)
                return;
            engine.strip.setGlassModule(mod, engine.backdrop.actor);
            if (engine.attached)
                engine.strip.layout(Main.layoutManager.primaryMonitor);
        } catch (e) {
            warnOnce('glass', `glassField.js not available (${e.message}); the strip is a plain translucent bar`);
        }
    }

    // override proto[name] with make(original) through GNOME's InjectionManager; undone by _restoreProtos
    _override(proto, name, make) {
        if (typeof proto[name] !== 'function')
            throw new Error(`${name} not found`);
        let installed = null;
        this._injection.overrideMethod(proto, name, original => {
            installed = make(original);
            return installed;
        });
        this._installed.push({proto, name, installed});
    }

    // restores newest first. A method that somebody else wrapped after us is left alone (restoring it would cut their chain off);
    // every wrapper here passes straight through to the original once `engine` is null.
    _restoreProtos() {
        for (const {proto, name, installed} of this._installed?.splice(0).reverse() ?? []) {
            try {
                if (proto[name] === installed)
                    this._injection.restoreMethod(proto, name);
                else
                    warnOnce(`wrapped-${name}`, `${name} was wrapped after ${LOG_TAG}; its chain is left in place`);
            } catch (e) {
                warnOnce('uninstall', `restore failed: ${e.message}`);
            }
        }
    }

    _installHooks() {
        const SwipeTracker = SwipeTrackerModule.SwipeTracker;
        const ControlsManager = OverviewControls.ControlsManager;
        const controls = Main.overview._overview?.controls;
        const layoutProto = controls ? Object.getPrototypeOf(controls.layout_manager) : null;
        if (!SwipeTracker?.prototype?._endGesture || !ControlsManager?.prototype?.gestureEnd ||
            !layoutProto?._computeWorkspacesBoxForState)
            throw new Error('unsupported GNOME overview');
        getReleaseTransition();

        // 1. note the release (position and speed of the fingers) before GNOME discards it
        this._override(SwipeTracker.prototype, '_endGesture', original =>
            function (velocity, distance, isTouchpad) {
                let rel = null;
                try {
                    if (this === Main.overview?._swipeTracker && distance > 0) {
                        let v;
                        if (this._cancelled) {
                            v = 0;
                        } else if (isTouchpad) {
                            const history = this._history;
                            v = estimateReleaseVelocity(history?._data, history?._releaseStamp,
                                Number.isFinite(velocity) ? velocity : 0) / distance;
                        } else {
                            v = (Number.isFinite(velocity) ? velocity : 0) / distance;
                        }
                        rel = {tracker: this, f: this._progress, v, isTouchpad};
                    }
                } catch (e) {
                    warnOnce('capture', `could not read the release (${e.message})`);
                }
                // B6: a swipe that never opened the overview (a tiny or downward three-finger swipe on the desktop): GNOME's
                // handler throws "Invalid overview shown transition from HIDDEN to HIDING" and skips the controls' release,
                // which leaves the overview "mid-gesture" until the next swipe. Finish it here, with nothing to show or hide.
                try {
                    const ov = Main.overview;
                    if (engine && this === ov?._swipeTracker && this._state === 1 && !ov._shown && ov._shownState === 'HIDDEN' &&
                        (this._allowedModes & Main.actionMode) !== 0 && this.enabled) {
                        this._reset();
                        ov._overview.controls.gestureEnd(0, 0, () => {});
                        return undefined;
                    }
                } catch (e) {
                    warnOnce('hidden-end', `could not finish a swipe that never opened the overview (${e.message})`);
                }
                const previous = pendingRelease;
                pendingRelease = rel;
                try {
                    return original.call(this, velocity, distance, isTouchpad);
                } finally {
                    pendingRelease = previous;
                }
            });

        // 1c. (B6) the same error from GNOME's interrupt path: while a modal is up (the Apps view, a menu) every finger update of a
        //     three-finger swipe "interrupts" a gesture that never began and emits an end, one stack trace per frame (145 for one
        //     swipe in the rig). Nothing began, so nothing has to end.
        if (typeof SwipeTracker.prototype._interrupt === 'function') {
            this._override(SwipeTracker.prototype, '_interrupt', original =>
                function () {
                    try {
                        const ov = Main.overview;
                        if (engine && this === ov?._swipeTracker && !ov._shown && ov._shownState === 'HIDDEN') {
                            const began = this._state === 1;
                            this._panGesture?.cancel();
                            this._reset();
                            if (began)
                                ov._overview.controls.gestureEnd(0, 0, () => {});
                            return undefined;
                        }
                    } catch (e) {
                        warnOnce('interrupt', `could not cancel a swipe that never opened the overview (${e.message})`);
                    }
                    return original.call(this);
                });
        }

        // 2. the finger -> progress map
        this._override(ControlsManager.prototype, 'gestureBegin', original =>
            function (tracker) {
                if (engine)
                    engine.grabbing = true;
                // B3: a second three-finger swipe up in the overview used to open GNOME's own app grid (the stock look,
                // not Vitre Apps). The overview is the end of the swipe, as the overview is on the reference design: the snap points are
                // [hidden, window picker] while the overview is at or below the picker. The Apps view opens from the Dock,
                // Super+A and the Apps button of Vitre Search; with the grid already open the stock points stay.
                if (engine && this._stateAdjustment.value <= PICKER + 0.001) {
                    const confirm = tracker.confirmSwipe;
                    tracker.confirmSwipe = function (distance, points, progress, cancelProgress) {
                        delete tracker.confirmSwipe;
                        return confirm.call(this, distance, points.filter(p => p <= PICKER), progress, Math.min(cancelProgress, PICKER));
                    };
                }
                let result;
                try {
                    result = original.call(this, tracker);
                } finally {
                    if (engine)
                        engine.grabbing = false;
                    // never leave the one-shot snap-point wrapper behind
                    if (Object.prototype.hasOwnProperty.call(tracker, 'confirmSwipe'))
                        delete tracker.confirmSwipe;
                }
                try {
                    engine?.onGestureBegin(tracker._initialProgress);
                } catch (e) {
                    warnOnce('begin', `gesture begin failed (${e.message})`);
                    if (engine)
                        engine.gesture = null;
                }
                return result;
            });
        this._override(ControlsManager.prototype, 'gestureProgress', original =>
            function (progress) {
                if (!engine?.gesture)
                    return original.call(this, progress);
                try {
                    if (engine.gesture.reduced) {
                        engine.reducedProgress(progress);
                        return undefined;
                    }
                    this._stateAdjustment.value = engine.onGestureProgress(progress);
                    return undefined;
                } catch (e) {
                    engine.failSafe('progress', e);
                    return original.call(this, progress);
                }
            });

        // 3. the release
        this._override(ControlsManager.prototype, 'gestureEnd', original =>
            function (target, duration, onComplete) {
                const g = engine?.gesture;
                if (!g)
                    return original.call(this, target, duration, onComplete);
                try {
                    if (g.reduced) {
                        engine.reducedEnd(this, target, onComplete);
                        return undefined;
                    }
                    const rel = pendingRelease;
                    let vVis = 0;
                    if (rel && rel.tracker === Main.overview._swipeTracker)
                        vVis = rel.v * slopeOf(g.remap, rel.f);
                    if (!Number.isFinite(vVis))
                        vVis = 0;
                    engine.onRelease(target, vVis);
                    if (target === HIDDEN)
                        this.prepareToLeaveOverview();
                    this.dash.showAppsButton.checked = target === GRID;
                    const adjustment = this._stateAdjustment;
                    adjustment.remove_transition('value');
                    releaseEase(adjustment, target, vVis, onComplete);
                    adjustment.gestureInProgress = false;
                    return undefined;
                } catch (e) {
                    // reset to stock: GNOME's own release finishes the gesture
                    engine?.failSafe('release', e);
                    this._stateAdjustment?.remove_transition('value');
                    return original.call(this, target, duration, onComplete);
                }
            });

        // 4. the thumbnails box fades with the strip
        if (typeof ControlsManager.prototype._getThumbnailsBoxParams === 'function') {
            this._override(ControlsManager.prototype, '_getThumbnailsBoxParams', original =>
                function () {
                    const params = original.call(this);
                    if (engine?.active && engine.attached) {
                        const P = clamp(this._stateAdjustment.value);
                        params[0] *= clamp((P - TUNE.stripContentFrom) * TUNE.stripContentSlope);
                    }
                    return params;
                });
        }

        // 5. the window rows start below the strip
        this._override(layoutProto, '_computeWorkspacesBoxForState', original =>
            function (state, box, searchHeight, dashHeight, thumbnailsHeight, spacing) {
                const result = original.call(this, state, box, searchHeight, dashHeight, thumbnailsHeight, spacing);
                if (!engine?.active || !engine.attached || state !== PICKER)
                    return result;
                let bottom = result.y2;
                const y1 = TUNE.stripHeight + TUNE.rowsBelowStrip;
                // B4: a few windows stay a good deal smaller than the screen, as in the overview: GNOME blows a lone window
                // up to 95 % of the area, which read as "the overview did nothing". The fewer windows, the more room around them.
                let x1 = result.x1, x2 = result.x2;
                try {
                    const active = global.workspace_manager.get_active_workspace();
                    const n = global.get_window_actors().filter(a => {
                        const w = a.meta_window;
                        return w && w.get_workspace() === active && !w.minimized && !w.is_skip_taskbar() &&
                            w.get_window_type() === 0;
                    }).length;
                    const side = n <= 1 ? 0.22 : n === 2 ? 0.13 : n === 3 ? 0.07 : 0.03;
                    const base = n <= 1 ? 0.12 : n === 2 ? 0.07 : n === 3 ? 0.04 : 0;
                    const W = x2 - x1;
                    x1 += W * side;
                    x2 -= W * side;
                    bottom -= (bottom - y1) * base;
                } catch (_e) { /* the plain box */ }
                result.set_origin(x1, y1);
                result.set_size(Math.max(1, x2 - x1), Math.max(1, bottom - y1));
                return result;
            });

        // 6. and the thumbnails sit inside the strip. GJS binds vfunc_allocate when the class is created, so a wrapper on the
        //    prototype is never called; _runPostAllocation is an ordinary method that runs at the end of every layout pass.
        this._override(layoutProto, '_runPostAllocation', original =>
            function () {
                if (engine?.active && engine.attached) {
                    const tb = this._workspacesThumbnails;
                    if (tb?.visible) {
                        const b = tb.get_allocation_box();
                        const h = b.get_height();
                        const y1 = Math.round((TUNE.stripHeight - h) / 2);
                        if (Math.abs(b.y1 - y1) > 0.5) {
                            const nb = new Clutter.ActorBox();
                            nb.set_origin(b.x1, y1);
                            nb.set_size(b.get_width(), h);
                            tb.allocate(nb);
                        }
                    }
                }
                return original.call(this);
            });

        // 7. piles = stay: windows Stage parked are not in the grid (their piles stay on the left instead)
        if (typeof WorkspaceModule.Workspace?.prototype?._isOverviewWindow === 'function') {
            this._override(WorkspaceModule.Workspace.prototype, '_isOverviewWindow', original =>
                function (window) {
                    if (stageKeep && stageManager()?._ours?.has(window))
                        return false;
                    return original.call(this, window);
                });
        }

        // 8. hover removed: the pointer entering a window shows nothing (GNOME: title pill, close button, 5 px grow). The long
        //    press and the keyboard focus paths call showOverlay themselves and are left alone.
        if (typeof WindowPreviewModule.WindowPreview?.prototype?._onEnter === 'function') {
            this._override(WindowPreviewModule.WindowPreview.prototype, '_onEnter', original =>
                function () {
                    if (engine?.active && engine.attached && !TUNE.hover)
                        return undefined;
                    return original.call(this);
                });
        }

        // 9. no app icon over the bottom edge of each window (GNOME draws one; the overview shows none). The icon stays in
        //    the layout, so the title label and the window sizes are what they were; it is only not painted.
        if (typeof WindowPreviewModule.WindowPreview?.prototype?._init === 'function') {
            this._override(WindowPreviewModule.WindowPreview.prototype, '_init', original =>
                function (...args) {
                    const result = original.call(this, ...args);
                    try {
                        if (engine?.active && !TUNE.previewIcon && this._icon)
                            this._icon.opacity = 0;
                    } catch (_e) { /* the stock preview */ }
                    return result;
                });
        }

        // 10. the Stage hook must be in place BEFORE the overview builds its window grid (prepareToEnterOverview runs before 'showing'):
        //     a Stage that was switched off and on again is a new manager, and its first overview would show the parked windows twice
        const ext = this;
        if (typeof ControlsManager.prototype.prepareToEnterOverview === 'function') {
            this._override(ControlsManager.prototype, 'prepareToEnterOverview', original =>
                function () {
                    try {
                        ext._syncStageHook();
                    } catch (e) {
                        warnOnce('prepare', `Stage hook sync failed (${e.message})`);
                    }
                    return original.call(this);
                });
        }

        // 9. reduced motion: the close is a 120 ms fade-through too
        this._override(ControlsManager.prototype, 'animateFromOverview', original =>
            function (callback) {
                if (!engine?.active || !engine.attached || animationsOn())
                    return original.call(this, callback);
                engine._fade(0, () => original.call(this, callback));
                return undefined;
            });
    }
}

// Runs the release: the same ease GNOME would run, but the value follows a spring that starts at the visual progress and
// the visual speed the fingers left with. Calls the stock ease on the prototype so another extension's temporary per-object
// override (gesture-history) cannot take it over.
function releaseEase(adjustment, target, v0, onComplete) {
    const stockEase = St.Adjustment.prototype.ease;
    const slow = slowDown();
    let plan = null;
    try {
        plan = planRelease(TUNE, adjustment.value, target, v0, slow, global.screen_height);
    } catch (e) {
        warnOnce('plan', `could not plan a release (${e.message}); GNOME's animation is used`);
    }
    if (!plan || !animationsOn() || !ReleaseTransition) {
        stockEase.call(adjustment, target, {duration: plan ? 250 : 0, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete});
        return;
    }
    const Original = Clutter.PropertyTransition;
    let swapped = false;
    try {
        Clutter.PropertyTransition = ReleaseTransition;
        swapped = Clutter.PropertyTransition === ReleaseTransition;
    } catch (e) {
        warnOnce('swap', `cannot build the release transition (${e.message}); GNOME's animation is used`);
    }
    if (!swapped) {
        stockEase.call(adjustment, target, {duration: 250, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete});
        return;
    }
    try {
        stockEase.call(adjustment, target, {duration: plan.T, mode: Clutter.AnimationMode.LINEAR, onComplete});
    } finally {
        try {
            Clutter.PropertyTransition = Original;
        } catch (e) {
            warnOnce('restore', `could not restore Clutter.PropertyTransition: ${e.message}`);
        }
    }
    const transition = adjustment.get_transition('value');
    if (transition instanceof ReleaseTransition) {
        transition._plan = plan;
        transition.set_duration(plan.T);
    } else if (transition) {
        transition.progress_mode = Clutter.AnimationMode.EASE_OUT_CUBIC;
        warnOnce('adopt', "the release transition was not created; GNOME's curve was restored");
    }
}

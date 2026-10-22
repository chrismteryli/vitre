// Vitre Stage for GNOME Shell 51, after the reference design Vitre Stage.
//
// The focused app's windows are the "stage". Other apps' windows are
// minimized (silently) and shown as window piles in a strip on the left, most
// recent first. Clicking a pile swaps it onto the stage; shift-click adds it to
// the current stage. The strip slides away when a window covers it and comes
// back when the pointer reaches the left edge.
//
// The window picker (overview) starts from and returns to the rail thumbnails: see
// "overview continuity" below. Hooks install only on GNOME Shell 51.0 (digest guard).
//
// Look (A2): rail thumbnails are live Clutter.Clone images of the windows, sized from the
// work area (5.5 % of its width), turned about their near edge (far edge 0.91 as tall) with a
// per-actor projective matrix, the app icon hanging off the bottom-left corner, piles fanning
// left. See "look" below for every number and where it was measured.
//
// Off by default: nothing changes until the Quick Settings toggle is turned on,
// Turning it off restores automatic casts and preserves explicit minimizes.
// Locking the screen
// keeps the stages as they are (the extension is disabled while locked).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {WorkspaceLayout} from 'resource:///org/gnome/shell/ui/workspace.js';
import {getOperations} from './windowOperations.js';
import {OverviewDrag, gridWorkspace} from './overviewDrag.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const PILE_MAX = 3;
const EDGE_TRIGGER_WIDTH = 4;       // A16: a band, not a 2 px line (the dwell below decides)

// Look (A2). Every size is a fraction of the primary work area (W x H), read off the reference's
// the reference design Vitre Stage screenshots (plans/A2-stage-look-and-motion.md, section 1; +-10 %).
const LOOK = {
    thumbW: 0.055,      // thumbnail width / W
    thumbHMax: 0.12,    // tallest thumbnail / H (stops a tall window eating the column)
    margin: 0.009,      // screen edge to the front thumbnail's near edge / W
    gap: 0.05,          // bottom of one thumbnail to top of the next / H
    icon: 0.30,         // app icon size / thumbnail width
    iconX: -0.24,       // icon left edge relative to the near edge, in icon widths
    iconBelow: 0.35,    // icon bottom below the thumbnail bottom, in icon heights
    // A16 item 8 (a reference clip pile, A16-measurements 7d): the layers behind the front one peek out
    // ~20 px to the left and ~12 px higher at a 150 px front thumbnail, each ~10 % dimmer, the
    // third nearly see-through. Both offsets are fractions of the thumbnail WIDTH.
    pileX: 20 / 150,    // each layer behind the front one sits this far left / thumbnail width
    pileY: 12 / 150,    // ... and this much higher / thumbnail width
    pileOpacity: [255, 230, 38],
    radius: 0.0025,     // corner radius / W
    shadowY: 0.03,      // shadow offset / thumbnail width
    shadowBlur: 0.06,   // shadow blur / thumbnail width
    shadowAlpha: 0.35,
    farRatio: 0.91,     // far-edge height / near-edge height
};

// Motion. A16: the swap follows the the reference design numbers in A16-measurements.md in milliseconds, as they
// come out at the shell's calibrated animation speed here (Just Perfection `animation` 5 = slow-down
// factor 0.8, see SPEED_REF): at that speed a swap takes exactly the the reference design times, any other speed
// setting or the developer slow-down scales them like every other shell animation, and reduced
// motion makes them 0.
const SWAP = {
    inMs: 320,          // one incoming window: ease-out sine (the reference design fit 280 ms; Vitre: a little longer, it starts AT the thumbnail)
    inMsGroup: 420,     // two or more windows arrive as a stack
    p0: 0,              // Vitre: the first painted frame IS the thumbnail (the reference design clip: 12.7 % along, a recorder artefact that read as the window popping in)
    outGeomMs: 50,      // outgoing window: shrink + slide + keystone ...
    outFadeDelay: 20,   // ... it stays opaque for the first frames (A16-measurements 1a: 51 % area at
    outFadeMs: 50,      // ... +0, 39 % at +17), then fades out, gone in 67-83 ms
    outP0: 0.58,        // the first painted frame of the ghost already has 58 % of the shrink and slide
    outScale: 0.62,
    outSlide: 0.153,    // of the work-area width, toward the strip
    outKeystone: 0.85,  // strip-side edge height ends at 1 - this of the far edge (the reference design: 0.19)
    outTiltP0: 0.41,    // keystone already shown in the ghost's first frame (the reference design edge ratio 1.54 = 41 % of the way);
                        // it then turns on its own ease-in-out over outGeomMs (the reference design.76 at +17 ms, 5.3 at +33 ms)
    inKeystone: 0.24,   // incoming window: far edge is this much shorter per unit of tilt (the reference design.82 at +33 ms,
                        // 0.89 at +117 ms, flat by +200 ms; the rail thumbnails keep LOOK.farRatio)
    parkMs: 340,        // a stage window flying into the strip (shrinks with keystone); the old stage uses it too on a swap
    clickMs: [70, 120], // the 'click into place' at the end of a flight: out and back in
    clickIn: 1.012,     // the stage window settles with a 1.2 % overshoot
    clickItem: 1.05,    // the thumbnail that lands in the strip presses 5 % and comes back
    landDelay: 55,      // the old stage's thumbnail appears in the clicked slot after its ghost is gone
    landMs: 175,
    landFrom: 1.3,
    dragFullPx: 120,    // a strip item dragged this far from where it was is the full-size window
    revealDwellMs: 320, // pointer at the left edge this long before the covered strip slides in
    revealMs: 267,
    revealTilt: 2.5,    // thumbnail tilt while the strip slides in, relaxing to 1
};
// Rail motion, in the reference design milliseconds like SWAP: they go through realMs(), so at this machine's calibrated
// animation speed (SPEED_REF) a reflow takes 250 / 300 / 200 ms (it ran 200 / 240 / 160 ms before).
const CAST_RESPONSE = 250;      // rail reflow (A2: 250 ms ease-out)
const STRIP_RESPONSE = 300;
const GROW_RESPONSE = 200;      // a pile appearing or leaving without a flight
const GROW_FROM = 0.9;

// How far an interrupted flight may keep going the way it went before it turns toward its new target
// (the peak of a Hermite segment's backward lobe is vn * 0.148 * delta).
const COAST = {x: 40, y: 40, scale_x: 0.05, scale_y: 0.05, scale_z: 0.2};

// The slow-down factor this machine's animations are calibrated at (Just Perfection animation 5).
const SPEED_REF = 0.8;

// the reference design milliseconds -> what to hand to Clutter, which multiplies it by the slow-down factor.
function realMs(ms) {
    return motionEnabled() ? ms / SPEED_REF : 0;
}


// Stages survive a screen lock: GNOME disables user-mode extensions while
// locked, and the module (not the manager) lives on until unlock.
let lockedState = null;

// --- springs ---------------------------------------------------------------

// Use compositor-native easing for ordinary motion. Only interrupted window
// flights supply a velocity-aware curve, so the replacement starts moving at
// the same speed as the image that was on screen.
function motionEnabled() {
    const settings = St.Settings.get();
    return settings.enable_animations && settings.reduced_motion !== St.ReducedMotion.REDUCE;
}

function springTo(actor, props, {response, onComplete} = {}) {
    actor.ease({
        ...props,
        duration: realMs(response),
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        onComplete,
    });
}

// --- window snapshots and the rail look ------------------------------------

function rectOf(r) {
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}

// The window's frame and buffer rectangles now, and (only when asked) a still image of it,
// cropped to its frame. Rail thumbnails and flights are live clones while the window actor
// exists (see previewActor); the still image is only the stand-in for a window that is going away
// (_noteClosing), so the swap path no longer pays for a paint_to_content per window (A16).
function takeSnapshot(win, withContent = false) {
    let content = null;
    try {
        getOperations().settle(win);
        const actor = win.get_compositor_private();
        if (!actor)
            return null;
        if (withContent)
            content = actor.paint_to_content(null);
    } catch (_error) {
        console.debug('Vitre Stage: snapshot failed');
    }
    if (withContent && !content)
        return null;
    return {content, frame: rectOf(win.get_frame_rect()), buffer: rectOf(win.get_buffer_rect())};
}

// Pixel sizes of the rail, from the primary work area (all A2 numbers live in LOOK).
let currentLook = null;

function computeLook(area) {
    const W = area.width, H = area.height;
    const thumbW = Math.round(LOOK.thumbW * W);
    const margin = Math.round(LOOK.margin * W);
    return {
        W, H, thumbW, margin,
        thumbHMax: Math.round(LOOK.thumbHMax * H),
        gap: Math.round(LOOK.gap * H),
        iconSize: Math.round(LOOK.icon * thumbW),
        radius: Math.max(1, Math.round(LOOK.radius * W)),
        shadow: {dy: LOOK.shadowY * thumbW, blur: LOOK.shadowBlur * thumbW, alpha: LOOK.shadowAlpha},
        // the column's reach for overlap and reveal: the layers of a pile peek out to the LEFT, so the pile
        // fan does not widen it (A2: 12 % of a thumbnail of padding)
        stripWidth: Math.round(2 * margin + thumbW * 1.12),
    };
}

// Thumbnail box for a window: LOOK.thumbW wide with the window's aspect, fitted by
// height when it would be taller than the cap (or than maxH, for back windows of a pile).
function thumbSize(look, frame, maxH = Infinity) {
    const cap = Math.min(look.thumbHMax, maxH);
    let w = look.thumbW, h = w * frame.height / frame.width;
    if (h > cap) {
        h = cap;
        w = h * frame.width / frame.height;
    }
    return {w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h))};
}

function thumbScale(frame, look = currentLook) {
    return thumbSize(look, frame).w / frame.width;
}

function slotScale(frame, _slot, look = currentLook) {
    return thumbScale(frame, look);
}

// Projective map of the rectangle (0,0)-(w,h) onto the quadrilateral P0 (top-left),
// P1 (top-right), P2 (bottom-right), P3 (bottom-left), as a Graphene matrix for
// Clutter.Actor.set_transform (applied about the actor's allocation origin; a custom
// transform replaces the actor's own scale and rotation).
function quadMatrix(w, h, quad) {
    const m = new Graphene.Matrix();
    if (!(w > 0 && h > 0)) {
        m.init_identity();
        return m;
    }
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    let g = 0, k = 0;
    if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
        const den = dx1 * dy2 - dx2 * dy1;
        g = (dx3 * dy2 - dx2 * dy3) / den;
        k = (dx1 * dy3 - dx3 * dy1) / den;
    }
    const a = x1 - x0 + g * x1, b = x3 - x0 + k * x3;
    const d = y1 - y0 + g * y1, e = y3 - y0 + k * y3;
    // 3x3 on pixel coordinates, embedded in a 4x4 (column-major, translation in 12 and 13)
    m.init_from_float([a / w, d / w, 0, g / w,  b / h, e / h, 0, k / h,  0, 0, 1, 0,  x0, y0, 0, 1]);
    return m;
}

// The thumbnail turned about its near (left) edge, seen from a camera at the
// vanishing height: the far edge is farRatio times as tall and its centre moves toward
// the vanishing height by (1 - ratio) of its distance. tilt 0..1 interpolates from flat.
// w, h: on-screen size of the flat thumbnail; centerY: screen y of its centre. `strength` scales how
// much shorter the far edge is (flights of an incoming window turn harder than the rail, A16).
function tiltQuad(w, h, tilt, centerY, vanishY, strength = 1) {
    if (tilt < 0) {
        // A16 swap-out: the strip-side (left) edge recedes instead, much more strongly (the
        // outgoing window turns into the strip). tilt -1 leaves it 1 - outKeystone as tall.
        const left = Math.max(0.02, 1 + SWAP.outKeystone * tilt);
        return [[0, h / 2 - left * h / 2], [w, 0], [w, h], [0, h / 2 + left * h / 2]];
    }
    const ratio = 1 - (1 - LOOK.farRatio) * strength * tilt;
    const shift = (1 - ratio) * (vanishY - centerY);
    return [[0, 0], [w, h / 2 + shift - ratio * h / 2], [w, h / 2 + shift + ratio * h / 2], [0, h]];
}

// St cannot compute values in CSS, so radius and shadow are set per actor. `factor`
// scales them for an image that is drawn smaller than it is built (flights).
function previewStyle(look, factor = 1, {shadow = true} = {}) {
    const f = n => Math.round(n * factor * 100) / 100;
    return `border-radius: ${f(look.radius)}px; ` + (shadow ?
        `box-shadow: 0 ${f(look.shadow.dy)}px ${f(look.shadow.blur)}px rgba(0, 0, 0, ${look.shadow.alpha});` :
        'box-shadow: none;');
}

// The shadow of a window at full size, as the windows themselves draw it. Fitted to a GTK4 window in the
// rig (wallpaper 128, phys px below the bottom edge: 60 at 1, 87 at 4, 101 at 8, 114 at 12, 128 by 24; beside
// it 85 at 1.5, 107 at 4.5, 125 at 12.5); this St shadow stays within 5 levels of it (rms). A flying image
// carries it scaled with the picture, so the last frame of a flight looks like the window that replaces it;
// the broad rail look (previewStyle with a factor) fades out as the picture grows.
const WINDOW_SHADOW = 'border-radius: 12px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.45);';

function snapshotContent(snap, sx, sy) {
    const {frame, buffer} = snap;
    return new Clutter.Actor({
        content: snap.content,
        x: (buffer.x - frame.x) * sx,
        y: (buffer.y - frame.y) * sy,
        width: buffer.width * sx,
        height: buffer.height * sy,
    });
}

// Swap a live clone for the captured image (the window is going away).
function freezePreview(box, snap = box._snap) {
    if (!box._crop || !snap?.content)
        return;
    for (const child of box._crop.get_children())
        child.destroy();
    box._crop.add_child(snapshotContent(snap, box._sx, box._sy));
    box._frozen = true;
}

// Draws the actor flat into an offscreen texture first and then through its transform with
// bilinear filtering (the stock offscreen effect samples with NEAREST), so the hard clip edge
// that the tilt turns diagonal comes out antialiased instead of stair-stepped. Rail
// thumbnails only: a full-size flight drawn this way would be minified without mipmaps.
let smoothEdgesFailed = false;
const SmoothEdges = GObject.registerClass(
class SmoothEdges extends Clutter.OffscreenEffect {
    vfunc_paint_target(node, paintContext) {
        if (!smoothEdgesFailed) {
            try {
                this.get_pipeline()?.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            } catch (error) {
                smoothEdgesFailed = true;
                console.warn(`Vitre Stage: smooth edges unavailable (${error.message}); thumbnail edges stay hard`);
            }
        }
        super.vfunc_paint_target(node, paintContext);
    }
});

// The window's image at width x height: a live Clutter.Clone of its compositor actor
// (the overview paints clones of minimized windows too), cropped to the frame, or the
// captured snapshot when the actor is gone. Rail thumbnails and flights both use this.
function previewActor(win, snap, width, height, {look = currentLook, cssFactor = 1, reactive = false, shadow = true} = {}) {
    const {frame, buffer} = snap;
    const sx = width / frame.width, sy = height / frame.height;
    const box = new St.Widget({style_class: 'stage-manager-preview', width, height});
    if (look)
        box.set_style(previewStyle(look, cssFactor, {shadow}));
    const crop = new Clutter.Actor({width, height, clip_to_allocation: true});
    box.add_child(crop);
    Object.assign(box, {_crop: crop, _snap: snap, _sx: sx, _sy: sy});
    // Clicks must follow the tilted picture exactly. The box's own pick region reaches
    // past its edge (shadow), so a plain actor of the picture's size takes the input.
    if (reactive) {
        box._hit = new Clutter.Actor({width, height, reactive: true});
        box.add_child(box._hit);
    }
    const source = win?.get_compositor_private();
    if (source) {
        const clone = new Clutter.Clone({
            source,
            x: (buffer.x - frame.x) * sx,
            y: (buffer.y - frame.y) * sy,
            width: buffer.width * sx,
            height: buffer.height * sy,
        });
        // The window actor was destroyed: keep showing what it last looked like
        // (but not while this preview itself is being torn down).
        let dying = false;
        box.connect('destroy', () => {
            dying = true;
        });
        clone.connect('destroy', () => {
            dying = true;
        });
        clone.connect('notify::source', () => {
            if (!dying && !clone.source)
                freezePreview(box);
        });
        crop.add_child(clone);
    } else {
        crop.add_child(snapshotContent(snap, sx, sy));
    }
    return box;
}

// A still, flat copy (DND image and the legacy API).
function snapshotActor(snap, scale) {
    return previewActor(null, snap, Math.round(snap.frame.width * scale), Math.round(snap.frame.height * scale));
}

// A moving window image: full-size preview, drawn through a matrix that scales it and
// turns it by `tilt` (scale_x, scale_y and scale_z only carry the animation: a custom
// transform replaces them, so the matrix is rebuilt whenever any of them or the
// position changes). Radius and shadow are sized so they match the rail at its scale.
//
// The shadow is two static layers under the picture: the rail's own look scaled up to the window
// (so a window that leaves or enters the rail looks like its thumbnail at that end) and the look of a real
// window (so it looks like the window at the other end). Which one shows follows the picture's size.
// `real`: only the window's own look (the ghost of the old stage, which the strong keystone of a wedge
// would stretch into a long smear if it carried the broad one).
function flyActor(win, snap, look, vanishY, {real = false} = {}) {
    const {frame} = snap;
    const rail = thumbSize(look, frame);
    const fly = previewActor(win, snap, frame.width, frame.height,
        {look, cssFactor: frame.width / rail.w, shadow: false});
    const layer = (style, k = 1) => {
        const l = new St.Widget({width: frame.width / k, height: frame.height / k, style, scale_x: k, scale_y: k});
        fly.add_child(l);
        fly.set_child_below_sibling(l, fly._crop);
        return l;
    };
    // the rail's broad shadow scaled up to the window: drawn at the rail's own size and scaled, not blurred at window
    // size (St blurs box-shadows on the CPU when a widget first paints: a window-size blur of that radius took 25-60 ms
    // in the first frame of every flight, B18)
    if (!real)
        fly._shadowRail = layer(previewStyle(look), frame.width / rail.w);
    fly._shadowFull = layer(WINDOW_SHADOW);
    fly._geo = {w: frame.width, h: frame.height, vy: vanishY, s0: rail.w / frame.width, real, strength: 1};
    // a flight can outlive its picture (the fly layer goes with the shell): nothing may read or destroy it after this
    fly.connect('destroy', () => {
        fly._stageGone = true;
    });
    const sync = () => syncFlyTilt(fly);
    for (const prop of ['x', 'y', 'translation-x', 'translation-y', 'scale-x', 'scale-y', 'scale-z'])
        fly.connect(`notify::${prop}`, sync);
    return fly;
}

function syncFlyTilt(fly) {
    const g = fly._geo;
    if (!g)
        return;
    const sx = fly.scale_x, sy = fly.scale_y, tilt = fly.scale_z - 1;
    // Clutter ignores translation_x/y on an actor that has a custom transform (it replaces scale, rotation
    // and translation alike), so the translation the flights and the pickup move by is folded into the quad.
    const tx = fly.translation_x, ty = fly.translation_y;
    fly.set_transform(quadMatrix(g.w, g.h,
        tiltQuad(g.w * sx, g.h * sy, tilt, fly.y + ty + g.h * sy / 2, g.vy, g.strength)
            .map(([x, y]) => [x + tx, y + ty])));
    if (fly._shadowRail) {
        // 0 at the size of the rail's thumbnail, 1 at the size of the window; a picture turned into a wedge
        // (tilt < 0) loses the broad one at once
        const w = Math.min(1, Math.max(0, (sx - g.s0) / (1 - g.s0)));
        const rail = Math.round(255 * (1 - w) * Math.max(0, Math.min(1, 1 + tilt)));
        if (fly._shadowRail.opacity !== rail)
            fly._shadowRail.opacity = rail;
        const full = Math.round(255 * w);
        if (fly._shadowFull.opacity !== full)
            fly._shadowFull.opacity = full;
    }
}

function flyTilt(fly) {
    return fly.scale_z - 1;
}

// --- overview continuity (A1) ----------------------------------------------
//
// GNOME's window picker treats a minimized window as "not showing": its session
// box (where the enter animation starts and the exit animation ends) is 0x0 at
// the work-area origin and it fades with the overview state. Stage parks windows
// by minimizing them, so every rail window would pop out of the top-left corner.
// While the overview is up, a parked window with a rail slot is instead laid out
// from/to that slot (stage coordinates), starting at its thumbnail's own opacity,
// so the overview's own previews carry the thumbnails into the grid and back.
//
// Hooks: WorkspaceLayout._syncOpacity (override) and WorkspaceLayout.vfunc_allocate
// (a literal copy of GNOME 51.0 with three `// [stage]` edit groups). The copy is only
// installed when the running method's text matches the 51.0 digest below; on any
// other Shell the overview behaves exactly as before this feature.

// sha256 of WorkspaceLayout.prototype.vfunc_allocate.toString() in GNOME Shell 51.0
const ALLOCATE_SHA256 = 'cfc6d3352a345a211ffd9fcbb1bb13166a252ebebdad8440ba4bc0b44f450c88';

let activeManager = null;

let overviewRectFailed = false;

function stageOverviewRect(win) {
    try {
        return activeManager?.overviewRectFor(win) ?? null;
    } catch (error) {
        // Never let a Stage fault break the overview's own layout pass.
        if (!overviewRectFailed) {
            overviewRectFailed = true;
            console.warn(`Vitre Stage: overview rail rect failed, using GNOME's placement: ${error.message}`);
        }
        return null;
    }
}

// The overview's own preview of a rail window carries the rail's tilt and flattens with the
// overview state, so the hand-off from the rail thumbnail has no jump at the far corners:
// at state 0 its quad is the rail thumbnail's quad, at state 1 it is flat, in between the
// far-edge ratio is lerp(0.91, 1, state) and the far-edge shift lerp(shift, 0, state).
function stageTiltPreview(child, railRect, width, height, state) {
    if (!railRect) {
        if (child._stageTilted) {
            child.set_transform(new Graphene.Matrix().init_identity());
            child._stageTilted = false;
        }
        return;
    }
    const tilt = (railRect.tilt ?? 1) * (1 - Math.min(1, Math.max(0, state)));
    child.set_transform(quadMatrix(width, height,
        tiltQuad(width, height, tilt, railRect.y + railRect.height / 2, railRect.vanishY)));
    child._stageTilted = true;
}

// Literal copy from GNOME Shell 51.0 js/ui/workspace.js (module-private there).
function animateAllocation(actor, box) {
    actor.save_easing_state();
    actor.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
    actor.set_easing_duration(200);

    actor.allocate(box);

    actor.restore_easing_state();

    return actor.get_transition('allocation');
}

// Literal copy of GNOME Shell 51.0 WorkspaceLayout.vfunc_allocate, edits marked [stage]:
// (1) the rail rectangle as the session box, (2) no size clamp for those windows,
// (3) the preview carries the rail tilt (stageTiltPreview).
function stageVfuncAllocate(container, box) {
    const containerBox = container.allocation;
    const [containerWidth, containerHeight] = containerBox.get_size();
    const containerAllocationChanged =
        this._lastBox === null || !this._lastBox.equal(containerBox);

    // If the containers size changed, we can no longer keep around
    // the old windowSlots, so we must unfreeze the layout.
    //
    // However, if the overview animation is in progress, don't unfreeze
    // the layout. This is needed to prevent windows "snapping" to their
    // new positions during the overview closing animation when the
    // allocation subtly expands every frame.
    if (this._layoutFrozen && containerAllocationChanged && !Main.overview.animationInProgress) {
        this._layoutFrozen = false;
        this.notify('layout-frozen');
    }

    const {ControlsState} = OverviewControls;
    const {currentState} =
        this._overviewAdjustment.getStateTransitionParams();
    const inSessionTransition = currentState <= ControlsState.WINDOW_PICKER;

    const window = this._sortedWindows[0];

    if (inSessionTransition || !window) {
        container.remove_clip();
    } else {
        const [, bottomOversize] = window.chromeHeights();
        const [containerX, containerY] = containerBox.get_origin();

        const extraHeightProgress =
            currentState - OverviewControls.ControlsState.WINDOW_PICKER;

        const extraClipHeight = bottomOversize * (1 - extraHeightProgress);

        container.set_clip(containerX, containerY,
            containerWidth, containerHeight + extraClipHeight);
    }

    let layoutChanged = false;
    if (!this._layoutFrozen || !this._lastBox) {
        if (this._needsLayout) {
            this._layout = this._createBestLayout(this._workarea);
            this._needsLayout = false;
            layoutChanged = true;
        }

        if (layoutChanged || containerAllocationChanged) {
            this._windowSlotsBox = box.copy();
            this._windowSlots = this._getWindowSlots(this._windowSlotsBox);
        }
    }

    const slotsScale = box.get_width() / this._windowSlotsBox.get_width();
    const workareaX = this._workarea.x;
    const workareaY = this._workarea.y;
    const workareaWidth = this._workarea.width;
    const stateAdjustementValue = this._stateAdjustment.value;

    const allocationScale = containerWidth / workareaWidth;

    const childBox = new Clutter.ActorBox();

    const nSlots = this._windowSlots.length;
    for (let i = 0; i < nSlots; i++) {
        let [x, y, width, height, child] = this._windowSlots[i];
        if (!child.visible)
            continue;

        x *= slotsScale;
        y *= slotsScale;
        width *= slotsScale;
        height *= slotsScale;

        const windowInfo = this._windows.get(child);

        let workspaceBoxX, workspaceBoxY;
        let workspaceBoxWidth, workspaceBoxHeight;

        const railRect = stageOverviewRect(windowInfo.metaWindow); // [stage]
        if (railRect) { // [stage]
            workspaceBoxX = (railRect.x - workareaX) * allocationScale; // [stage]
            workspaceBoxY = (railRect.y - workareaY) * allocationScale; // [stage]
            workspaceBoxWidth = railRect.width * allocationScale; // [stage]
            workspaceBoxHeight = railRect.height * allocationScale; // [stage]
        } else if (windowInfo.metaWindow.showing_on_its_workspace()) { // [stage]
            const {boundingBox} = child;
            workspaceBoxX = (boundingBox.x - workareaX) * allocationScale;
            workspaceBoxY = (boundingBox.y - workareaY) * allocationScale;
            workspaceBoxWidth = boundingBox.width * allocationScale;
            workspaceBoxHeight = boundingBox.height * allocationScale;
        } else {
            workspaceBoxX = workareaX * allocationScale;
            workspaceBoxY = workareaY * allocationScale;
            workspaceBoxWidth = 0;
            workspaceBoxHeight = 0;
        }

        // Don't allow the scaled floating size to drop below
        // the target layout size.
        // We only want to apply this when the scaled floating size is
        // actually larger than the target layout size, that is while
        // animating between the session and the window picker.
        if (inSessionTransition && !railRect) { // [stage]
            workspaceBoxWidth = Math.max(workspaceBoxWidth, width);
            workspaceBoxHeight = Math.max(workspaceBoxHeight, height);
        }

        x = Util.lerp(workspaceBoxX, x, stateAdjustementValue);
        y = Util.lerp(workspaceBoxY, y, stateAdjustementValue);
        width = Util.lerp(workspaceBoxWidth, width, stateAdjustementValue);
        height = Util.lerp(workspaceBoxHeight, height, stateAdjustementValue);

        childBox.set_origin(x, y);
        childBox.set_size(width, height);
        stageTiltPreview(child, railRect, width, height, stateAdjustementValue); // [stage]

        if (windowInfo.currentTransition) {
            windowInfo.currentTransition.get_interval().set_final(childBox);

            // The timeline of the transition might not have been updated
            // before this allocation cycle, so make sure the child
            // still updates needs_allocation to FALSE.
            // Unfortunately, this relies on the fast paths in
            // clutter_actor_allocate(), otherwise we'd start a new
            // transition on the child, replacing the current one.
            child.allocate(child.allocation);
            continue;
        }

        // We want layout changes (ie. larger changes to the layout like
        // reshuffling the window order) to be animated, but small changes
        // like changes to the container size to happen immediately (for
        // example if the container height is being animated, we want to
        // avoid animating the children allocations to make sure they
        // don't "lag behind" the other animation).
        if (layoutChanged && !Main.overview.animationInProgress) {
            const transition = animateAllocation(child, childBox);
            if (transition) {
                windowInfo.currentTransition = transition;
                windowInfo.currentTransition.connect('stopped', () => {
                    windowInfo.currentTransition = null;
                });
            }
        } else {
            child.allocate(childBox);
        }
    }

    this._lastBox = containerBox.copy();
}

// --- model -----------------------------------------------------------------

let nextGroupId = 1;
const usedAt = new WeakMap();      // window -> when it last was the active window of its group

class Group {
    constructor(app) {
        this.id = nextGroupId++;
        this.app = app;
        this.windows = [];      // most recently used first
        this.lastUsed = 0;
        this.item = null;       // CastItem while shown in the strip
    }

    touch(win) {
        this.lastUsed = GLib.get_monotonic_time();
        if (win)
            usedAt.set(win, this.lastUsed);
        if (win) {
            this.windows = this.windows.filter(w => w !== win);
            this.windows.unshift(win);
        }
    }
}

// A keyed pile: surviving windows keep their preview actors, focus and hover.
// The same preview composition is used here and in the moving window image.
//
// Layout (item-local pixels): the front window's thumbnail sits at (fan, rise); each
// window behind it is `pileX` of a thumbnail further left and `pileY` higher, same
// width, same tilt, no dimming. The app icon hangs off the front thumbnail's bottom-left
// corner. Every thumbnail is turned about its near edge by a projective matrix that
// depends on how far the item is from the work area's vertical centre.
const CastItem = GObject.registerClass(
class CastItem extends St.Button {
    _init(group, entries, look) {
        super._init({
            style_class: 'stage-manager-item', reactive: true, can_focus: true,
            track_hover: false, button_mask: St.ButtonMask.PRIMARY,
        });
        this.group = group;
        this.destroyed = false;
        this._look = look;
        this._previews = new Map();
        this._icons = [];
        this._apps = [];
        this._iconSize = 0;
        this.slots = new Map();
        this._pile = new Clutter.Actor();
        this.set_child(this._pile);
        this.set_pivot_point(0.5, 0.5);
        this._delegate = this;
        this.connect('destroy', () => {
            this.destroyed = true;
            // Its group can outlive it (a pile that left in a strip ghost, or rode a workspace card that is gone):
            // the group must not keep pointing at a destroyed pile.
            if (this.group?.item === this)
                this.group.item = null;
            // Native DND observes drag actor destruction and releases its grab.
            this._dragPreview?.destroy();
        });
        // The tilt depends on the item's height on screen, so it follows a reflow.
        this.connect('notify::y', () => this.syncTilt());
        this.update(entries, look);
    }

    // Item-local box of the thumbnail in `slot` (0 = front) for a window with this frame.
    _layer(slot, frame) {
        const look = this._look, front = this._front;
        const size = slot === 0 ? thumbSize(look, frame) : thumbSize(look, frame, front.h);
        return {
            x: this._fan - Math.round(look.thumbW * LOOK.pileX * slot),
            y: this._rise - Math.round(look.thumbW * LOOK.pileY * slot),
            w: size.w, h: size.h,
        };
    }

    update(entries, look = this._look) {
        this._entries = entries;
        this._look = look;
        const shown = entries.slice(0, PILE_MAX);
        const desired = new Set(shown.map(([win]) => win));
        for (const [win, preview] of this._previews) {
            if (!desired.has(win)) {
                preview.actor.destroy();
                this._previews.delete(win);
            }
        }
        this.slots = new Map(shown.map(([win], slot) => [win, slot]));
        this._front = shown.length ? thumbSize(look, shown[0][1].frame) :
            {w: look.thumbW, h: Math.round(look.thumbW * 0.66)};
        this._fan = Math.round(look.thumbW * LOOK.pileX * (PILE_MAX - 1));
        this._rise = Math.round(look.thumbW * LOOK.pileY * (PILE_MAX - 1));
        // Back windows are painted first.
        for (let slot = shown.length - 1; slot >= 0; slot--) {
            const [win, snap] = shown[slot];
            const geo = this._layer(slot, snap.frame);
            let preview = this._previews.get(win);
            if (preview && (preview.snap !== snap || preview.look !== look || preview.w !== geo.w ||
                preview.h !== geo.h)) {
                preview.actor.destroy();
                preview = null;
            }
            if (!preview) {
                preview = {win, snap, look, w: geo.w, h: geo.h, opacity: 255,
                    actor: previewActor(win, snap, geo.w, geo.h, {look, reactive: true})};
                preview.actor.add_effect(new SmoothEdges());
                this._previews.set(win, preview);
                this._pile.add_child(preview.actor);
            }
            preview.actor._hit.reactive = !this._railHidden && !this._inert;
            preview.actor.set_position(geo.x, geo.y);
            preview.opacity = LOOK.pileOpacity[Math.min(slot, LOOK.pileOpacity.length - 1)];
            this._syncPreviewOpacity(preview);
            this._pile.set_child_above_sibling(preview.actor, null);
        }
        const iconSize = look.iconSize;
        const overhang = Math.ceil(LOOK.iconBelow * iconSize);
        const width = this._fan + look.thumbW;
        const height = this._rise + this._front.h + overhang;
        if (!shown.length && !this._empty) {
            this._empty = new St.Widget({style_class: 'stage-manager-thumb-empty',
                width: this._front.w, height: this._front.h, x: this._fan, y: this._rise});
            this._pile.add_child(this._empty);
        } else if (shown.length && this._empty) {
            this._empty.destroy();
            this._empty = null;
        }
        const apps = [...new Set(entries.map(([win]) =>
            Shell.WindowTracker.get_default().get_window_app(win)).filter(Boolean))];
        this.accessible_name = apps.map(app => app.get_name()).join(', ') || 'Window group';
        if (apps.length !== this._apps.length || apps.some((app, i) => app !== this._apps[i]) ||
            this._iconSize !== iconSize) {
            for (const icon of this._icons)
                icon.destroy();
            this._icons = apps.slice(0, 3).map(app => app.create_icon_texture(iconSize));
            for (const icon of this._icons)
                this._pile.add_child(icon);
            this._apps = apps;
            this._iconSize = iconSize;
            this._syncIcons();
        }
        // The badge hangs off the front thumbnail's bottom-left corner.
        for (const [i, icon] of this._icons.entries()) {
            icon.set_position(this._fan + LOOK.iconX * iconSize + i * iconSize * 0.65,
                this._rise + this._front.h + LOOK.iconBelow * iconSize - iconSize);
            this._pile.set_child_above_sibling(icon, null);
        }
        this.set_size(width, height);
        this._pile.set_size(this.width, this.height);
        this.syncTilt();
    }

    // Turn every thumbnail about its near edge toward the work area's vertical centre.
    syncTilt() {
        const look = this._look;
        if (!look || !this._previews || this.destroyed)
            return;
        for (const preview of this._previews.values()) {
            const {actor, w, h} = preview;
            const m = quadMatrix(w, h, tiltQuad(w, h, this._tiltBoost ?? 1, this.y + actor.y + h / 2, look.H / 2));
            actor.set_transform(globalThis.__stagePileHook?.matrix?.(preview.win, this.slots.get(preview.win) ?? 0, m, w, h) ?? m);   // [swipe-depth hook 4+5/5]
        }
    }

    // The strip is turned further away while it slides in over a window (A16 item 9).
    setTiltBoost(boost) {
        if ((this._tiltBoost ?? 1) === boost)
            return;
        this._tiltBoost = boost;
        this.syncTilt();
    }

    // The old stage's thumbnail once its ghost is gone: appears in the clicked slot, larger
    // than its final size, and settles (A16 item 1). Only the first window of a pile starts it.
    land() {
        if (this._landed || this.destroyed)
            return;
        this._landed = true;
        this.growIn({land: true});
    }

    // Vitre: a thumbnail that has just flown into its slot presses in and comes back, as if it clicked into place.
    settle() {
        if (this.destroyed || !motionEnabled() || this._growing)
            return;
        const [out, back] = SWAP.clickMs;
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        this.ease({scale_x: SWAP.clickItem, scale_y: SWAP.clickItem, duration: realMs(out), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this.destroyed)
                    return;
                this.ease({scale_x: 1, scale_y: 1, duration: realMs(back), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            }});
    }

    _syncPreviewOpacity(preview) {
        preview.actor.opacity = (preview.hidden || this._railHidden) ? 0 : preview.opacity;
    }

    setFlightHidden(win, hidden) {
        if (this.destroyed)
            return;
        const preview = this._previews.get(win);
        if (preview) {
            preview.hidden = hidden;
            this._syncPreviewOpacity(preview);
            if (this.slots.get(win) === 0)
                this._syncIcons(!hidden);
        }
    }

    // The badge belongs to the front thumbnail: it is not there before the window has landed,
    // and it follows the overview's fade (setBadgeOpacity).
    _syncIcons(fadeIn = false) {
        const front = [...this.slots].find(([, slot]) => slot === 0)?.[0];
        const waiting = Boolean(front && this._previews.get(front)?.hidden);
        const target = waiting ? 0 : (this._badgeOpacity ?? 255);
        for (const icon of this._icons) {
            icon.remove_all_transitions();
            if (fadeIn && motionEnabled() && icon.opacity < target) {
                icon.ease({opacity: target, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                icon.opacity = target;
            }
        }
    }

    // While the overview is up its own window previews sit exactly on top of
    // these thumbnails and carry them; the thumbnails step aside (and stop
    // taking input) for the duration.
    setOverviewMode(on) {
        if (on && globalThis.__stagePileHook?.keepRail) return;                       // [swipe-depth hook 1/5] the rail stays painted
        if (this.destroyed || Boolean(this._railHidden) === on)
            return;
        this._railHidden = on;
        this._syncReactive();
        for (const preview of this._previews.values())
            this._syncPreviewOpacity(preview);
    }

    // Takes clicks and drags unless the overview carries it, it is leaving, or (A16) it is
    // the old stage's thumbnail that has not landed in its slot yet: a second click on the
    // spot of the first one must not swap straight back.
    _syncReactive() {
        const on = !this._railHidden && !this._inert && !this.leaving;
        this.reactive = on;
        for (const preview of this._previews.values())
            preview.actor._hit.reactive = on;
    }

    setInert(inert) {
        if (this.destroyed || Boolean(this._inert) === inert)
            return;
        this._inert = inert;
        this._syncReactive();
    }

    setBadgeOpacity(opacity) {
        this._badgeOpacity = opacity;
        if (!this.destroyed)
            this._syncIcons();
    }

    slotOpacity(win) {
        return this._previews.get(win)?.opacity ?? 255;
    }

    // Keep what the windows looked like (they are about to be destroyed).
    freeze(fresh = new Map()) {
        if (this.destroyed)
            return;
        for (const [win, preview] of this._previews)
            freezePreview(preview.actor, fresh.get(win) ?? preview.snap);
    }

    // A pile that appears without a flight, or leaves without one. `land` is the A16 variant
    // for the old stage's thumbnail: it appears in the clicked slot a moment after its ghost
    // has gone, larger than its final size, and settles (inert until it has).
    growIn({land = false} = {}) {
        if (this.destroyed)
            return;
        if (!motionEnabled()) {
            this.setInert(false);
            return;
        }
        this._growing = true;
        this.remove_all_transitions();
        const from = land ? SWAP.landFrom : GROW_FROM;
        this.set_scale(from, from);
        this.opacity = 0;
        this.ease({
            scale_x: 1, scale_y: 1, opacity: 255,
            duration: realMs(land ? SWAP.landMs : GROW_RESPONSE),
            delay: land ? realMs(SWAP.landDelay) : 0,
            mode: land ? Clutter.AnimationMode.EASE_OUT_SINE : Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._growing = false;
                this.setInert(false);
            },
        });
    }

    leave() {
        this.leaving = true;
        this._syncReactive();
        this.remove_all_transitions();
        this.ease({
            scale_x: GROW_FROM, scale_y: GROW_FROM, opacity: 0, duration: realMs(GROW_RESPONSE),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => this.destroy(),
        });
    }

    // Incoming motion reads what is actually painted. Outgoing motion targets
    // the final layout; pile and image use the same duration and settle together.
    // The rectangle is the thumbnail's near edge and width (untilted); `tilt` is 1.
    slotRect(win, frame, settled = false, slotOverride = null) {
        const slot = slotOverride ?? this.slots.get(win) ?? 0;
        const geo = this._layer(slot, frame);
        if (this._previews.has(win) && !settled) {
            const [x, y] = this.get_transformed_position();
            return {x: x + geo.x, y: y + geo.y, width: geo.w, height: geo.h, tilt: 1,
                opacity: this.slotOpacity(win)};
        }
        const strip = this.get_parent();
        return {
            x: (strip?.x ?? 0) + (strip?.targetTranslationX ?? strip?.translation_x ?? 0) +
                (this.targetX ?? this.x) + geo.x,
            y: (strip?.y ?? 0) + (this.targetY ?? this.y) + geo.y,
            width: geo.w, height: geo.h, tilt: 1, opacity: this.slotOpacity(win),
        };
    }

    // The drag actor is a small invisible proxy: native DND moves it with the pointer and
    // owns the grab, the drop and the cancel; the manager draws the window itself (A16 item 3).
    getDragActor() {
        this._dragPreview = this.manager.createDragProxy(this);
        return this._dragPreview;
    }

    getDragActorSource() {
        return this;
    }
});

// --- controller ------------------------------------------------------------

class StageManager {
    constructor(settings) {
        this._settings = settings;
        this._states = new Map();      // Meta.Workspace -> {groups, stage}
        this._snapshots = new Map();   // Meta.Window -> snapshot
        this._ours = new Set();        // windows parked by Stage
        this._userParked = new Set();   // explicit minimizes survive disabling Stage
        this._restoreClaims = new Map(); // covers native compositor signal dispatch
        this._flights = new Map();      // window -> current reversible scene transition
        this._draggedWindow = null;
        this._skipOwners = new Set();
        this._tracked = new Set();
        this._outgoing = new Map();    // window -> outgoing snapshot actor
        this._fullscreenTickets = new Map(); // native signal may precede lease
        this._inFlight = new Map();    // window actor -> its current incoming flight
        this._deferredRestores = new Set();
        this._deferredFocus = false;
        this._pendingSwitch = null;
        this._busy = 0;
        this._stripShown = true;
        this._look = null;             // pixel sizes of the rail (computeLook), set on enable and relayout
        this._closing = new Set();     // groups whose last window is being closed (their pile shrinks out)
        this._overviewOpen = false;    // overview showing .. hidden (A1)
        this._continuity = false;      // A1 hooks installed
        this._overviewHook = {active: false, reason: 'not-installed'};
        this._injections = null;
        this._stateAdjustment = null;
        this._overlapped = false;
        this._overlapQueued = false;
        this._timeouts = new Set();
        this._railDrag = null;         // {item, group, win, fly, ...} while a rail item is dragged (A16)
        this._railDragCancellations = new Set(); // cancel visuals still returning to the rail
        this._dragGroup = null;
        this._castKind = null;
        // Vitre: set by swipe-depth's hook while the strip stays painted in the overview (piles = stay). Then the strip is an ordinary part of
        // the picture there: it animates, windows can be dragged between it and the grid (overviewDrag.js) and flights may run.
        this._railStays = false;
        this._ovFlightOK = 0;          // > 0 while a drop in the overview starts its own flights
        this._ovDrag = null;
        this._edgeDwellId = 0;
        this._revealWatchId = 0;
        this._switcherInjections = null;
        this._shownTag = {};
        this._operations = getOperations();
        this._unregisterOperations = null;
    }

    enable() {
        this._look = currentLook = computeLook(this._workArea());
        this._strip = new St.Widget({name: 'stageManagerStrip', reactive: false, width: this._look.stripWidth});
        this._stripGone = false;
        this._strip.connect('destroy', () => {
            this._stripGone = true;
        });
        this._strip.targetTranslationX = 0;
        Main.layoutManager.addChrome(this._strip, {affectsStruts: false, trackFullscreen: true});
        // A3: the workspace the strip belongs to, and the strip travel state
        this._wsIndex = global.workspace_manager.get_active_workspace_index();
        this._stripGhost = null;
        this._stripTravel = null;

        // Vitre: the strip's column is reserved like a dock's, so a maximized or tiled window sits beside the strip
        // instead of under it (the reference design Vitre Stage does the same). Without it every maximized window covered the strip
        // and the strip stayed hidden behind it. A fullscreen window drops the reservation (trackFullscreen).
        this._reserveWidth = this._look.stripWidth;
        this._reserve = new St.Widget({name: 'stageManagerReserve', reactive: false, width: this._look.stripWidth});
        Main.layoutManager.addChrome(this._reserve, {affectsStruts: true, trackFullscreen: true});
        this._placeReserve();

        // Reactive only while a window covers the strip; layout owns .visible.
        this._edge = new St.Widget({name: 'stageManagerEdge', reactive: false, width: EDGE_TRIGGER_WIDTH});
        Main.layoutManager.addChrome(this._edge, {affectsStruts: false, trackFullscreen: true});
        this._edge.connect('enter-event', () => this._edgeEntered());
        this._edge.connect('leave-event', () => this._edgeLeft());
        this._strip.connectObject('notify::translation-x', () => this._syncRevealTilt(), this);

        // The pointer zone of a strip that is revealed over a window (A16 item 9): transparent,
        // as wide as the strip, reactive only while the strip is out.
        this._zone = new St.Widget({name: 'stageManagerZone', reactive: false});
        Main.layoutManager.addChrome(this._zone, {affectsStruts: false, trackFullscreen: true});
        this._zone.connect('leave-event', () => {
            this._zoneLeft();
            return Clutter.EVENT_PROPAGATE;
        });

        // Order: windows < strip < flying snapshots < panel.
        const ui = Main.layoutManager.uiGroup;
        this._flyLayer = new Clutter.Actor({name: 'stageManagerFly'});
        this._flyLayerGone = false;
        this._flyLayer.connect('destroy', () => {
            this._flyLayerGone = true;
        });
        ui.insert_child_above(this._flyLayer, global.window_group);
        ui.set_child_below_sibling(this._strip, Main.layoutManager.panelBox);
        ui.set_child_below_sibling(this._zone, this._strip);
        ui.set_child_above_sibling(this._flyLayer, this._strip);
        Main.layoutManager.trackChrome(this._flyLayer, {trackFullscreen: true});

        global.display.connectObject(
            'notify::focus-window', () => this._onFocusChanged(),
            'window-created', (_d, win) => this._onWindowCreated(win),
            'workareas-changed', () => this._relayout(),
            'grab-op-begin', (_d, win, op) => this._onGrabBegin(win, op),
            'grab-op-end', (_d, win) => this._onGrabEnd(win),
            this);
        global.window_manager?.connectObject(
            'minimize', (_wm, actor) => this._forgetConsumedSkip(actor),
            'unminimize', (_wm, actor) => this._forgetConsumedSkip(actor),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._onActiveWorkspaceChanged(),
            'workspace-removed', () => this._pruneWorkspaces(),
            this);
        activeManager = this;
        this._installOverviewHooks();
        this._installSwitcherHooks();
        Main.overview.connectObject(
            'showing', () => {
                this._invalidateRailDrags();
                for (const win of [...this._flights.keys()])
                    this._settleWindow(win);
                if (this._continuity) {
                    this._overviewOpen = true;
                    this._applyOverviewMode();
                    this._syncBadges();
                } else {
                    this._setStripVisible(false);
                }
            },
            'hiding', () => this._ovSettle(),
            'hidden', () => {
                if (this._continuity) {
                    this._overviewOpen = false;
                    // The model may have changed while the overview was up.
                    this._rebuildCast(false);
                    this._applyOverviewMode();
                    this._syncBadges();
                }
                this._updateOverlap();
            },
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);

        for (const win of global.display.list_all_windows())
            this._track(win);

        this._overviewOpen = this._continuity && Main.overview.visible;
        this._makeDropZone();
        this._ovDrag = new OverviewDrag(this);
        this._ovDrag.enable();
        this._unregisterOperations = this._operations.registerStage({
            prepare: (win, intent) => this._prepareOperation(win, intent),
            release: (ticket, win, intent, reason) => this._releaseOperation(ticket, win, intent, reason),
            activate: win => this._activateStage(win),
            ownsRestore: win => this._eligible(win) && !win.minimized &&
                (this._ours.has(win) || this._inFlight.has(win.get_compositor_private()) || this._restoreClaims.has(win)),
            park: win => this._parkWindow(win),
            ownsMinimize: win => this._eligible(win) && win.minimized && this._ours.has(win),
        });

        if (lockedState) {
            this._restoreLockedState();
            this._relayout();
        } else {
            this._relayout();
            this._adoptWorkspace(global.workspace_manager.get_active_workspace(), true);
        }
    }

    disable() {
        this._unregisterOperations?.();
        this._unregisterOperations = null;
        this._pendingSwitch = null;
        this._disabled = true;
        // First, while the drop zone and the timeouts it uses still exist.
        this._invalidateRailDrags();
        this._ovDrag?.disable();
        this._ovDrag = null;
        this._dropZone?.destroy();
        this._dropZone = null;
        this._draggedWindow = null;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._cancelEdgeDwell();
        this._stopRevealWatch();
        this._removeSwitcherHooks();
        this._stopStripTravel();

        global.display.disconnectObject(this);
        global.window_manager?.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._removeOverviewHooks();
        Main.layoutManager.disconnectObject(this);
        for (const win of this._tracked) {
            win.disconnectObject(this);
            win.disconnectObject(this._shownTag);
        }

        // Detach identities before destroying actors, so delayed callbacks cannot
        // reveal or destroy a replacement transition.
        for (const win of [...this._flights.keys()])
            this._settleWindow(win);
        this._inFlight.clear();
        this._outgoing.clear();

        if (Main.sessionMode.isLocked) {
            // Keep the stages; the manager comes back on unlock.
            this._saveLockedState();
        } else {
            lockedState = null;
            {
                for (const win of this._ours) {
                    if (!win.minimized || this._operations.isReserved(win) || this._userParked.has(win))
                        continue;
                    const actor = win.get_compositor_private();
                    if (actor) {
                        actor.opacity = 255;
                        this._skipEffect(actor);
                    }
                    this._operations.quiet(win, 'unminimize', () => win.unminimize());
                }
            }
            const focus = global.display.focus_window;
            if (focus && !this._operations.isReserved(focus))
                focus.activate(global.get_current_time());
        }

        if (!this._flyLayerGone) {
            Main.layoutManager.untrackChrome(this._flyLayer);
            this._flyLayer.destroy();
        }
        if (this._reserve) {
            Main.layoutManager.removeChrome(this._reserve);
            this._reserve.destroy();
            this._reserve = null;
            this._reserveWidth = 0;
        }
        this._edge.destroy();
        this._zone.destroy();
        if (!this._stripGone)
            this._strip.destroy();
        this._ours.clear();
        this._userParked.clear();
        this._restoreClaims.clear();
        if (currentLook === this._look)
            currentLook = null;
        for (const actor of this._skipOwners)
            Main.wm._skippedActors?.delete(actor);
        this._skipOwners.clear();
        this._tracked.clear();
        this._snapshots.clear();
        this._states.clear();
        this._fullscreenTickets.clear();
    }

    // -- overview continuity (A1) --

    _installOverviewHooks() {
        this._continuity = false;
        try {
            const text = WorkspaceLayout.prototype.vfunc_allocate.toString();
            const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
            if (digest !== ALLOCATE_SHA256) {
                this._overviewHook = {active: false, reason: 'digest-mismatch', digest};
                console.warn('Vitre Stage: GNOME overview layout differs from 51.0 (' +
                    `${digest.slice(0, 12)}); overview continuity is off, the overview behaves as before`);
                return;
            }
            const adjustment = Main.overview._overview?.controls?._stateAdjustment;
            if (!adjustment) {
                this._overviewHook = {active: false, reason: 'no-state-adjustment'};
                console.warn('Vitre Stage: overview state adjustment not found; overview continuity is off');
                return;
            }
            this._injections = new InjectionManager();
            this._injections.overrideMethod(WorkspaceLayout.prototype, '_syncOpacity',
                original => function (actor, metaWindow) {
                    // A parked window that has a rail slot does not fade in from
                    // nothing: it starts at its rail thumbnail's opacity (back
                    // windows of a pile are 210) and is fully opaque in the grid.
                    const rail = stageOverviewRect(metaWindow);
                    if (rail) {
                        const state = Math.min(1, Math.max(0, this._stateAdjustment.value));
                        actor.opacity = Math.round(rail.opacity + (255 - rail.opacity) * state);
                    } else {
                        original.call(this, actor, metaWindow);
                    }
                });
            this._injections.overrideMethod(WorkspaceLayout.prototype, 'vfunc_allocate',
                () => stageVfuncAllocate);
            this._stateAdjustment = adjustment;
            adjustment.connectObject('notify::value', () => this._syncBadges(), this);
            this._continuity = true;
            this._overviewHook = {active: true, reason: 'ok', digest};
        } catch (error) {
            console.warn(`Vitre Stage: overview continuity could not start: ${error.message}`);
            this._removeOverviewHooks();
            this._overviewHook = {active: false, reason: `error: ${error.message}`};
        }
    }

    _removeOverviewHooks() {
        this._continuity = false;
        this._overviewOpen = false;
        this._stateAdjustment?.disconnectObject(this);
        this._stateAdjustment = null;
        this._injections?.clear();
        this._injections = null;
        if (activeManager === this)
            activeManager = null;
    }

    // The rail rectangle (stage coordinates, plus the thumbnail's opacity) a
    // parked window starts from and returns to inside the overview, or null for
    // GNOME's default placement.
    overviewRectFor(win) {
        if (globalThis.__stagePileHook?.keepRail) return null;                        // [swipe-depth hook 2/5] parked windows stay out of the grid
        if (!this._continuity || this._disabled || !Main.overview.visible)
            return null;
        if (!this._ours.has(win) || !this._onPrimary(win))
            return null;
        if (win.get_workspace() !== global.workspace_manager.get_active_workspace())
            return null;
        const snap = this._snapshots.get(win);
        const item = this._groupOf(win, false)?.item;
        if (!snap || !item || item.destroyed)
            return null;
        const area = this._workArea();
        const vanishY = area.y + area.height / 2;
        if (item.slots.has(win))
            return {...item.slotRect(win, snap.frame, true), opacity: item.slotOpacity(win), vanishY};
        // A window beyond PILE_MAX sits under the back window of its pile.
        if (item._entries?.some(([w]) => w === win))
            return {...item.slotRect(win, snap.frame, true, PILE_MAX - 1), opacity: LOOK.pileOpacity[PILE_MAX - 1], vanishY};
        return null;
    }

    _applyOverviewMode() {
        if (this._stripGone)
            return;
        const on = this._continuity && this._overviewOpen;
        for (const item of this._strip.get_children())
            item.setOverviewMode(on);
    }

    // App badges fade with the overview state: gone at 1, back as a swipe reverses.
    _syncBadges() {
        if (this._stripGone)
            return;
        let opacity = 255;
        if (this._continuity && this._overviewOpen && this._stateAdjustment) {
            const state = Math.min(1, Math.max(0, this._stateAdjustment.value));
            opacity = Math.round(255 * (1 - state));
        }
        if (globalThis.__stagePileHook?.keepRail) opacity = 255;                      // [swipe-depth hook 3/5] badges stay
        for (const item of this._strip.get_children())
            item.setBadgeOpacity(opacity);
    }

    // While the overview is up (or closing) its own previews carry every window.
    // Park and unpark quietly and keep the rail model complete.
    _skipFlight(win, direction) {
        const actor = win.get_compositor_private();
        if (direction === 'out') {
            const item = this._groupOf(win, false)?.item;
            item?.setFlightHidden(win, false);
            item?.setInert(false);      // nothing flies, so there is nothing to wait for
        } else {
            if (actor?.get_parent())
                actor.opacity = 255;
            if (!this._ours.has(win))
                this._snapshots.delete(win);
        }
    }

    _saveLockedState() {
        for (const state of this._states.values()) {
            for (const g of state.groups)
                g.item = null;
        }
        lockedState = {
            states: this._states,
            ours: new Set(this._ours),
            userParked: new Set(this._userParked),
            snapshots: this._snapshots,
        };
        // The manager clears its own maps next; hand over fresh ones.
        this._states = new Map();
        this._snapshots = new Map();
    }

    _restoreLockedState() {
        const saved = lockedState;
        lockedState = null;
        const alive = new Set(global.display.list_all_windows());
        for (const [ws, state] of saved.states) {
            for (const g of state.groups)
                g.windows = g.windows.filter(w => alive.has(w) && !this._operations.isReserved(w));
            state.groups = state.groups.filter(g => g.windows.length > 0);
            if (state.stage && !state.groups.includes(state.stage))
                state.stage = null;
            this._states.set(ws, state);
        }
        for (const win of saved.ours) {
            if (alive.has(win) && win.minimized && !this._operations.isReserved(win))
                this._ours.add(win);
        }
        for (const win of saved.userParked ?? []) {
            if (this._ours.has(win))
                this._userParked.add(win);
        }
        for (const [win, snap] of saved.snapshots) {
            if (alive.has(win) && !this._operations.isReserved(win))
                this._snapshots.set(win, snap);
        }
        this._pruneWorkspaces();
    }

    // -- bookkeeping --

    // The shell is shutting down: it has destroyed the strip and the fly layer with the rest of the UI, and it still
    // emits window and workspace signals while it unmanages everything. None of that may reach an actor any more.
    _tornDown() {
        return this._stripGone || this._flyLayerGone;
    }

    _skipEffect(actor) {
        // A marker already supplied by another owner is not ours to remove.
        if (!Main.wm._skippedActors?.has(actor))
            this._skipOwners.add(actor);
        Main.wm.skipNextEffect(actor);
    }

    _forgetConsumedSkip(actor) {
        if (!Main.wm._skippedActors?.has(actor))
            this._skipOwners.delete(actor);
    }

    _clearOwnedSkip(win) {
        const actor = win.get_compositor_private();
        if (this._skipOwners.delete(actor))
            Main.wm._skippedActors?.delete(actor);
    }

    _takeFlight(win) {
        const token = this._flights.get(win);
        if (!token)
            return null;
        if (token.fly._stageGone) {
            // its picture was destroyed under it (the shell is shutting down): no pose to continue from
            this._flights.delete(win);
            this._outgoing.delete(win);
            if (this._inFlight.get(token.actor) === token)
                this._inFlight.delete(token.actor);
            return {snap: token.snap, pose: null, speeds: {}, direction: token.direction, kind: token.kind};
        }
        const elapsed = Math.max(0, token.timeline?.get_elapsed_time() ??
            (GLib.get_monotonic_time() - token.started) / 1000);
        const speeds = {};
        for (const [key, value] of Object.entries(token.motion)) {
            if (key === 'opacity')
                continue;
            // each property has its own duration since A16 (the swap-out ghost fades slower than it moves)
            const d = value.duration;
            const u = d ? Math.min(1, elapsed / d) : 1;
            if (!d)
                speeds[key] = 0;
            else if (value.profile === 'sine')
                speeds[key] = value.delta * Math.PI / 2 / d * Math.cos(Math.PI / 2 * u);
            else if (value.profile === 'cubic')
                speeds[key] = value.delta * 3 * (1 - u) * (1 - u) / d;
            else if (value.profile === 'inout')
                speeds[key] = value.delta * Math.PI / 2 / d * Math.sin(Math.PI * u);
            else
                speeds[key] = (value.delta * (6 * u - 6 * u * u) + value.velocity * d * (1 - 4 * u + 3 * u * u)) / d;
        }
        // (an interrupted flight moves by translation, see _startFlight)
        const pose = {x: token.fly.x + token.fly.translation_x, y: token.fly.y + token.fly.translation_y,
            width: token.snap.frame.width * token.fly.scale_x,
            height: token.snap.frame.height * token.fly.scale_y,
            opacity: token.fly.opacity, tilt: flyTilt(token.fly)};
        this._flights.delete(win);
        this._outgoing.delete(win);
        if (this._inFlight.get(token.actor) === token)
            this._inFlight.delete(token.actor);
        token.fly.remove_all_transitions();
        token.fly.destroy();
        return {snap: token.snap, pose, speeds, direction: token.direction, kind: token.kind};
    }

    _settleWindow(win) {
        const previous = this._takeFlight(win);
        const actor = win.get_compositor_private();
        if (previous?.direction === 'in' && actor?.get_parent())
            actor.opacity = 255;
        const settled = this._groupOf(win, false)?.item;
        settled?.setFlightHidden(win, false);
        if (previous?.kind === 'swap-out')
            settled?.setInert(false);
        // Be tolerant of a legacy in-flight record during a reserved handoff.
        const legacy = actor && this._inFlight.get(actor);
        if (legacy) {
            this._inFlight.delete(actor);
            if (legacy.fly && !legacy.fly._stageGone)
                legacy.fly.destroy();
            actor.opacity = 255;
        }
        const outgoing = this._outgoing.get(win);
        if (outgoing && !outgoing._stageGone)
            outgoing.destroy();
        this._outgoing.delete(win);
    }

    _prepareOperation(win, _intent) {
        if (this._hasRailDragFor(win))
            this._invalidateRailDrags();
        const ws = win.get_workspace();
        const state = this._states.get(ws);
        const group = state?.groups.find(g => g.windows.includes(win)) ?? null;
        const ticket = this._fullscreenTickets.get(win) ?? {ws, monitor: win.get_monitor(), state, group,
            index: group?.windows.indexOf(win) ?? -1,
            wasStage: Boolean(group && state.stage === group), owned: this._ours.has(win),
            userParked: this._userParked.has(win)};
        this._fullscreenTickets.delete(win);
        // The registry has already reserved this window, so synchronous focus
        // and minimize signals cannot re-enter Stage during this handoff.
        this._settleWindow(win);
        this._clearOwnedSkip(win);
        this._restoreOwnedWindow(win);
        this._ungroup(win);
        this._rebuildCast(false);
        return ticket;
    }

    _releaseOperation(ticket, win, _intent, reason) {
        if (reason === 'unmanaged' || !this._tracked.has(win) || !this._eligible(win))
            return;
        const samePlace = ticket && win.get_workspace() === ticket.ws &&
            win.get_monitor() === ticket.monitor && this._states.get(ticket.ws) === ticket.state;
        let group = null;
        // A retained group object is a stable ticket even if its final member
        // temporarily left. A group merged elsewhere while reserved is stale.
        if (samePlace && ticket.group &&
            (ticket.state.groups.includes(ticket.group) || ticket.group.windows.length === 0)) {
            group = ticket.group;
            if (!ticket.state.groups.includes(group))
                ticket.state.groups.push(group);
            if (!group.windows.includes(win))
                group.windows.splice(Math.max(0, ticket.index), 0, win);
            if (ticket.wasStage && !ticket.state.stage)
                ticket.state.stage = group;
        } else {
            group = this._groupOf(win, true);
        }
        // Respect user minimizes, moves, newer stage selections and focus. Only
        // an unchanged, normally completed handoff can recover our old cast.
        if (samePlace && ticket.owned && reason === 'complete' && !win.minimized &&
            !win.has_focus() && group !== this._state(win.get_workspace()).stage)
            {
                if (ticket.userParked)
                    this._userParked.add(win);
                this._sendToCast([win]);
            }
        else
            this._rebuildCast(false);
        if (win.has_focus() && !win.minimized)
            this._onFocusChanged();
    }

    _onFullscreenChanged(win) {
        if (this._tornDown())
            return;
        if (this._operations.isReserved(win))
            return;
        if (win.fullscreen) {
            this._fullscreenTickets.set(win, this._prepareOperation(win, 'fullscreen'));
        } else {
            const ticket = this._fullscreenTickets.get(win);
            this._fullscreenTickets.delete(win);
            this._releaseOperation(ticket, win, 'fullscreen', 'complete');
        }
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _state(ws = global.workspace_manager.get_active_workspace()) {
        let state = this._states.get(ws);
        if (!state) {
            state = {groups: [], stage: null};
            this._states.set(ws, state);
        }
        return state;
    }

    _pruneWorkspaces() {
        const alive = new Set();
        for (let i = 0; i < global.workspace_manager.n_workspaces; i++)
            alive.add(global.workspace_manager.get_workspace_by_index(i));
        for (const ws of [...this._states.keys()]) {
            if (!alive.has(ws))
                this._states.delete(ws);
        }
    }

    _onPrimary(win) {
        return win.get_monitor() === Main.layoutManager.primaryIndex;
    }

    _eligible(win) {
        return win && !this._operations.isReserved(win) && !win.fullscreen &&
            win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.is_skip_taskbar() &&
            !win.get_transient_for() &&
            !win.is_on_all_workspaces() &&
            this._onPrimary(win) &&
            win.can_minimize();
    }

    _appOf(win) {
        return Shell.WindowTracker.get_default().get_window_app(win);
    }

    _track(win) {
        if (this._tracked.has(win))
            return;
        this._tracked.add(win);
        win.connectObject(
            'unmanaged', () => this._onUnmanaged(win),
            'notify::minimized', () => this._onMinimizedChanged(win),
            'notify::fullscreen', () => this._onFullscreenChanged(win),
            'position-changed', () => this._onMoved(win),
            'size-changed', () => this._onMoved(win),
            'workspace-changed', () => this._onWorkspaceChanged(win),
            this);
    }

    _groupOf(win, create) {
        if (create && !this._eligible(win))
            return null;
        const ws = win.get_workspace();
        if (!ws)
            return null;
        const state = this._state(ws);
        let group = state.groups.find(g => g.windows.includes(win));
        if (group || !create)
            return group ?? null;
        const app = this._appOf(win);
        const belongsToApp = g => g.windows.length > 0 && g.windows.every(w => this._appOf(w) === app);
        // A new window of an app already in the working group belongs there,
        // including mixed-app groups. A separately parked window must not pull
        // that new window out of the current layout.
        group = (app && state.stage?.windows.some(w => this._appOf(w) === app) ? state.stage : null) ??
            state.groups.find(g => app && belongsToApp(g) && g !== state.stage);
        if (!group) {
            group = new Group(app);
            state.groups.push(group);
        }
        group.windows.push(win);
        return group;
    }

    _isGrouped(win) {
        const ws = win.get_workspace();
        return Boolean(ws && this._states.get(ws)?.groups.some(g => g.windows.includes(win)));
    }

    // Group every eligible window of a workspace that isn't grouped yet and
    // send the visible ones that aren't on stage to the strip. On the first
    // visit (or when Vitre Stage turns on) this also picks the stage.
    _adoptWorkspace(ws, initial) {
        if (ws !== global.workspace_manager.get_active_workspace())
            return;
        return this._mutate(() => {
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL, ws)
            .filter(w => this._eligible(w) && !this._isGrouped(w));
        if (wins.length === 0) {
            this._rebuildCast(false);
            return;
        }

        // Most recently used first: build groups in that order.
        for (const win of [...wins].reverse())
            this._groupOf(win, true)?.touch(win);

        const state = this._state(ws);
        if (initial || !state.stage) {
            const focus = global.display.focus_window;
            const visible = wins.filter(w => !w.minimized);
            const pick = (this._eligible(focus) && !focus.minimized && focus.get_workspace() === ws)
                ? focus : visible[0];
            if (pick) {
                state.stage = this._groupOf(pick, true);
                state.stage.touch(pick);
            }
        }
        const stage = state.stage;
        const outgoing = wins.filter(w => !w.minimized && !stage?.windows.includes(w));
        this._sendToCast(outgoing);
        });
    }

    // -- events --

    _onWindowCreated(win) {
        if (this._tornDown())
            return;
        win._vitreCreatedAt = GLib.get_monotonic_time() / 1000;
        this._track(win);
        // Windows that open without focus (focus-stealing prevention,
        // background launches) still need a place: on stage or in the strip.
        win.connectObject('shown', () => {
            win.disconnectObject(this._shownTag);
            this._later(250, () => {
                if (!this._tracked.has(win) || this._isGrouped(win) || !this._eligible(win))
                    return;
                if (win.has_focus() || win.minimized)
                    return;
                if (win.get_workspace() !== global.workspace_manager.get_active_workspace())
                    return;
                const group = this._groupOf(win, true);
                if (group && group !== this._state().stage)
                    this._sendToCast([win]);
            });
        }, this._shownTag);
    }

    _onFocusChanged() {
        if (this._tornDown())
            return;
        if (this._busy) {
            this._deferredFocus = true;
            return;
        }
        const win = global.display.focus_window;
        if (!this._eligible(win) || win.minimized)
            return;
        this._track(win);
        const group = this._groupOf(win, true);
        if (!group)
            return;
        group.touch(win);
        const state = this._state(win.get_workspace());
        if (group === state.stage) {
            this._queueOverlap();
            return;
        }
        this._switchTo(group, {focusWin: win});
    }

    _onMinimizedChanged(win) {
        if (this._tornDown())
            return;
        if (this._operations.isReserved(win))
            return;
        if (!win.minimized && this._ours.has(win)) {
            if (this._busy) {
                // A Dock click or Alt-Tab during a swap: replay it afterwards.
                this._deferredRestores.add(win);
                return;
            }
            this._restoredExternally(win);
        } else if (win.minimized && !this._ours.has(win)) {
            // Native titlebar/keyboard minimize parks the window in the rail too.
            this._parkWindow(win);
        }
    }

    // A window we minimized was restored by someone else (Dock, Alt-Tab).
    _restoredExternally(win) {
        if (!this._eligible(win))
            return;
        const group = this._groupOf(win, true);
        if (!group)
            return;
        if (win.get_workspace() !== global.workspace_manager.get_active_workspace()) {
            // The workspace switch that follows produces a focus event.
            group.touch(win);
            return;
        }
        this._switchTo(group, {focusWin: win});
    }

    _onMoved(win) {
        if (this._tornDown())
            return;
        if (this._hasRailDragFor(win) && !this._onPrimary(win))
            this._invalidateRailDrags();
        if (this._operations.isReserved(win))
            return;
        // A stage window dragged to another display leaves the stage.
        if ((this._isGrouped(win) || this._ours.has(win)) && !this._onPrimary(win)) {
            this._settleWindow(win);
            this._clearOwnedSkip(win);
            this._restoreOwnedWindow(win, {preserveExplicit: true});
            this._ungroup(win);
            this._rebuildCast(true);
        }
        const token = this._flights.get(win);
        if (token?.direction === 'in') {
            const target = rectOf(win.get_frame_rect());
            if (['x', 'y', 'width', 'height'].some(key => Math.abs(target[key] - token.target[key]) > 0.01)) {
                const previous = this._takeFlight(win);
                if (previous.pose)
                    this._startFlight(win, previous.snap, previous.pose, target, 'in', previous.speeds);
            }
        }
        this._queueOverlap();
    }

    _restoreOwnedWindow(win, {preserveExplicit = false} = {}) {
        // Relinquishing a live window must not turn our temporary minimize
        // into a permanent user minimize. Drop ownership before unminimize
        // emits notify::minimized, so it cannot trigger another stage swap.
        const wasUserParked = this._userParked.has(win);
        if (!this._ours.delete(win))
            return;
        this._snapshots.delete(win);
        this._userParked.delete(win);
        this._restoreClaims.delete(win);
        this._deferredRestores.delete(win);
        // Leaving Stage through a display/workspace change releases ownership,
        // but a deliberate minimize remains the user's choice. Consumer leases
        // use the default restore behavior and retain that choice in their ticket.
        if (!win.minimized || (preserveExplicit && wasUserParked))
            return;
        {
            const actor = win.get_compositor_private();
            if (actor) {
                actor.opacity = 255;
                this._skipEffect(actor);
            }
            this._operations.quiet(win, 'unminimize', () => win.unminimize());
        }
    }

    _ungroup(win, preserveOwnership = false) {
        for (const state of this._states.values()) {
            for (const group of state.groups)
                group.windows = group.windows.filter(w => w !== win);
            state.groups = state.groups.filter(g => g.windows.length > 0);
            if (state.stage && !state.groups.includes(state.stage))
                state.stage = null;
        }
        if (!preserveOwnership) {
            this._ours.delete(win);
            this._snapshots.delete(win);
            this._userParked.delete(win);
            this._restoreClaims.delete(win);
        }
        this._deferredRestores.delete(win);
    }

    _onUnmanaged(win) {
        if (this._tornDown())
            return;
        if (this._hasRailDragFor(win))
            this._invalidateRailDrags();
        this._tracked.delete(win);
        this._fullscreenTickets.delete(win);
        this._noteClosing(win);
        this._settleWindow(win);
        this._clearOwnedSkip(win);
        win.disconnectObject(this);
        win.disconnectObject(this._shownTag);
        this._ungroup(win);
        this._rebuildCast(true);
        this._queueOverlap();
    }

    // The last window of a pile on the rail is going away: keep what it looked like (its
    // actor is about to be destroyed) and let the pile shrink out of the rail instead of
    // vanishing. A closing window leaves its workspace first, then is unmanaged.
    _noteClosing(win) {
        if (!this._ours.has(win))
            return;
        let group = null;
        for (const state of this._states.values())
            group ??= state.groups.find(g => g.windows.includes(win)) ?? null;
        if (!group?.item || group.windows.length !== 1 || this._closing.has(group))
            return;
        const latest = takeSnapshot(win, true);
        group.item.freeze(new Map(latest ? [[win, latest]] : []));
        this._closing.add(group);
    }

    _onWorkspaceChanged(win) {
        if (this._tornDown())
            return;
        if (this._hasRailDragFor(win))
            this._invalidateRailDrags();
        if (this._operations.isReserved(win))
            return;
        if (!win.get_workspace())
            this._noteClosing(win);
        this._settleWindow(win);
        this._clearOwnedSkip(win);
        const eligible = Boolean(win.get_workspace() && this._eligible(win));
        if (!eligible && win.get_workspace())
            this._restoreOwnedWindow(win, {preserveExplicit: true});
        this._ungroup(win, eligible);
        if (eligible) {
            const group = this._groupOf(win, true);
            // The destination may already stage this app. Its members are
            // omitted from the cast, so automatic parking is restored while
            // explicit user minimizes are released intact.
            if (group === this._state(win.get_workspace()).stage)
                this._restoreOwnedWindow(win, {preserveExplicit: true});
        }
        this._rebuildCast(true);
    }

    _onActiveWorkspaceChanged() {
        if (this._tornDown())
            return;
        // A3: the strip travels with its workspace. The old strip's items leave in a ghost layer that slides
        // out with the old workspace; the new strip slides in with the new one (GNOME's own 250 ms
        // ease-out-cubic, so it stays in step with the windows). A three-finger swipe has already moved the
        // windows when the workspace activates, so there the strips cross-fade with a short slide instead.
        const idx = global.workspace_manager.get_active_workspace_index();
        const prev = this._wsIndex ?? idx;
        this._wsIndex = idx;
        const dir = idx > prev ? -1 : 1;
        const plan = idx !== prev ? this._planStripTravel() : null;
        const ghost = plan ? this._detachStripGhost() : null;
        // Workspace changes must never leave a snapshot from the old workspace
        // floating above the new workspace. Adoption rebuilds on every path.
        this._invalidateRailDrags();
        for (const win of [...this._flights.keys()])
            this._settleWindow(win);
        this._adoptWorkspace(global.workspace_manager.get_active_workspace(), false);
        if (plan)
            this._runStripTravel(plan, ghost, dir);
    }

    // 'slide' (keyboard, Dock, API switch), 'fade' (after a swipe) or null (no motion wanted or possible)
    _planStripTravel() {
        this._stopStripTravel();
        if (!motionEnabled() || this._disabled || this._stripGone || !this._strip.visible || this._railHidden ||
            Main.overview.visible || global.workspace_manager.layout_rows > 1 && global.workspace_manager.layout_columns === 1)
            return null;
        return Main.wm._workspaceAnimation?.gestureActive ? 'fade' : 'slide';
    }

    _stripTravelWhyNot() {
        return {motion: motionEnabled(), disabled: !!this._disabled, gone: !!this._stripGone, visible: this._strip.visible,
            railHidden: !!this._railHidden, overview: Main.overview.visible,
            rows: global.workspace_manager.layout_rows, cols: global.workspace_manager.layout_columns};
    }

    _detachStripGhost() {
        const items = this._strip.get_children().filter(item => !item.leaving && !item.destroyed);
        if (!items.length)
            return null;
        const ghost = new Clutter.Actor({name: 'stageManagerStripGhost', reactive: false});
        // Destroyed by whichever comes first: its own slide ending (_dropGhost), the next workspace change
        // (_stopStripTravel, whose remove_all_transitions() already runs the slide's onStopped) or the shell.
        ghost.connect('destroy', () => {
            ghost._stageGone = true;
            if (this._stripGhost === ghost)
                this._stripGhost = null;
        });
        this._strip.get_parent().insert_child_above(ghost, this._strip);
        ghost.set_position(this._strip.x + this._strip.translation_x, this._strip.y);
        ghost.set_size(this._strip.width, this._strip.height);
        for (const item of items) {
            item.remove_all_transitions();
            item.reactive = false;
            this._strip.remove_child(item);
            ghost.add_child(item);
        }
        this._stripGhost = ghost;
        return ghost;
    }

    _runStripTravel(plan, ghost, dir) {
        const W = Main.layoutManager.primaryMonitor?.width ?? 1920;
        const slide = plan === 'slide';
        const dur = slide ? 250 : 180;   // GNOME's WINDOW_ANIMATION_TIME; ease() and the timeline both scale it
        const mode = Clutter.AnimationMode.EASE_OUT_CUBIC;
        if (ghost) {
            ghost.ease(slide ? {x: ghost.x + dir * W, duration: dur, mode, onStopped: () => this._dropGhost(ghost)}
                : {opacity: 0, duration: 120, mode, onStopped: () => this._dropGhost(ghost)});
        }
        const from = slide ? -dir * W : -dir * 40;
        const tl = new Clutter.Timeline({actor: this._strip, duration: Math.max(1, Math.round(dur * St.Settings.get().slow_down_factor))});
        tl.set_progress_mode(mode);
        const apply = p => {
            if (this._stripGone)
                return;
            const m = new Graphene.Matrix();
            m.init_translate(new Graphene.Point3D({x: from * (1 - p), y: 0, z: 0}));
            this._strip.set_child_transform(m);
            if (!slide)
                this._strip.opacity = Math.round(255 * Math.min(1, p * 1.4));
        };
        tl.connect('new-frame', () => apply(tl.get_progress()));
        tl.connect('stopped', () => {
            if (this._stripTravel === tl)
                this._stripTravel = null;
            if (!this._stripGone) {
                this._strip.set_child_transform(null);
                if (!slide)
                    this._strip.opacity = 255;
            }
        });
        this._stripTravel = tl;
        apply(0);
        tl.start();
    }

    _dropGhost(ghost) {
        if (this._stripGhost === ghost)
            this._stripGhost = null;
        if (!ghost._stageGone)
            ghost.destroy();
    }

    _stopStripTravel() {
        const tl = this._stripTravel;
        this._stripTravel = null;
        tl?.stop();
        if (this._stripGhost) {
            const g = this._stripGhost;
            this._stripGhost = null;
            // stopping its slide runs the slide's onStopped (_dropGhost), which destroys the ghost already
            g.remove_all_transitions();
            if (!g._stageGone)
                g.destroy();
        }
        if (!this._stripGone) {
            this._strip.set_child_transform(null);
            this._strip.opacity = 255;
        }
    }

    // -- stage swaps --

    // The guard covers only synchronous native signals. Input is never held
    // for an animation: a new selection can retarget the painted image now.
    _mutate(fn) {
        this._busy++;
        try {
            return fn();
        } finally {
            this._busy--;
            if (!this._busy)
                this._flushDeferred();
        }
    }

    _flushDeferred() {
        if (this._pendingSwitch && !this._busy) {
            const {group, options} = this._pendingSwitch;
            this._pendingSwitch = null;
            if (options.focusWin && !this._tracked.has(options.focusWin))
                options.focusWin = null;
            this._switchTo(group, options);
            if (this._busy)
                return;
        }
        for (const win of [...this._deferredRestores]) {
            if (this._busy)
                break; // a swap started; the rest replays after it
            this._deferredRestores.delete(win);
            if (this._tracked.has(win) && !win.minimized && this._ours.has(win))
                this._restoredExternally(win);
        }
        if (this._deferredFocus && !this._busy) {
            this._deferredFocus = false;
            this._onFocusChanged();
        }
    }

    _activateStage(win) {
        if (!this._eligible(win))
            return false;
        const group = this._groupOf(win, false);
        if (!group || win.get_workspace() !== global.workspace_manager.get_active_workspace())
            return false;
        if (this._ours.has(win) || this._flights.has(win)) {
            this._switchTo(group, {focusWin: win});
            return true;
        }
        // Already on the stage: a Dock click never parks it (A16 item 5). The focused app is left
        // alone; any other app on the stage comes forward with all of its windows.
        if (group === this._state().stage && !win.minimized) {
            this._raiseApp(win);
            return true;
        }
        return false;
    }

    _raiseApp(win) {
        const app = this._appOf(win);
        const focus = global.display.focus_window;
        if (focus && !focus.minimized && this._isGrouped(focus) && this._appOf(focus) === app)
            return;
        const group = this._groupOf(win, false);
        const mates = group.windows.filter(w => this._appOf(w) === app && this._eligible(w) && !w.minimized);
        this._raiseGroup(mates.length ? mates : [win], null);
    }

    _parkWindow(win, {detach = true, user = true, restorePosition = null, fromPose = null} = {}) {
        if (!this._eligible(win))
            return false;
        if (this._ours.has(win) && win.minimized)
            return true;
        return this._mutate(() => {
            let group = this._groupOf(win, true);
            if (!group)
                return false;
            const state = this._state(win.get_workspace());
            if (detach && state.stage === group && group.windows.length > 1) {
                group.windows = group.windows.filter(w => w !== win);
                group = new Group(this._appOf(win));
                group.windows = [win];
                state.groups.push(group);
            }
            if (state.stage === group)
                state.stage = null;
            group.touch(win);
            if (user)
                this._userParked.add(win);
            this._sendToCast([win], {alreadyMinimized: true, fromPose});
            // A drag into the rail remembers where the window was before the
            // drag; reopening the group returns it to that working layout.
            if (restorePosition && win.move_frame)
                win.move_frame(true, restorePosition.x, restorePosition.y);
            return true;
        });
    }

    _showRailForFlight() {
        if (Main.overview.visible || this._stripGone)
            return;
        this._stripShown = true;
        this._strip.targetTranslationX = 0;
        this._strip.remove_transition('translation-x');
        this._strip.ease({translation_x: 0, opacity: 255, duration: realMs(SWAP.revealMs),
            mode: Clutter.AnimationMode.EASE_OUT_SINE});
    }

    // Where the old stage's window ends: smaller, a good way toward the strip, turned and
    // invisible (A16 item 1; A16-measurements 1a).
    _outPose(snap) {
        const area = this._workArea();
        const f = snap.frame;
        const w = f.width * SWAP.outScale, h = f.height * SWAP.outScale;
        const cx = f.x + f.width / 2 - SWAP.outSlide * area.width, cy = f.y + f.height / 2;
        return {x: cx - w / 2, y: cy - h / 2, width: w, height: h, opacity: 0, tilt: -1};
    }

    _sendToCast(wins, {alreadyMinimized = false, kind = 'park', fromPose = null} = {}) {
        wins = wins.filter(win => this._eligible(win) && (!win.minimized || alreadyMinimized));
        if (!wins.length) {
            this._rebuildCast(true);
            return;
        }
        this._showRailForFlight();
        const flights = wins.map(win => {
            const previous = this._takeFlight(win);
            const snap = previous?.snap ?? takeSnapshot(win);
            if (snap)
                this._snapshots.set(win, snap);
            const from = fromPose ?? previous?.pose ?? (snap ? {...snap.frame, opacity: 255, tilt: 0} : null);
            this._ours.add(win);
            const actor = win.get_compositor_private();
            if (actor)
                this._skipEffect(actor);
            this._operations.quiet(win, 'minimize', () => win.minimize());
            // Minimized real actors no longer contribute pixels; resetting a
            // hidden interrupted incoming actor is safe and avoids stale opacity.
            if (actor)
                actor.opacity = 255;
            return {win, snap, from, speeds: previous?.speeds};
        });
        this._castKind = kind;
        this._rebuildCast(true, new Set(wins));
        this._castKind = null;
        // back windows first, so the front window's image is drawn on top
        for (const {win, snap, from, speeds} of [...flights].reverse()) {
            const item = this._groupOf(win, false)?.item;
            if (snap && kind === 'swap-out' && !item?.slots.has(win)) {
                this._startFlight(win, snap, from, this._outPose(snap), 'swap-out', speeds);
            } else if (snap && item?.slots.has(win)) {
                this._startFlight(win, snap, from, item.slotRect(win, snap.frame, true), kind === 'swap-out' ? 'park-swap' : 'park', speeds);
            } else {
                item?.setFlightHidden(win, false);
            }
        }
    }

    // Slot rectangles of `wins` in `group`'s rail item (windows beyond PILE_MAX use the back slot).
    _railRects(group, wins, settled = false) {
        const rects = new Map();
        const item = group.item;
        if (!item || item.destroyed)
            return rects;
        for (const win of wins) {
            const snap = this._snapshots.get(win);
            if (!snap)
                continue;
            const shown = item.slots.has(win);
            rects.set(win, item.slotRect(win, snap.frame, settled || !shown, shown ? null : PILE_MAX - 1));
        }
        return rects;
    }

    // `place`: window -> {x, y}, where a window dragged out of the rail was let go (it stays there,
    // at its own size). `dragged`: {wins, factor}: windows whose picture is already mid-growth.
    _bringIn(wins, fromRects, {place = null, dragged = null, overview = false} = {}) {
        wins = wins.filter(win => this._eligible(win) && this._ours.has(win));
        const count = wins.length;
        // back windows first, so the front window's image is drawn on top
        for (const win of [...wins].reverse()) {
            const previous = this._takeFlight(win);
            const snap = previous?.snap ?? this._snapshots.get(win);
            const actor = win.get_compositor_private();
            const from = previous?.pose ?? fromRects.get(win);
            this._ours.delete(win);
            this._userParked.delete(win);
            const claim = {};
            this._restoreClaims.set(win, claim);
            this._later(500, () => {
                if (this._restoreClaims.get(win) === claim)
                    this._restoreClaims.delete(win);
            });
            if (actor)
                this._skipEffect(actor);
            this._operations.quiet(win, 'unminimize', () => win.unminimize());
            const spot = place?.get(win);
            if (spot && win.move_frame)
                win.move_frame(true, Math.round(spot.x), Math.round(spot.y));
            // Vitre: a window that was only just opened (a launch: it showed up unfocused, was parked, then took focus) never
            // existed in the strip as far as the user is concerned. It appears where it is, instead of growing out of the strip.
            const fresh = win._vitreCreatedAt !== undefined && (GLib.get_monotonic_time() / 1000 - win._vitreCreatedAt) < 5000;
            if (overview && actor && snap && from) {
                // dropped on the overview's grid: the picture flies to the preview's slot, see overviewDrag.js (land)
                (this._ovLandings ??= []).push({win, snap, from, count});
            } else if (actor && snap && from && !fresh) {
                const mid = dragged?.wins.has(win);
                this._startFlight(win, snap, from, rectOf(win.get_frame_rect()), 'in', previous?.speeds,
                    {count, p0: mid ? 0 : SWAP.p0, factor: mid && win === dragged.lead ? dragged.factor : 1});
            } else {
                if (actor)
                    actor.opacity = 255;
                this._snapshots.delete(win);
            }
        }
    }

    // Every window of a group that arrived, in front of what was on the stage, most recent on
    // top (A16 items 3 and 7: a pile used to leave all but one window buried).
    _raiseGroup(wins, focusWin = null) {
        const live = wins.filter(w => this._eligible(w) && !w.minimized);
        const top = focusWin && live.includes(focusWin) ? focusWin : live[0];
        for (const w of [...live].reverse()) {
            if (w !== top)
                w.raise();
        }
        this._activate(top ?? focusWin);
    }

    _singleApp(group) {
        const apps = new Set(group.windows.map(w => this._appOf(w)));
        return apps.size === 1 ? [...apps][0] ?? null : null;
    }

    // One app split over two rail items (a window minimized or dragged out of its stage) is one
    // pile again once both are parked (A16 item 5).
    _mergeSplits() {
        const state = this._state();
        const keepers = new Map();
        for (const g of [...state.groups]) {
            if (g === state.stage || g === this._dragGroup || this._closing.has(g) ||
                !g.windows.length || !g.windows.every(w => this._ours.has(w) && w.minimized))
                continue;
            const app = this._singleApp(g);
            if (!app)
                continue;
            const other = keepers.get(app);
            if (!other) {
                keepers.set(app, g);
                continue;
            }
            const [a, b] = other.lastUsed >= g.lastUsed ? [other, g] : [g, other];
            a.windows = [...a.windows, ...b.windows.filter(w => !a.windows.includes(w))]
                .sort((x, y) => (usedAt.get(y) ?? 0) - (usedAt.get(x) ?? 0));
            state.groups = state.groups.filter(x => x !== b);
            keepers.set(app, a);
        }
    }

    _switchTo(group, {focusWin = null, addToStage = false, drag = null} = {}) {
        const state = this._state();
        if (!state.groups.includes(group) || !group.windows.some(w => this._eligible(w)))
            return;
        if (this._busy) {
            this._pendingSwitch = {group, options: {focusWin, addToStage, drag}};
            return;
        }
        return this._mutate(() => {
            const old = state.stage;
            if (focusWin && !this._eligible(focusWin))
                focusWin = null;
            // The rest of an app that is already on the stage joins it instead of swapping with it.
            if (!addToStage && old && old !== group) {
                const app = this._singleApp(old);
                if (app && app === this._singleApp(group))
                    addToStage = true;
            }
            const incoming = group.windows.filter(w => this._eligible(w) && this._ours.has(w));
            const fromRects = this._railRects(group, incoming);
            let dragged = null, place = null, overview = false;
            if (drag && incoming.length) {
                // A dragged pile arrives as a stack under its front window, which stays where it was let go.
                const lead = this._snapshots.get(incoming[0])?.frame;
                for (const win of incoming) {
                    const f = this._snapshots.get(win)?.frame;
                    fromRects.set(win, win === incoming[0] || !f || !lead ? drag.pose : {...drag.pose,
                        width: drag.pose.width * f.width / lead.width, height: drag.pose.height * f.height / lead.height});
                }
                if (drag.overview) {
                    overview = true;
                } else {
                    dragged = {wins: new Set(incoming), lead: incoming[0], factor: drag.factor};
                    place = new Map([[incoming[0], drag.place]]);
                }
            }
            this._showRailForFlight();
            if (addToStage && old && old !== group) {
                old.windows = [...group.windows.filter(w => this._eligible(w) && !old.windows.includes(w)), ...old.windows];
                state.groups = state.groups.filter(g => g !== group);
                this._bringIn(incoming, fromRects, {place, dragged, overview});
                old.touch(focusWin ?? incoming[0] ?? null);
                this._rebuildCast(true);
                this._raiseGroup(incoming, focusWin ?? incoming[0]);
                return;
            }
            // The old stage takes the place of the item that was used (A16 item 1).
            const slotKey = group.item ? group.lastUsed : null;
            state.stage = group;
            group.touch(focusWin);
            if (old && old !== group && slotKey !== null)
                old.lastUsed = slotKey;
            const active = global.workspace_manager.get_active_workspace();
            const outgoing = old && old !== group
                ? old.windows.filter(w => this._eligible(w) && !w.minimized && w.get_workspace() === active)
                : [];
            this._sendToCast(outgoing, {kind: 'swap-out'});
            this._bringIn(incoming, fromRects, {place, dragged, overview});
            const front = focusWin ?? group.windows.find(w => this._eligible(w) && !w.minimized) ?? incoming[0];
            this._raiseGroup(group.windows, front);
        });
    }

    _activate(win) {
        if (this._eligible(win) && !win.minimized)
            win.activate(global.get_current_time());
        this._queueOverlap();
    }

    // A window image in motion. kind:
    //   'in'        the window grows from where it was (rail slot, pointer) to its frame; ease-out
    //               sine, already `p0` of the way in the first painted frame (A16 item 1)
    //   'swap-out'  the old stage's window: shrinks to 0.62, slides toward the strip, turns its
    //               strip-side edge away and fades, gone in ~75 ms; never reaches the strip
    //   'park'      a window going into a rail slot (minimize, dragged back, adoption): 370 ms
    // `speeds` (from _takeFlight) continue an interrupted flight with the speed it had.
    // Vitre: the end of a flight is a small press, like a part clicking into place: the window overshoots by about 1 %
    // and settles. Short, and always cancelled by whatever moves the window next.
    _clickActor(actor, amount = SWAP.clickIn) {
        if (!motionEnabled() || !actor?.get_parent() || actor.is_finalized?.())
            return;
        const token = {};
        actor._vitreClick = token;
        actor.remove_transition('scale-x');
        actor.remove_transition('scale-y');
        // it presses from, and comes back to, the size it has (a window preview in the overview is lifted by 1.3 %)
        const base = {sx: actor.scale_x || 1, sy: actor.scale_y || 1, pivot: actor.get_pivot_point()};
        actor._vitreClickBase = base;
        actor.set_pivot_point(0.5, 0.5);
        const [out, back] = SWAP.clickMs;
        actor.ease({scale_x: base.sx * amount, scale_y: base.sy * amount, duration: realMs(out), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (actor._vitreClick !== token || actor.is_finalized?.())
                    return;
                actor.ease({scale_x: base.sx, scale_y: base.sy, duration: realMs(back), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onStopped: () => {
                        if (actor._vitreClick !== token || actor.is_finalized?.())
                            return;
                        actor._vitreClick = null;
                        actor._vitreClickBase = null;
                        actor.set_scale(base.sx, base.sy);
                        actor.set_pivot_point(base.pivot[0], base.pivot[1]);
                    }});
            }});
    }

    _cancelClick(actor) {
        if (!actor || !actor._vitreClick)
            return;
        const base = actor._vitreClickBase ?? {sx: 1, sy: 1, pivot: [0, 0]};
        actor._vitreClick = null;
        actor._vitreClickBase = null;
        actor.remove_transition('scale-x');
        actor.remove_transition('scale-y');
        actor.set_scale(base.sx, base.sy);
        actor.set_pivot_point(base.pivot[0], base.pivot[1]);
    }

    _startFlight(win, snap, from, target, kind, speeds = {}, {count = 1, p0 = SWAP.p0, factor = 1, onLanded = null} = {}) {
        if (this._flyLayerGone)
            return;
        this._cancelClick(win.get_compositor_private());
        const direction = kind === 'in' ? 'in' : 'out';
        const actor = win.get_compositor_private();
        if (!actor || !snap || !from)
            return;
        // the overview's own previews carry the windows (A1), except for the drops overviewDrag.js starts itself
        if (this._continuity && Main.overview.visible && !(this._railStays && this._ovFlightOK > 0)) {
            this._skipFlight(win, direction);
            return;
        }
        const interrupted = Object.keys(speeds).length > 0;
        const area = this._workArea();
        const frame = snap.frame;
        const fly = flyActor(win, snap, this._look, area.y + area.height / 2, {real: kind === 'swap-out'});
        if (kind === 'in')
            fly._geo.strength = SWAP.inKeystone / (1 - LOOK.farRatio);
        const lerp = (a, b, t) => a + (b - a) * t;
        // The first painted frame is not the start pose: the swap is already some way along in it.
        const t0 = interrupted ? 0 : kind === 'in' ? p0 : kind === 'swap-out' ? SWAP.outP0 : 0;
        const tTilt = interrupted ? 0 : kind === 'swap-out' ? SWAP.outTiltP0 : t0;
        const tOpacity = interrupted ? 0 : kind === 'swap-out' ? 0 : t0;
        const tgt = {opacity: 255, tilt: 0, ...target};
        const begin = {opacity: 255, tilt: 0, ...from};
        fly.set_position(lerp(begin.x, tgt.x, t0), lerp(begin.y, tgt.y, t0));
        fly.scale_z = 1 + lerp(begin.tilt, tgt.tilt, tTilt);
        fly.set_scale(lerp(begin.width, tgt.width, t0) / frame.width, lerp(begin.height, tgt.height, t0) / frame.height);
        fly.opacity = Math.round(lerp(begin.opacity, tgt.opacity, tOpacity));
        this._flyLayer.add_child(fly);
        const item = this._groupOf(win, false)?.item;
        // scale_z carries the tilt (1 + tilt), last, so the matrix is rebuilt from the final
        // values of the frame.
        const end = {x: tgt.x, y: tgt.y, scale_x: tgt.width / frame.width, scale_y: tgt.height / frame.height,
            scale_z: 1 + tgt.tilt, opacity: tgt.opacity};
        if (Math.abs(end.scale_z - fly.scale_z) < 1e-3)
            end.scale_z = fly.scale_z + 1e-3;     // always animate, so the matrix follows x and y
        const Mode = Clutter.AnimationMode;
        let geomPlan, fadePlan, tiltPlan;
        if (kind === 'in') {
            const ms = (count > 1 ? SWAP.inMsGroup : SWAP.inMs) * factor;
            geomPlan = fadePlan = tiltPlan = {ms, mode: Mode.EASE_OUT_SINE, v0: Math.PI / 2, profile: 'sine'};
        } else if (kind === 'swap-out') {
            geomPlan = {ms: SWAP.outGeomMs, mode: Mode.EASE_OUT_CUBIC, v0: 3, profile: 'cubic'};
            fadePlan = {ms: SWAP.outFadeMs, delay: SWAP.outFadeDelay, mode: Mode.LINEAR, v0: 1, profile: 'linear'};
            // the keystone starts gently and closes late (the reference design edge ratio 1.54, 1.76, 5.3 at +0, +17, +33 ms)
            tiltPlan = {ms: SWAP.outGeomMs, mode: Mode.EASE_IN_OUT_SINE, v0: 0, profile: 'inout'};
        } else {
            geomPlan = fadePlan = tiltPlan = {ms: SWAP.parkMs, mode: Mode.EASE_IN_OUT_SINE, v0: 0, profile: 'inout'};
        }
        const planOf = key => key === 'opacity' ? fadePlan : key === 'scale_z' ? tiltPlan : geomPlan;
        const motion = {};
        for (const [key, value] of Object.entries({x: end.x, y: end.y, scale_x: end.scale_x, scale_y: end.scale_y,
            scale_z: end.scale_z, opacity: end.opacity})) {
            const plan = planOf(key);
            const delta = value - fly[key];
            const effective = realMs(plan.ms) * St.Settings.get().slow_down_factor;
            // `profile`: the closed-form curve of a first flight (exact speed when it is interrupted);
            // a continued flight is a Hermite segment from the speed it inherited.
            motion[key] = {delta, duration: effective, profile: interrupted ? 'hermite' : plan.profile,
                velocity: speeds[key] ?? (effective ? plan.v0 * delta / effective : 0)};
        }
        const token = {fly, actor, snap, direction, kind, onLanded, ov: Boolean(Main.overview.visible), target: {...tgt}, started: GLib.get_monotonic_time(),
            duration: motion.x.duration, motion, timeline: null};
        this._flights.set(win, token);
        if (direction === 'in') {
            actor.opacity = 0;
            this._inFlight.set(actor, token);
        } else {
            this._outgoing.set(win, fly);
            item?.setFlightHidden(win, true);
        }
        const complete = () => {
            if (this._flights.get(win) !== token)
                return;
            if (fly._stageGone) {
                this._takeFlight(win);
                return;
            }
            // Publish the destination first. Both images coexist for this
            // synchronous handoff, so there is never an empty rendered frame.
            if (direction === 'out') {
                const landed = this._groupOf(win, false)?.item;
                landed?.setFlightHidden(win, false);
                if (kind === 'swap-out') {
                    landed?.land();
                } else {
                    landed?.setInert(false);
                    landed?.settle();       // the thumbnail clicks into its slot
                }
            } else if (actor.get_parent()) {
                actor.opacity = 255;
                if (!onLanded)
                    this._clickActor(actor);    // the window clicks into its place
            }
            if (direction === 'in' && onLanded) {
                try {
                    onLanded(win);          // in the overview the grid's own preview takes over and clicks into place
                } catch (e) {
                    console.warn(`Vitre Stage: landing failed (${e.message})`);
                }
            }
            this._flights.delete(win);
            this._outgoing.delete(win);
            if (this._inFlight.get(actor) === token)
                this._inFlight.delete(actor);
            if (direction === 'in' && !this._ours.has(win))
                this._snapshots.delete(win);
            fly.destroy();
            if (!this._flights.size)
                this._queueOverlap();
        };
        // Done when the geometry, the keystone and the fade (which may take longer) are all done.
        const fades = end.opacity !== fly.opacity;
        const splitTilt = tiltPlan !== geomPlan;
        let pending = 1 + (fades ? 1 : 0) + (splitTilt && !interrupted ? 1 : 0);
        const part = () => {
            if (--pending <= 0)
                complete();
        };
        const geom = {x: end.x, y: end.y, scale_x: end.scale_x, scale_y: end.scale_y};
        if (!splitTilt || interrupted)
            geom.scale_z = end.scale_z;
        let clock = null;
        if (interrupted) {
            // The image carries on from the pose it was painted in, with the speed it had, and arrives at rest
            // (a Hermite segment). Clutter.Transition.set_progress_func would do this, but the Shell here calls it
            // and ignores what it returns, so the image would stand still: a clock actor is eased 0 -> 1
            // instead and every frame the pose is computed from it.
            clock = new Clutter.Actor({x: 0, width: 1, height: 1, opacity: 0});
            fly.add_child(clock);
            // The picture moves by translation, not by x and y: a position change on a mapped St.Widget queues a
            // relayout on every frame (Clutter-WARNING "needs an allocation"); x and y stay where it started.
            const origin = {x: fly.x, y: fly.y};
            const curves = Object.keys(geom).map(key => {
                const value = motion[key];
                const from = fly[key];
                // Speed relative to the average one (an ease-out cubic starts at 3). The image coasts on the way it
                // was going before it turns toward the new target, but only by a little (`coast`, in the unit of
                // the property): a flight that was fast over 50 ms must not drag a 280 ms one far past its mark.
                const coast = COAST[key];
                const raw = value.duration && Math.abs(value.delta) > 1e-7 ? value.velocity * value.duration / value.delta : 0;
                const vn = Math.max(Math.abs(value.delta) > 1e-7 ? -Math.min(8, coast / (0.148 * Math.abs(value.delta))) : 0,
                    Math.min(5, raw));
                value.velocity = value.duration ? vn * value.delta / value.duration : 0;
                return {key, from, to: end[key], vn};
            });
            const step = u => {
                if (fly.is_finalized?.())
                    return;
                u = Math.min(1, Math.max(0, u));
                const hermite = (v) => 3 * u * u - 2 * u * u * u + v * u * (1 - u) * (1 - u);
                const geo = fly._geo;
                fly._geo = null;                // one matrix for the whole step
                for (const {key, from, to, vn} of curves) {
                    const value = u >= 1 ? to : from + (to - from) * hermite(vn);
                    if (key === 'x')
                        fly.translation_x = value - origin.x;
                    else if (key === 'y')
                        fly.translation_y = value - origin.y;
                    else
                        fly[key] = value;
                }
                fly._geo = geo;
                syncFlyTilt(fly);
            };
            clock.connect('notify::x', () => step(clock.x));
            clock.ease({x: 1, duration: realMs(geomPlan.ms), mode: Mode.LINEAR, onComplete: () => {
                step(1);
                part();
            }});
        } else {
            fly.ease({...geom, duration: realMs(geomPlan.ms), mode: geomPlan.mode, onComplete: part});
            if (splitTilt)
                fly.ease({scale_z: end.scale_z, duration: realMs(tiltPlan.ms), mode: tiltPlan.mode, onComplete: part});
        }
        if (fades)
            fly.ease({opacity: end.opacity, duration: realMs(fadePlan.ms), delay: realMs(fadePlan.delay ?? 0),
                mode: fadePlan.mode, onComplete: part});
        // GNOME adjusts native timeline duration by its global slow-down factor.
        // Sample that timeline rather than using the unadjusted requested time.
        if (this._flights.get(win) !== token)
            return;
        token.timeline = (interrupted ? [clock.get_transition('x')] :
            ['x', 'y', 'scale-x', 'scale-y', 'scale-z'].map(name => fly.get_transition(name))).find(Boolean) ?? null;
        for (const [key, value] of Object.entries(motion)) {
            const real = (interrupted && key !== 'opacity' ? clock.get_transition('x') :
                fly.get_transition(key.replaceAll('_', '-')))?.get_duration();
            if (real !== undefined)
                value.duration = real;
            if (!(key in speeds))
                value.velocity = value.duration ? planOf(key).v0 * value.delta / value.duration : 0;
        }
        token.duration = motion.x.duration;
        // Only a watchdog for an interrupted compositor callback; it does not
        // gate clicks, keyboard activation or the normal landing handoff.
        const longest = Math.max(...Object.entries(motion).map(([key, v]) =>
            v.duration + (key === 'opacity' ? fadePlan.delay ?? 0 : 0)));
        if (longest)
            this._later(longest + 160, complete);
    }

    // -- the overview (Vitre): the strip stays painted there and takes drops, see overviewDrag.js --

    // A rail drag cannot start or end in the overview unless the strip stays painted there (the piles stay on the left).
    _ovBlocks() {
        return (Main.overview.visible || this._overviewOpen) && !this._railStays;
    }

    // About the size a window has in the grid now, so a pile dragged out grows to what it is going to be.
    _ovDragScale() {
        const ratios = [];
        for (const p of gridWorkspace()?._windows ?? []) {
            const bb = p._cachedBoundingBox;
            const w = p.window_container?.get_transformed_size?.()[0];
            if (bb?.width && w)
                ratios.push(w / bb.width);
        }
        ratios.sort((a, b) => a - b);
        const mid = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0.5;
        return Math.min(0.7, Math.max(0.28, mid * 0.9));
    }

    // A pile let go on the grid: its windows join the stage and fly to their slots.
    _ovDropPile(group, pose) {
        this._ovLandings = [];
        this._switchTo(group, {addToStage: Boolean(this._state().stage), drag: {pose, place: null, factor: 1, overview: true}});
        const landings = this._ovLandings.splice(0);
        this._ovDrag?.land(landings);
    }

    // The overview is going away: whatever is still flying lands now.
    _ovSettle() {
        for (const [win, token] of [...this._flights]) {
            if (!token.ov)
                continue;
            this._settleWindow(win);
            this._ovDrag?.reveal(win, false);
        }
        this._ovLandings = [];
        this._invalidateRailDrags();
    }

    // Native DND owns the pointer grab and success cleanup. The drop target is
    // visible only during a rail drag and accepts through the normal delegate.
    _makeDropZone() {
        this._dropZone = new St.Widget({name: 'stageManagerDropZone', reactive: false, visible: false});
        this._dropZone._delegate = {
            handleDragOver: source => !this._disabled && !this._ovBlocks() &&
                source instanceof CastItem && source.manager === this && this._railDrag?.item === source
                ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE,
            acceptDrop: source => {
                const d = this._railDrag;
                if (this._disabled || this._ovBlocks() ||
                    !(source instanceof CastItem) || source.manager !== this || !d || d.item !== source ||
                    d.win.get_workspace() !== global.workspace_manager.get_active_workspace() ||
                    !this._eligible(d.win) || !this._ours.has(d.win) ||
                    !this._state().groups.includes(source.group))
                    return false;
                // The picture is already the window: it is let go where it is, at its own size.
                const pose = d.pose();
                const place = d.restRect();
                const factor = d.restFactor();
                const group = source.group;
                this._endRailDrag(d);
                if (Main.overview.visible) {
                    this._ovDropPile(group, pose);
                    return true;
                }
                // With an empty stage the window simply becomes the stage.
                this._switchTo(group, {addToStage: Boolean(this._state().stage), drag: {pose, place, factor}});
                return true;
            },
        };
        Main.layoutManager.uiGroup.add_child(this._dropZone);
    }

    _attachDrag(item) {
        item.manager = this;
        const draggable = DND.makeDraggable(item, {});
        draggable.connect('drag-begin', () => {
            // GNOME51 emits drag-begin before calling getDragActor. Validate the source
            // here; the drop delegate validates the created proxy separately.
            if (this._disabled || this._ovBlocks() ||
                (this._railDrag && this._railDrag.item !== item) || !this._state().groups.includes(item.group) ||
                !item.group.windows.some(w => this._eligible(w) && this._ours.has(w) &&
                    w.get_workspace() === global.workspace_manager.get_active_workspace()))
                return;
            const area = this._workArea();
            this._dropZone.set_position(area.x + this._look.stripWidth, area.y);
            this._dropZone.set_size(Math.max(0, area.width - this._look.stripWidth), area.height);
            this._dropZone.show();
            Main.layoutManager.uiGroup.set_child_above_sibling(this._dropZone, null);
        });
        draggable.connect('drag-end', () => {
            this._dropZone?.hide();
            if (this._railDrag?.item === item)
                this._cancelRailDrag();
        });
        draggable.connect('drag-cancelled', () => {
            this._dropZone?.hide();
            if (this._railDrag?.item === item)
                this._cancelRailDrag();
        });
        item.draggable = draggable;
    }

    // -- a rail item dragged onto the stage (A16 item 3) --
    //
    // From the first pixel the thing under the pointer is the window itself (a live image at the
    // thumbnail's pose) and the item has left the rail: the others re-centre in that same frame.
    // The window grows with the swap curve over time or with the distance travelled (whichever is
    // ahead: full size 120 px out), the pointer keeps its place in it, and wherever it is let go
    // it stays, at its own size, in front of the windows already there.
    createDragProxy(item) {
        const proxy = new Clutter.Actor({width: item.width, height: item.height, opacity: 0});
        // Native DND destroys the proxy when the drag ends; do not keep a dead reference for the item's own destroy handler.
        proxy.connect('destroy', () => {
            if (item._dragPreview === proxy)
                item._dragPreview = null;
        });
        const group = item.group;
        const win = group.windows.find(w => this._eligible(w) && this._ours.has(w));
        const snap = win && this._snapshots.get(win);
        if (!snap || this._railDrag || this._disabled || this._ovBlocks() ||
            win.get_workspace() !== global.workspace_manager.get_active_workspace() ||
            !this._state().groups.includes(group))
            return proxy;
        const area = this._workArea();
        const [px, py] = global.get_pointer();
        const press = [item.draggable?._dragStartX ?? px, item.draggable?._dragStartY ?? py];
        const thumb = item.slotRect(win, snap.frame);
        const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
        const fly = flyActor(win, snap, this._look, area.y + area.height / 2);
        Shell.util_set_hidden_from_pick(fly, true);
        // The picture follows the pointer through translation, not x/y: a position change on a mapped
        // actor queues a relayout on every motion event (Clutter-WARNING "needs an allocation").
        fly.set_position(thumb.x, thumb.y);
        this._flyLayer.add_child(fly);
        const grow = new Clutter.Actor({width: 1, height: 1, opacity: 0, x: SWAP.p0});
        grow.connect('destroy', () => {
            grow._stageGone = true;
        });
        this._flyLayer.add_child(grow);
        const frame = snap.frame;
        // in the overview the picture grows to about the size its preview will have in the grid, not to the window's own size
        const ovScale = Main.overview.visible ? this._ovDragScale() : 1;
        const fw = frame.width * ovScale, fh = frame.height * ovScale;
        const d = {item, group, win, snap, press, thumb, area, proxy, fly, grow, g: 0, fw, fh, origin: {x: thumb.x, y: thumb.y},
            fx: clamp((press[0] - thumb.x) / thumb.width, 0.1, 0.9),
            fy: clamp((press[1] - thumb.y) / thumb.height, 0.1, 0.9)};
        // where the window sits at full size with the pointer in the same place in it
        d.rest = () => {
            const [x, y] = global.get_pointer();
            return {
                x: clamp(x - d.fx * fw, area.x, Math.max(area.x, area.x + area.width - fw)),
                y: clamp(y - d.fy * fh, area.y, Math.max(area.y, area.y + area.height - fh)),
            };
        };
        d.pose = () => ({x: fly.x + fly.translation_x, y: fly.y + fly.translation_y, width: frame.width * fly.scale_x, height: frame.height * fly.scale_y,
            opacity: fly.opacity, tilt: flyTilt(fly)});
        d.restRect = () => d.rest();
        d.restFactor = () => Math.max(0, 1 - d.g);
        this._railDrag = d;
        proxy.connect('notify::x', () => this._updateRailDrag());
        proxy.connect('notify::y', () => this._updateRailDrag());
        grow.connect('notify::x', () => this._updateRailDrag());
        proxy.connect('destroy', () => {
            if (this._railDrag === d && !d.ended)
                this._cancelRailDrag();
        });
        if (motionEnabled())
            grow.ease({x: 1, duration: realMs(SWAP.inMs), mode: Clutter.AnimationMode.EASE_OUT_SINE});
        else
            grow.x = 1;
        // the item leaves the rail now
        this._dragGroup = group;
        for (const w of group.windows)
            item.setFlightHidden(w, true);
        this._rebuildCast(false);
        this._updateRailDrag();
        return proxy;
    }

    _updateRailDrag() {
        const d = this._railDrag;
        if (!d || d.ended || !d.fly || d.fly.is_finalized?.())
            return;
        const [px, py] = global.get_pointer();
        const dist = Math.hypot(px - d.press[0], py - d.press[1]);
        d.g = Math.min(1, Math.max(d.grow.x, Math.sin(Math.PI / 2 * Math.min(1, dist / SWAP.dragFullPx))));
        const {frame} = d.snap;
        const rest = d.rest();
        const lerp = (a, b, t) => a + (b - a) * t;
        const width = lerp(d.thumb.width, d.fw, d.g), height = lerp(d.thumb.height, d.fh, d.g);
        const x = lerp(d.thumb.x + px - d.press[0], rest.x, d.g), y = lerp(d.thumb.y + py - d.press[1], rest.y, d.g);
        const geo = d.fly._geo;
        d.fly._geo = null;                  // one matrix for the whole update
        d.fly.translation_x = x - d.origin.x;
        d.fly.translation_y = y - d.origin.y;
        d.fly.set_scale(width / frame.width, height / frame.height);
        d.fly.scale_z = 1 + (d.thumb.tilt ?? 1) * (1 - d.g);
        d.fly._geo = geo;
        syncFlyTilt(d.fly);
    }

    _endRailDrag(d) {
        d.ended = true;
        this._dropActor(d.grow);
        this._dropActor(d.fly);
        if (this._railDrag === d)
            this._railDrag = null;
        this._dragGroup = null;
    }

    // Let go over the rail or pressed Escape: the picture shrinks back into its slot, which opens again.
    _cancelRailDrag({immediate = false} = {}) {
        const d = this._railDrag;
        if (!d)
            return;
        d.ended = true;
        this._railDrag = null;
        this._dragGroup = null;
        this._dropActor(d.grow);
        const {group, win, snap, fly} = d;
        if (immediate || fly._stageGone || !this._tracked.has(win) || !this._state().groups.includes(group)) {
            this._dropActor(fly);
            if (!this._disabled)
                this._rebuildCast(!immediate);
            return;
        }
        this._rebuildCast(true, new Set(group.windows));
        const item = group.item;
        const back = item && item.slots.has(win) ? item.slotRect(win, snap.frame, true) : d.thumb;
        let finished = false;
        let timeoutId = 0;
        const cancellation = {win, group, finish: () => done(false)};
        const done = (settle = true) => {
            if (finished)
                return;
            finished = true;
            this._railDragCancellations.delete(cancellation);
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                this._timeouts.delete(timeoutId);
            }
            this._dropActor(fly);
            if (item && !item.destroyed) {
                for (const w of group.windows)
                    item.setFlightHidden(w, false);
                if (settle && !this._disabled)
                    item.settle();      // the thumbnail clicks back into its slot
            }
        };
        this._railDragCancellations.add(cancellation);
        fly.remove_all_transitions();
        // the translation becomes the position (one matrix for the whole change, painted where it was)
        const geo = fly._geo;
        fly._geo = null;
        fly.set_position(fly.x + fly.translation_x, fly.y + fly.translation_y);
        fly.translation_x = 0;
        fly.translation_y = 0;
        fly._geo = geo;
        syncFlyTilt(fly);
        fly.ease({
            x: back.x, y: back.y, scale_x: back.width / snap.frame.width, scale_y: back.height / snap.frame.height,
            scale_z: 1 + (back.tilt ?? 1), duration: realMs(200), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: done,
        });
        if (!finished)
            timeoutId = this._later(900, done);
    }

    // a fly-layer actor (a rail drag's picture or clock) is done: stop and destroy it unless it is gone already
    _dropActor(actor) {
        if (!actor || actor._stageGone)
            return;
        actor.remove_all_transitions();
        actor.destroy();
    }

    _invalidateRailDrags() {
        if (!this._tornDown())
            this._dropZone?.hide();
        this._draggedWindow = null;
        this._cancelRailDrag({immediate: true});
        for (const cancellation of [...this._railDragCancellations])
            cancellation.finish();
    }

    _hasRailDragFor(win) {
        return this._railDrag?.group.windows.includes(win) ||
            [...this._railDragCancellations].some(d => d.win === win || d.group.windows.includes(win));
    }

    _onGrabBegin(win, op) {
        this._draggedWindow = null;
        if (op !== Meta.GrabOp.MOVING || !this._eligible(win))
            return;
        const group = this._groupOf(win, false);
        if (group && this._state(win.get_workspace()).stage === group)
            this._draggedWindow = {win, frame: rectOf(win.get_frame_rect())};
    }

    _onGrabEnd(win) {
        const dragged = this._draggedWindow;
        this._draggedWindow = null;
        if (!dragged || dragged.win !== win || !this._eligible(win))
            return;
        const [x, y] = global.get_pointer();
        const area = this._workArea();
        const frame = rectOf(win.get_frame_rect());
        const changed = ['x', 'y', 'width', 'height'].some(key => frame[key] !== dragged.frame[key]);
        const stripWidth = this._look.stripWidth;
        const inRail = frame.x < area.x + stripWidth && frame.x + frame.width > area.x;
        if (changed && inRail && x >= area.x && x < area.x + stripWidth && y >= area.y && y < area.y + area.height)
            this._parkWindow(win, {user: false, restorePosition: dragged.frame});
    }

    // -- keyboard switchers (A16 items 4 and 6) --
    //
    // A switcher that ends on a window parked in the rail used to unminimize it and let the
    // minimize signal start the swap, 25-60 ms after the key was released. The swap now starts
    // from the switcher's own _finish, the frame it begins to close, through the same path as a
    // click on the rail. Super-` (switch-group) cycles the windows of the app that are on the stage.
    _installSwitcherHooks() {
        this._switcherInjections = new InjectionManager();
        const manager = this;
        for (const cls of [AltTab.AppSwitcherPopup, AltTab.WindowSwitcherPopup, AltTab.WindowCyclerPopup,
            AltTab.GroupCyclerPopup]) {
            if (!cls)
                continue;
            this._switcherInjections.overrideMethod(cls.prototype, '_finish', original => {
                const hook = function (...args) {
                    try {
                        manager._beforeSwitcherFinish(this);
                    } catch (error) {
                        console.warn(`Vitre Stage: switcher fast path failed: ${error.message}`);
                    }
                    return original.apply(this, args);
                };
                hook._stageHook = true;
                return hook;
            });
        }
        if (AltTab.AppSwitcherPopup) {
            this._switcherInjections.overrideMethod(AltTab.AppSwitcherPopup.prototype, '_initialSelection',
                original => function (backward, binding) {
                    try {
                        manager._trimGroupCycle(this, binding);
                    } catch (error) {
                        console.warn(`Vitre Stage: group cycle trim failed: ${error.message}`);
                    }
                    return original.call(this, backward, binding);
                });
        }
    }

    _removeSwitcherHooks() {
        this._switcherInjections?.clear();
        this._switcherInjections = null;
    }

    _switcherTarget(popup) {
        const it = popup._items?.[popup._selectedIndex];
        if (!it)
            return null;
        if (it.window)
            return it.window;
        if (it.app) {
            const n = popup._currentWindow;
            return it.cachedWindows?.[n >= 0 ? n : 0] ?? null;
        }
        return typeof it.get_window_type === 'function' ? it : null;
    }

    _beforeSwitcherFinish(popup) {
        if (this._disabled || Main.overview.visible)
            return;
        const win = this._switcherTarget(popup);
        if (win && this._ours.has(win) && win.minimized)
            this._activateStage(win);
    }

    _trimGroupCycle(popup, binding) {
        if (binding !== 'switch-group' && binding !== 'switch-group-backward')
            return;
        const icon = popup._items?.[0];
        if (!icon?.cachedWindows)
            return;
        const workspace = global.workspace_manager.get_active_workspace();
        const stageWindows = new Set(this._state(workspace).stage?.windows ?? []);
        const onStage = icon.cachedWindows.filter(w => stageWindows.has(w) &&
            this._eligible(w) && !w.minimized && w.get_workspace() === workspace);
        if (onStage.length && onStage.length < icon.cachedWindows.length)
            icon.cachedWindows = onStage;
    }

    // -- the strip --

    _castGroups() {
        const state = this._state();
        const area = this._workArea();
        const {gap, thumbHMax} = this._look;
        const fit = Math.max(1, Math.floor((0.9 * area.height + gap) / (thumbHMax + gap)));
        const max = Math.min(this._settings.get_int('max-groups'), fit);
        return state.groups
            .filter(g => g !== state.stage && g !== this._dragGroup &&
                g.windows.some(w => this._eligible(w) && this._ours.has(w)))
            .sort((a, b) => b.lastUsed - a.lastUsed)
            .slice(0, max);
    }

    _rebuildCast(animate, pending = new Set()) {
        if (this._stripGone)
            return;             // the shell is shutting down: the strip and its items are already destroyed
        this._mergeSplits();
        const groups = this._castGroups();
        const old = new Map(this._strip.get_children().filter(item => !item.leaving).map(item => [item.group, item]));
        const fresh = new Set();
        const items = groups.map(group => {
            const entries = group.windows.filter(w => this._eligible(w) && this._ours.has(w) && this._snapshots.has(w))
                .map(w => [w, this._snapshots.get(w)]);
            let item = old.get(group);
            if (item) {
                item.update(entries, this._look);
            } else {
                item = new CastItem(group, entries, this._look);
                item.connect('clicked', () => {
                    const event = Clutter.get_current_event();
                    const shift = event && (event.get_state() & Clutter.ModifierType.SHIFT_MASK);
                    this._switchTo(group, {addToStage: Boolean(shift)});
                });
                this._attachDrag(item);
                this._strip.add_child(item);
                // A pile that arrives without a window flying into it grows in.
                if (animate && entries.length && !entries.some(([w]) => pending.has(w) || this._outgoing.has(w)))
                    fresh.add(item);
                // The old stage's thumbnail takes no clicks until its ghost is gone and it has landed.
                if (this._castKind === 'swap-out' && entries.some(([w]) => pending.has(w))) {
                    item.setInert(true);
                    this._later(SWAP.parkMs + SWAP.clickMs[0] + SWAP.clickMs[1] + 900, () => {
                        if (!item.destroyed)
                            item.setInert(false);
                    });
                }
            }
            for (const [win] of entries)
                item.setFlightHidden(win, pending.has(win) || this._outgoing.has(win));
            return item;
        });
        const quiet = this._continuity && Main.overview.visible && !this._railStays;
        for (const [group, item] of old) {
            if (group === this._dragGroup)
                continue;           // the source of a drag in progress stays alive (hidden) until it ends
            if (!groups.includes(group)) {
                group.item = null;
                // A closed app's pile shrinks out; a pile that went to the stage is
                // replaced by the flying windows and just goes.
                if (this._closing.has(group) && this._stripShown && !quiet && motionEnabled())
                    item.leave();
                else
                    item.destroy();
            }
        }
        this._closing.clear();
        const area = this._workArea();
        const {margin, gap} = this._look;
        const total = items.reduce((sum, item) => sum + item._front.h, 0) + gap * Math.max(0, items.length - 1);
        let y = Math.max(0, Math.round((area.height - total) / 2));
        for (const item of items) {
            const itemX = margin - item._fan, itemY = y - item._rise;
            item.group.item = item;
            const sameTarget = item.targetX === itemX && item.targetY === itemY;
            const keepReflow = sameTarget && !quiet && motionEnabled() &&
                (item.get_transition('x') || item.get_transition('y'));
            item.targetX = itemX;
            item.targetY = itemY;
            if (!item._growing)
                item.opacity = 255;
            if (!keepReflow) {
                if (animate && old.has(item.group) && !quiet)
                    springTo(item, {x: itemX, y: itemY}, {response: CAST_RESPONSE});
                else {
                    item.remove_transition('x');
                    item.remove_transition('y');
                    item.set_position(itemX, itemY);
                }
            }
            if (fresh.has(item) && !quiet)
                item.growIn();
            y += item._front.h + gap;
        }
        this._applyOverviewMode();
        this._syncBadges();
        // Closing/merging/reordering a pile can change an in-flight target.
        // Retarget from its painted pose instead of landing at a stale location.
        for (const [win, token] of [...this._flights]) {
            const item = this._groupOf(win, false)?.item;
            if (token.kind !== 'park' || !item?.slots.has(win))
                continue;
            const target = item.slotRect(win, token.snap.frame, true);
            if (['x', 'y', 'width', 'height'].some(key => Math.abs(target[key] - token.target[key]) > 0.01)) {
                const previous = this._takeFlight(win);
                if (previous.pose)
                    this._startFlight(win, previous.snap, previous.pose, target, 'park', previous.speeds);
            }
        }
        this._queueOverlap();
    }

    // The work area as Stage has always seen it: the strip's column included. The strut that keeps maximized and tiled
    // windows beside the strip (see _reserve in enable) is added back, so every rail computation stays as it was.
    _workArea() {
        const index = Main.layoutManager.primaryIndex;
        const a = Main.layoutManager.getWorkAreaForMonitor(index);
        const mon = Main.layoutManager.monitors[index];
        const r = this._reserveWidth ?? 0;
        if (!r || !mon || a.x - mon.x < r - 1)
            return a;
        return {x: a.x - r, y: a.y, width: a.width + r, height: a.height};
    }

    _placeReserve() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!this._reserve || !mon)
            return;
        this._reserve.set_position(mon.x, mon.y);
        this._reserve.set_size(this._reserveWidth, mon.height);
    }

    _relayout() {
        if (this._stripGone)
            return;
        this._invalidateRailDrags();
        const area = this._workArea();
        this._look = currentLook = computeLook(area);
        if (this._reserve && this._look.stripWidth !== this._reserveWidth) {
            this._reserveWidth = this._look.stripWidth;
            this._placeReserve();
        }
        this._strip.set_position(area.x, area.y);
        this._strip.set_size(this._look.stripWidth, area.height);
        this._edge.set_position(area.x, area.y);
        this._edge.set_size(EDGE_TRIGGER_WIDTH, area.height);
        this._zone.set_position(area.x, area.y);
        this._zone.set_size(this._look.stripWidth + 8, area.height);
        this._rebuildCast(false);
    }

    _queueOverlap() {
        if (this._overlapQueued)
            return;
        this._overlapQueued = true;
        this._later(60, () => {
            this._overlapQueued = false;
            this._updateOverlap();
        });
    }

    // Any visible window on the primary display that reaches into the strip
    // column makes the strip step aside (stage windows, dialogs, PiP).
    _updateOverlap() {
        if (this._flights.size || this._stripGone)
            return;
        if (Main.overview.visible) {
            // With continuity the strip holds still while the overview is up;
            // 'hidden' re-evaluates it.
            if (!this._continuity)
                this._setStripVisible(false);
            return;
        }
        const area = this._workArea();
        const right = area.x + this._look.stripWidth;
        const active = global.workspace_manager.get_active_workspace();
        this._overlapped = global.display.list_all_windows().some(w => {
            if (w.minimized || !w.showing_on_its_workspace?.() || !this._onPrimary(w))
                return false;
            if (!w.is_on_all_workspaces() && w.get_workspace() !== active)
                return false;
            const type = w.get_window_type();
            if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
                return false;
            // Desktop-icon layers (e.g. DING) are full-screen skip-taskbar windows.
            if (w.is_skip_taskbar() && !w.get_transient_for())
                return false;
            const f = w.get_frame_rect();
            return f.x < right && f.x + f.width > area.x && f.y < area.y + area.height && f.y + f.height > area.y;
        });
        this._edge.reactive = this._overlapped;
        if (!this._overlapped)
            this._setStripVisible(true);
        else if (!this._pointerInStrip())
            this._setStripVisible(false);
        this._zone.reactive = this._overlapped && this._stripShown;
    }

    _pointerInStrip(x, y) {
        if (x === undefined)
            [x, y] = global.get_pointer();
        const area = this._workArea();
        return x >= area.x && x < area.x + this._look.stripWidth + 8 && y >= area.y && y < area.y + area.height;
    }

    // -- the strip over a covering window (A16 item 9) --
    //
    // the reference design: the pointer rests at the left edge ~0.32 s, then the strip slides in over the window
    // in 267 ms, its thumbnails turned further away while they move; the moment the pointer
    // leaves it, it is gone in a single frame.
    _edgeEntered() {
        if (Main.overview.visible || !this._overlapped || this._stripShown)
            return;
        this._cancelEdgeDwell();
        this._edgeDwellId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SWAP.revealDwellMs, () => {
            this._edgeDwellId = 0;
            this._revealStrip();
            return GLib.SOURCE_REMOVE;
        });
    }

    _edgeLeft() {
        this._cancelEdgeDwell();
    }

    _cancelEdgeDwell() {
        if (this._edgeDwellId) {
            GLib.source_remove(this._edgeDwellId);
            this._edgeDwellId = 0;
        }
    }

    _revealStrip() {
        if (Main.overview.visible || !this._overlapped)
            return;
        this._setStripVisible(true, {reveal: true});
        // Leaving the strip hides it at once. The strip itself is click-through, so a transparent
        // zone under it, as wide as the strip, sees the pointer leave.
        this._zone.reactive = true;
        this._startRevealWatch();
    }

    // The zone sees the pointer leave only if the pointer was over the zone itself. A thumbnail sits above
    // it, so a quick move from a thumbnail straight out of the strip never reaches the zone and the strip
    // would stay out. While it is out, check the pointer every 50 ms as a backstop.
    _startRevealWatch() {
        if (this._revealWatchId)
            return;
        this._revealWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._overlapped || !this._stripShown) {
                this._revealWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!this._dragGroup && !this._pointerInStrip()) {
                this._revealWatchId = 0;
                this._hideStripNow();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRevealWatch() {
        if (this._revealWatchId) {
            GLib.source_remove(this._revealWatchId);
            this._revealWatchId = 0;
        }
    }

    _hideStripNow() {
        this._cancelEdgeDwell();
        this._stopRevealWatch();
        this._zone.reactive = false;
        if (!this._stripShown)
            return;
        this._stripShown = false;
        this._strip.remove_all_transitions();
        this._strip.targetTranslationX = -this._look.stripWidth;
        this._strip.translation_x = this._strip.targetTranslationX;
        this._strip.opacity = 0;
    }

    _zoneLeft() {
        if (this._overlapped && this._stripShown && !this._dragGroup && !this._pointerInStrip())
            this._hideStripNow();
    }

    _syncRevealTilt() {
        if (this._stripGone)
            return;
        const hidden = Math.min(1, Math.max(0, -this._strip.translation_x / Math.max(1, this._look.stripWidth)));
        const boost = Math.round((1 + (SWAP.revealTilt - 1) * hidden) * 1000) / 1000;
        for (const item of this._strip.get_children())
            item.setTiltBoost?.(boost);
    }

    _setStripVisible(visible, {reveal = false} = {}) {
        if (!visible && this._flights.size && !Main.overview.visible)
            return;
        if (this._stripShown === visible)
            return;
        this._stripShown = visible;
        this._strip.targetTranslationX = visible ? 0 : -this._look.stripWidth;
        if (!visible && this._zone) {
            this._zone.reactive = false;
            this._stopRevealWatch();
        }
        if (reveal) {
            this._strip.remove_transition('translation-x');
            this._strip.remove_transition('opacity');
            this._strip.ease({translation_x: 0, opacity: 255, duration: realMs(SWAP.revealMs),
                mode: Clutter.AnimationMode.EASE_OUT_SINE});
            return;
        }
        springTo(this._strip, {
            translation_x: this._strip.targetTranslationX,
            opacity: visible ? 255 : 0,
        }, {response: STRIP_RESPONSE});
    }
}

// --- Quick Settings toggle -------------------------------------------------

const StageManagerToggle = GObject.registerClass(
class StageManagerToggle extends QuickToggle {
    _init(settings) {
        super._init({
            title: 'Vitre Stage',
            iconName: 'view-dual-symbolic',
            toggleMode: true,
        });
        settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
    }
});

const StageManagerIndicator = GObject.registerClass(
class StageManagerIndicator extends SystemIndicator {
    _init(settings) {
        super._init();
        this.quickSettingsItems.push(new StageManagerToggle(settings));
    }
});

export default class StageManagerExtension extends Extension {
    // Lets other consumers distinguish this loaded implementation from a
    // still-cached legacy module without toggling Stage or touching settings.
    get windowOperationsVersion() { return 2; }

    enable() {
        this._settings = this.getSettings();
        this._indicator = new StageManagerIndicator(this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        Main.wm.addKeybinding('toggle-stage-manager', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled')));

        this._settings.connectObject('changed::enabled', () => this._sync(), this);
        this._sync();
    }

    disable() {
        Main.wm.removeKeybinding('toggle-stage-manager');
        this._settings.disconnectObject(this);
        this._manager?.disable();
        this._manager = null;
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _sync() {
        const on = this._settings.get_boolean('enabled');
        if (on && !this._manager) {
            this._manager = new StageManager(this._settings);
            try {
                this._manager.enable();
            } catch (e) {
                console.error(`Vitre Stage failed to start: ${e.message}\n${e.stack}`);
                try {
                    this._manager.disable();
                } catch (_e) {}
                this._manager = null;
                this._settings.set_boolean('enabled', false);
            }
        } else if (!on && this._manager) {
            lockedState = null;
            this._manager.disable();
            this._manager = null;
        }
    }
}

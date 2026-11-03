// Vitre snap motion (2026-10-16; reworked 2026-10-22 on the fullscreen motion's model): a window that is tiled, maximized,
// restored, pulled out of its tile, sent to another monitor or made fullscreen flows from its old frame to its new one on the
// liquid.js glide spring (liquid v3, feel A Viscous; the trailing edges on glide x viscosity). Spring, clock and content handling
// are the ones of vitre-fullscreen-spaces' fullscreenMotion.js, so a snap and a fullscreen change move alike:
//
// - The motion starts with the key press or the click: the window grows or shrinks toward its new frame while it still shows
//   what it showed. Until the app has drawn its new size the window waits 90 % of the way, so a stretched old picture is never
//   what the motion lands on. When the app draws, a picture of the old content stays over the live window for 30-45 ms and
//   fades out over 100-130 ms (an enlarged old picture goes sooner). The new frame is known at once for maximize and
//   fullscreen (the work area, the monitor), for tiling-assistant's tiles (its own rectangles, read only) and for a restore
//   (the frame the window had before it was maximized). Otherwise (another monitor, mutter's own edge tiling) the window holds
//   still until the app has drawn, then moves.
// - Vitre Motion Lab 2: the window is carried, not scaled. Its position (x, y) is on the glide spring and leads, its size
//   (w, h) on the glide trail spring (response x viscosity), so it stretches a little with speed and relaxes on its own.
//   Every spring rests under a quarter pixel, so the motion ends on the new frame with the window untransformed.
// - A change while it still moves (snap again; tiling-assistant sends two or three for one key) turns from where the window is
//   drawn, with its speed. A window in the user's hand (a maximized or tiled window dragged out of place) follows the pointer
//   exactly while it returns to its own size on the glide spring (where mutter puts it under the pointer is its end).
// - The snap preview (GNOME's and tiling-assistant's tile preview) pours out of a 6 px sliver at the screen edge into the
//   tile on the pour spring (the far edge leads, the near edge trails on pour x viscosity) and drains back into it on the
//   pour exit spring (TilePour below).
// - The first frames after any change advance at most 17 ms each: a frame the shell holds right after a change (the app's new
//   buffer, a restack) slows the motion there instead of skipping ahead.
// - Reduced motion: no travel. The window holds until the app has drawn, then the new window fades in at its place under a
//   picture of the old one, which fades out (160 ms in all). Animations off: GNOME's own behaviour (one cut).
//
// How: Main.wm._prepareAnimationInfo, GNOME's size-change entry point (tiling-assistant calls it directly too), is taken over
// for normal windows, so GNOME's own size-change effect does nothing for them. The real window actor is scaled and moved so
// that its frame lies on the moving rectangle (only properties rounded-window-corners mirrors onto its shadow: scale,
// translation, pivot, opacity), and the pictures lie on the same rectangle right above it. Mutter's size-change accounting is
// completed once per change it counted: mutter emits kill-window-effects right before each size-change it counts, so a change
// handed over between the two is a counted one and a direct call is not. kill-window-effects also puts the window back
// untransformed at once (another effect may start on it right then); the motion carries on before the next frame unless the
// window is being minimized, hidden or destroyed. A counted change this hook did not see (the fullscreen motion or GNOME took
// it) ends this motion.
//
// Not taken: animations off, dialogs, windows another effect is animating. A hidden window (parked by Stage, minimized, on
// another workspace, or the overview is up) changes size with no motion. The overview, a workspace switch, a screen lock or a
// change of monitors end the motion at once.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WindowManager from 'resource:///org/gnome/shell/ui/windowManager.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {Plan, Spring, role, feel, REDUCED, EPS_PX, EPS_OPACITY} from './liquid.js';
import {Ticker, motionMode, animate, stopAnimate} from './liquidClock.js';

const SNAP = {
    // the motion: liquid.js 'glide': x and y on glide (they lead), w and h on glide trail; every spring rests under a
    // quarter pixel
    hold: 0.9,              // the app has not drawn its new size yet: the window waits this far along
    swapInMs: [45, 30],     // once it has drawn ([shrinking, growing]): the new content comes in under the old picture for this
                            // long, then the picture fades out on the fade role's exit spring; pictures of older states too
    near: 24,               // a drawn size this close to the expected frame is the frame (size steps, gaps)
    interimMs: 220,         // an in-between size with nothing after it is taken as the frame after this long
    waitMs: 1500,           // an app that never draws its new size is let go after this long (motion time)
    movedUs: 100000,        // a frame that only moved, with no known target, is taken as the target after this long (real)
    startTicks: 6,          // the first frames after a change advance at most capMs each: the shell's own work right
    capMs: 17,              // ... after a change can hold a frame; the motion slows there instead of skipping
    // reduced motion: the new window fades in at its place while the picture of the old one fades out, on the 160 ms spring
    staticWaitMs: 450,      // reduced motion: the longest the old frame is held for the app
    watchdogMs: 4000,       // nothing of this runs longer (real time)
};

// Rig only: VITRE_MOTION_SLOW=8 plays the motion 8 times slower, for filmstrips (as the rest of Vitre's motion).
const ENV_SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);
const slowNow = () => Math.max(1, Number(globalThis.__vitreMotionSlow) || ENV_SLOW);

const SPACES = 'vitre-fullscreen-spaces@vitre-desktop';

const clamp01 = v => Math.min(1, Math.max(0, v));

// ---- the spring (liquid.js Plans: the engine's spring as a function of motion time) -----------------------------------

// one channel of the moving rectangle (x, y, w or h): from `s` (at speed `u`, px per ms) to `g` on spring params `p`, from t0 (ms)
function makeEdge(s, g, u, t0, p = role('glide')) {
    const plan = new Plan({from: s, to: g, v0: u * 1000, p, eps: EPS_PX});
    return {s, g, u, t0, plan, end: plan.T * 1000, off: 0};
}

// `off`: a shift of the position (a window in the hand follows the pointer), added to the spring's own path
const edgeAt = (e, t) => e.plan.at(Math.max(0, t - e.t0) / 1000) + (e.off ?? 0);
// the edge's speed at t (px per ms), so a change that follows another within the same frame keeps the window's speed
const edgeSpeed = (e, t) => e.plan.vel(Math.max(0, t - e.t0) / 1000) / 1000;
const edgeDone = (e, t) => t - e.t0 >= e.end;

// a fade (0..1) as a function of motion time: from a0 to `to` on params p, starting `wait` ms after t0
function makeFade(a0, to, t0, p, wait = 0) {
    return {t0, wait, a0, plan: new Plan({from: a0, to, p, eps: EPS_OPACITY})};
}
const fadeAt = (f, t) => t - f.t0 < f.wait ? f.a0 : f.plan.at((t - f.t0 - f.wait) / 1000);
const fadeDone = (f, t) => t - f.t0 >= f.wait + f.plan.T * 1000;

// ---- geometry ---------------------------------------------------------------------------------------------------------

const rectOf = r => ({x: r.x, y: r.y, w: r.width, h: r.height});
const edgesOf = r => [r.x, r.y, r.x + r.w, r.y + r.h];
const fromEdges = ([l, t, r, b]) => ({x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t)});
const near = (a, b, eps = 1) => Boolean(a && b) && edgesOf(a).every((v, i) => Math.abs(v - edgesOf(b)[i]) <= eps);
const sameSize = (a, b, eps = 0.5) => Boolean(a && b) && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps;
// the moving rectangle's channels: position leads, size trails (Vitre Motion Lab 2)
const chOf = r => [r.x, r.y, r.w, r.h];
const fromCh = ([x, y, w, h]) => ({x, y, w: Math.max(1, w), h: Math.max(1, h)});
const lerpRect = (a, b, s) => fromEdges(edgesOf(a).map((v, i) => v + (edgesOf(b)[i] - v) * s));
const area = r => r.w * r.h;
const alive = a => Boolean(a) && a.get_stage?.() !== null;
const allocOf = a => ({x: a.x, y: a.y, w: a.width, h: a.height});
const shifted = (r, dx, dy) => r ? {...r, x: r.x + dx, y: r.y + dy} : r;

// a rectangle another extension keeps on a window (tiling-assistant's tiledRect / untiledRect), read only
function foreign(r) {
    try {
        const v = r ? {x: r.x, y: r.y, w: r.width, h: r.height} : null;
        return v && [v.x, v.y, v.w, v.h].every(Number.isFinite) && v.w > 0 && v.h > 0 ? v : null;
    } catch (_e) {
        return null;
    }
}

// ---- the snap preview: glass that pours out of the screen edge (Vitre Motion Lab 2, snap) ----------------------------------
// GNOME's TilePreview (windowManager.js) and tiling-assistant's subclass of it open and close with ease() on x, y, width,
// height and opacity. That ease is taken here (on the class GNOME exports, so tiling-assistant's previews inherit it): the
// preview keeps its look (the theme's .tile-preview) and its geometry moves on four edge springs. Opening, it starts as a
// SLIVER_PX sliver at the screen edge beside the tile and pours into the tile: the far edge (away from the screen edge) and
// the bottom on the pour spring, the near edge and the top on pour x viscosity (it stretches out of the edge and relaxes).
// Closing, it drains back into the sliver on the pour exit springs (never bouncing) and is hidden there. An open while it
// drains turns it round with its speed; a preview that moves to another tile flows there. Reduced motion: the preview is at
// the tile at once and cross-fades on the 160 ms spring. Animations off: GNOME's own ease (a cut). Any other ease of a
// preview (an opacity fade of tiling-assistant's layout previews) runs on the fade role's spring.
const SLIVER_PX = 6;
const TILE_KEYS = ['L', 'T', 'R', 'B'];

// the edge of the monitor the tile sits against: a tile across the whole width comes from the top or the bottom
function tileSide(r, mon, work) {
    if (r.w >= mon.w * 0.9)
        return r.y - work.y <= mon.y + mon.h - (r.y + r.h) ? 'top' : 'bottom';
    return r.x - mon.x <= mon.x + mon.w - (r.x + r.w) ? 'left' : 'right';
}

function sliverOf(side, r, mon, work) {
    switch (side) {
    case 'left':
        return {L: mon.x, T: r.y, R: mon.x + SLIVER_PX, B: r.y + r.h};
    case 'right':
        return {L: mon.x + mon.w - SLIVER_PX, T: r.y, R: mon.x + mon.w, B: r.y + r.h};
    case 'top':
        return {L: r.x, T: work.y, R: r.x + r.w, B: work.y + SLIVER_PX};
    default:
        return {L: r.x, T: mon.y + mon.h - SLIVER_PX, R: r.x + r.w, B: mon.y + mon.h};
    }
}

// which edges lead (pour) and which trail (pour x viscosity) for a tile against `side` (the lab: the bottom and the widths
// lead, the top and the edge at the source trail)
function tileLeads(side) {
    switch (side) {
    case 'left':
        return {L: false, T: false, R: true, B: true};
    case 'right':
        return {L: true, T: false, R: false, B: true};
    case 'top':
        return {L: true, T: false, R: true, B: true};
    default:
        return {L: true, T: true, R: true, B: false};
    }
}

class TilePour {
    // take(preview, params): an ease() call of a tile preview; true when taken (the caller runs GNOME's ease otherwise)
    take(preview, params) {
        const mode = motionMode();
        if (mode === 'off' || params.repeatCount || params.autoReverse)
            return false;
        const geo = ['x', 'y', 'width', 'height'].some(k => k in params);
        const st = preview._vitrePour ??= this._state(preview);
        if (!geo && params.opacity === 0 && st.springs && st.to && st.open && mode === 'full') {
            this._drain(preview, st, params);
            return true;
        }
        if (!geo || mode === 'reduced') {
            this._stop(st, false);
            st.open = geo;
            for (const [k, v] of Object.entries({x: params.x, y: params.y, width: params.width, height: params.height})) {
                if (v !== undefined)
                    preview[k] = v;
            }
            if (geo) {
                // (springs that exist are put where the preview is, so a later full-motion close drains from there)
                st.to = {L: preview.x, T: preview.y, R: preview.x + preview.width, B: preview.y + preview.height};
                if (st.springs)
                    this._snapTo(st, st.to);
            }
            if ('opacity' in params) {
                animate(preview, {opacity: params.opacity}, {fade: role('fade', {exit: params.opacity < preview.opacity}),
                    onDone: finished => {
                        params.onStopped?.(finished);
                        if (finished)
                            params.onComplete?.();
                    }});
            } else {
                params.onStopped?.(true);
                params.onComplete?.();
            }
            return true;
        }
        this._pour(preview, st, params);
        return true;
    }

    _state(preview) {
        const st = {springs: null, side: null, open: false, from: null, to: null, ticker: null, params: null};
        preview.connect('destroy', () => this._stop(st, false));
        return st;
    }

    _snapTo(st, g) {
        st.springs ??= Object.fromEntries(TILE_KEYS.map(k => [k, new Spring(g[k], role('pour'), EPS_PX)]));
        for (const k of TILE_KEYS)
            st.springs[k].snap(g[k]);
    }

    _geometry(preview, r) {
        const idx = preview._monitorIndex >= 0 ? preview._monitorIndex : global.display.get_current_monitor();
        const m = Main.layoutManager.monitors[idx] ?? Main.layoutManager.primaryMonitor;
        const mon = {x: m.x, y: m.y, w: m.width, h: m.height};
        const wa = Main.layoutManager.getWorkAreaForMonitor(m.index);
        const work = {x: wa.x, y: wa.y, w: wa.width, h: wa.height};
        const side = tileSide(r, mon, work);
        return {side, sliver: sliverOf(side, r, mon, work)};
    }

    // the preview opens (or moves) toward the tile in params
    _pour(preview, st, params) {
        const r = {x: params.x ?? preview.x, y: params.y ?? preview.y, w: params.width ?? preview.width, h: params.height ?? preview.height};
        const {side, sliver} = this._geometry(preview, r);
        // from the sliver, unless it is on screen (open, or draining into this same edge): then it turns or flows with its speed
        const visible = st.springs && preview.visible && (st.open || st.side === side) && st.ticker?.running !== false;
        this._stop(st, false);
        preview.remove_all_transitions();
        stopAnimate(preview);
        if (!visible || !st.springs)
            this._snapTo(st, sliver);
        st.side = side;
        st.open = true;
        st.params = params;
        preview.opacity = params.opacity ?? 255;       // the glass is there from the first frame, as a sliver
        const lead = role('pour'), trail = role('pour', {trail: true}), leads = tileLeads(side);
        const to = {L: r.x, T: r.y, R: r.x + r.w, B: r.y + r.h};
        for (const k of TILE_KEYS)
            st.springs[k].set(to[k], leads[k] ? lead : trail);
        st.from = this._now(st);
        st.to = to;
        this._run(preview, st, () => true);
    }

    // drains into its sliver on the exit springs, then GNOME's close finishes (hide, reset)
    _drain(preview, st, params) {
        const r = {x: st.to.L, y: st.to.T, w: st.to.R - st.to.L, h: st.to.B - st.to.T};
        const {sliver} = this._geometry(preview, r);
        const side = st.side;
        this._stop(st, false);
        preview.remove_all_transitions();
        st.open = false;
        st.params = params;
        const pe = role('pour', {exit: true});
        const trail = {r: pe.r * feel().visc, z: pe.z};
        const leads = tileLeads(side);
        for (const k of TILE_KEYS)
            st.springs[k].set(sliver[k], leads[k] ? pe : trail);
        st.from = this._now(st);
        st.to = sliver;
        // the lab hides the glass once it is 99 % home (the last of the sliver is under a pixel of travel)
        this._run(preview, st, () => this._progress(st) < 0.99);
    }

    _now(st) {
        return Object.fromEntries(TILE_KEYS.map(k => [k, st.springs[k].x]));
    }

    _progress(st) {
        let d0 = 0, d = 0;
        for (const k of TILE_KEYS) {
            d0 += Math.abs(st.to[k] - st.from[k]);
            d += Math.abs(st.to[k] - st.springs[k].x);
        }
        return d0 < 1e-6 ? 1 : 1 - d / d0;
    }

    _apply(preview, st) {
        const {L, T, R, B} = this._now(st);
        preview.set_position(L, T);
        preview.set_size(Math.max(1, R - L), Math.max(1, B - T));
    }

    _run(preview, st, more) {
        const params = st.params;
        this._apply(preview, st);
        const ticker = st.ticker = new Ticker(dt => {
            if (st.ticker !== ticker)
                return false;
            for (const k of TILE_KEYS)
                st.springs[k].step(dt);
            this._apply(preview, st);
            if (TILE_KEYS.some(k => !st.springs[k].rest) && more())
                return true;
            st.ticker = null;
            if (!st.open) {
                preview.opacity = 0;
                st.springs = null;     // drained: the next open starts from a sliver
            }
            st.params = null;
            params.onStopped?.(true);
            params.onComplete?.();
            return false;
        }, {actor: preview});
        ticker.start();
    }

    // stops the motion where it is; the call it ran for ends not finished (as a removed transition)
    _stop(st, finished) {
        const t = st.ticker, params = st.params;
        st.ticker = null;
        st.params = null;
        t?.stop();
        if (t && params)
            params.onStopped?.(finished);
    }
}

export class SnapMotion {
    constructor(owner) {
        this._owner = owner;    // the extension: _note() for the rig's decision log
    }

    enable() {
        this._entries = new Map();      // window actor -> motion
        this._memo = new WeakMap();     // window -> {max: its frame before it was maximized, fs: before fullscreen}
        this._grab = null;              // the window a move grab is on
        this._counted = null;           // {actor, entry, us}: a size-change emission mutter counts is under way
        this._trace = null;
        this._injections = new InjectionManager();
        const self = this;
        // the snap preview pours out of the screen edge (GNOME's TilePreview; tiling-assistant's previews inherit this)
        const pour = this._pour = new TilePour();
        if (WindowManager.TilePreview?.prototype) {
            this._injections.overrideMethod(WindowManager.TilePreview.prototype, 'ease', original => function (params) {
                let mine = false;
                try {
                    mine = pour.take(this, params);
                } catch (e) {
                    console.warn(`Vitre snap preview: left to GNOME (${e.message})`);
                }
                if (!mine)
                    original.call(this, params);
            });
        }
        this._injections.overrideMethod(Main.wm, '_prepareAnimationInfo', original => function (shellwm, actor, oldFrameRect, change) {
            let mine = false;
            try {
                mine = self._prepare(shellwm, actor, oldFrameRect, change);
            } catch (e) {
                console.warn(`Vitre snap motion: left to GNOME (${e.message})`);
                self._bail(actor);
            }
            if (!mine)
                original.call(this, shellwm, actor, oldFrameRect, change);
        });
        const wm = global.window_manager;
        const d = global.display;
        this._signals = [
            // after GNOME's own handlers (they find nothing to animate for windows taken here)
            [wm, wm.connect('size-change', (_wm, actor, which) => this._guard(() => this._onSizeChange(actor, which)))],
            [wm, wm.connect('size-changed', (_wm, actor) => this._guard(() => this._onSizeChanged(actor)))],
            [wm, wm.connect('kill-window-effects', (_wm, actor) => this._guard(() => this._onKill(actor)))],
            [d, d.connect('grab-op-begin', (_d, win, op) => this._guard(() => this._onGrab(win, op)))],
            [d, d.connect('grab-op-end', (_d, win) => this._guard(() => this._onGrabEnd(win)))],
            [d, d.connect('restacked', () => this._guard(() => this._restack()))],
            // the overview and workspace switches draw windows through their own clones: windows are let go untransformed
            [Main.overview, Main.overview.connect('showing', () => this._guard(() => this._finishAll('overview')))],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed',
                () => this._guard(() => this._finishAll('workspace')))],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._guard(() => this._finishAll('monitors')))],
            [Main.sessionMode, Main.sessionMode.connect('updated', () => this._guard(() => {
                if (Main.sessionMode.isLocked)
                    this._finishAll('locked');
            }))],
        ];
    }

    disable() {
        this._finishAll('disabled');
        this._injections?.clear();
        this._injections = null;
        for (const [obj, id] of this._signals ?? []) {
            try {
                obj.disconnect(id);
            } catch (_e) { /* gone at shutdown */ }
        }
        this._signals = null;
        this._stopClock();
        this._entries = null;
        this._memo = null;
        this._counted = null;
        this._grab = null;
        this._trace = null;
    }

    _guard(fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`Vitre snap motion: ${e.message}`);
        }
    }

    _note(actor, what) {
        this._owner._note?.(actor, 'snap', what);
    }

    _now() {
        return GLib.get_monotonic_time() / 1000 / slowNow();
    }

    // ---- taking a change ---------------------------------------------------------------------------------------------

    // 'motion', 'fade' (reduced motion), 'cut' (animations off: held until the app has drawn, then shown at once), 'still'
    // (taken with no motion: GNOME would fly a picture of a window nobody sees) or 'gnome:<why>'
    _decide(actor, oldFrameRect, change, old) {
        const win = actor?.meta_window;
        if (!win)
            return 'gnome:no-window';
        const st = St.Settings.get();
        if (Main.wm._getAnimationWindowType(actor) !== Meta.WindowType.NORMAL || win.is_attached_dialog())
            return 'gnome:type';
        // hidden: parked by Stage, minimized, on another workspace, the overview is up, the screen is locked
        if (!actor.visible || !actor.mapped || win.minimized || !Main.wm._shouldAnimate() || Main.sessionMode.isLocked)
            return 'still';
        if (oldFrameRect.width <= 0 || oldFrameRect.height <= 0)
            return 'gnome:no-frame';
        // another effect is animating it
        if (Main.wm._mapping?.has(actor) || Main.wm._minimizing?.has(actor) || Main.wm._unminimizing?.has(actor) ||
            Main.wm._destroying?.has(actor))
            return 'gnome:effect';
        // someone else made it see-through (our own reduced-motion fade is ours)
        if (actor.opacity !== 255 && !old?.opSet)
            return `gnome:opacity-${actor.opacity}`;
        if (!actor.get_texture?.())
            return 'gnome:no-texture';
        // animations off: held until the app has drawn, then one cut (as GNOME does, with its accounting kept whole when
        // tiling-assistant calls in directly)
        if (!st.enable_animations)
            return 'cut';
        // fullscreen belongs to Fullscreen Spaces while it is on (its own motion takes it first; set to 'native', the
        // owner chose GNOME's)
        if ((change === Meta.SizeChange.FULLSCREEN || change === Meta.SizeChange.UNFULLSCREEN) &&
            Main.extensionManager.lookup(SPACES)?.state === ExtensionState.ACTIVE)
            return 'gnome:spaces';
        return st.reducedMotion === St.ReducedMotion.REDUCE ? 'fade' : 'motion';
    }

    _prepare(shellwm, actor, oldFrameRect, change) {
        if (!this._entries)
            return false;
        let old = this._entries.get(actor) ?? null;
        const decision = this._decide(actor, oldFrameRect, change, old);
        if (decision.startsWith('gnome')) {
            if (old)
                this._finish(old, 'gnome');
            this._note(actor, `${decision}:${change}`);
            return false;
        }
        // inside a size-change emission of this window (kill-window-effects came right before): mutter counted this change
        const counted = this._counted?.actor === actor && GLib.get_monotonic_time() - this._counted.us < 50000;
        // a change of kind starts afresh
        if (old && (decision === 'still' || old.mode !== decision)) {
            this._finish(old, 'restart');
            old = null;
        }
        let e;
        if (decision === 'still') {
            e = this._still(actor);
            this._note(actor, `still:${change}`);
        } else if (old && decision === 'motion') {
            e = old;
            this._turn(e, change, counted, rectOf(oldFrameRect));
            this._note(actor, `again:${change}${e.expect ? '' : '?'}`);
        } else if (old) {
            // a fade or a cut goes on (tiling-assistant's later steps of one tile)
            e = old;
            this._again(e, change, counted);
            this._note(actor, `again:${change}`);
        } else {
            e = this._begin(actor, decision, change, counted, rectOf(oldFrameRect));
            this._note(actor, `${decision === 'motion' ? 'prepare' : decision}:${change}${e.expect || decision !== 'motion' ? '' : '?'}`);
        }
        e.change = change;
        if (this._counted?.actor === actor)
            this._counted.entry = e;
        return true;
    }

    _still(actor) {
        const e = {actor, win: actor.meta_window, mode: 'still', pics: [], owed: 0, frozen: false, killed: false, killLater: 0,
            pivotSet: null, opSet: false, destroyId: 0};
        e.destroyId = actor.connect('destroy', () => this._drop(actor));
        this._entries.set(actor, e);
        this._startClock();
        return e;
    }

    _begin(actor, mode, change, counted, from) {
        const win = actor.meta_window;
        const now = this._now();
        const e = {actor, win, mode, change, from, target: null, final: null, expect: null, edges: null, started: false,
            frozen: false, mapF: null, mapB: null, pics: [], interimAt: null, owed: 0, which: -1, killed: false, killLater: 0,
            pivot0: actor.pivot_point, pivotSet: null, opSet: false, held: this._grab === win, ptr: null,
            lastF: rectOf(win.get_frame_rect()), movedUs: 0, changeAt: now, us0: GLib.get_monotonic_time(), ticks: 0, lag: 0,
            lastR: from, lastReal: now, mt: now, fadeAt: null, destroyId: 0, moveId: 0, closeId: 0};
        if (e.held)
            e.ptr = this._pointer();
        e.edges = chOf(from).map(v => makeEdge(v, v, 0, now));
        this._remember(e, change, from, counted);
        this._freeze(e);
        e.destroyId = actor.connect('destroy', () => this._drop(actor));
        // the actor follows its window's new position right after this signal: the motion goes with it in the same frame
        e.moveId = win.connect('position-changed', () => this._guard(() => this._onMoved(e)));
        // closing: mutter starts the close effect without kill-window-effects, so the window is let go before it begins
        e.closeId = win.connect('unmanaging', () => this._guard(() => this._finish(e, 'closing')));
        this._entries.set(actor, e);
        e.expect = this._predict(e, change, counted);
        // it is already where it goes (a later step of a tile that has landed): nothing to hold or move
        if (e.expect && near(e.expect, from, 0.5) && sameSize(e.expect, rectOf(win.get_frame_rect()))) {
            this._finish(e, 'in-place');
            return e;
        }
        if (mode === 'motion') {
            e.final = e.expect;
            this._aim(e, now, true);
            this._apply(e, now);
        }
        this._startClock();
        return e;
    }

    // another change of a held fade or cut: it goes on (no new hold over a fade that already runs)
    _again(e, change, counted) {
        if (e.killLater) {
            global.compositor.get_laters().remove(e.killLater);
            e.killLater = 0;
        }
        e.killed = false;
        this._complete(e);
        e.us0 = GLib.get_monotonic_time();
        e.expect = this._predict(e, change, counted) ?? e.expect;
        if (e.fadeAt !== null && e.opSet && alive(e.actor))
            e.actor.opacity = Math.round(255 * this._fadeIn(e, e.mt));
    }

    // a change while the motion runs: turn from where the window is drawn, with its speed
    _turn(e, change, counted, oldFrame) {
        const now = e.mt;           // the motion's time as last drawn (a change can come between two frames, or before the first)
        if (e.killLater) {
            global.compositor.get_laters().remove(e.killLater);
            e.killLater = 0;
        }
        e.killed = false;
        this._complete(e);          // the change before, if mutter counted it, is over
        e.ticks = Math.min(e.ticks, 1);
        e.changeAt = now;
        e.us0 = GLib.get_monotonic_time();
        const held = this._grab === e.win;
        if (held && !e.held)
            e.ptr = this._pointer();
        e.held = held;
        e.interimAt = null;
        e.movedUs = 0;
        this._remember(e, change, oldFrame, counted);
        this._freeze(e);            // hold what it shows until the app has drawn this change
        e.from = this._rectAt(e, now);
        e.expect = this._predict(e, change, counted);
        // unknown target: it keeps heading where it went until the app shows where it goes
        e.final = e.expect;
        this._aim(e, now, true);
        this._apply(e, now);
    }

    // Where the window goes, when that is known before the app draws it.
    _predict(e, change, counted) {
        const win = e.win;
        if (e.held)
            return null;            // in the user's hand: where mutter puts it under the pointer
        const C = Meta.SizeChange;
        const mon = win.get_monitor();
        const memo = this._memo.get(win) ?? {};
        switch (change) {
        case C.FULLSCREEN:
            return rectOf(global.display.get_monitor_geometry(mon));
        case C.UNFULLSCREEN:
            return memo.fs ? {...memo.fs} : null;
        case C.MAXIMIZE:
            if (counted && win.get_maximize_flags?.() === Meta.MaximizeFlags.BOTH)
                return rectOf(win.get_work_area_for_monitor(mon));
            // tiling-assistant's tile (its own rectangle); mutter's own edge tiling: not known
            return foreign(win.tiledRect);
        case C.UNMAXIMIZE:
            // the frame it had right before a plain maximize (mutter's restore), else tiling-assistant's restore frame (it
            // moves the window there itself after unmaximizing it)
            return counted && memo.max ? {...memo.max} : foreign(win.untiledRect);
        default:
            return null;
        }
    }

    // The frames a later restore goes back to. Mutter keeps its own restore frame across tiles and maximizes, so the frame
    // before a maximize is only known when that maximize came straight from a floating window; any other change forgets it.
    _remember(e, change, from, counted) {
        const C = Meta.SizeChange;
        const m = this._memo.get(e.win) ?? {};
        if (change === C.FULLSCREEN)
            m.fs = {...from};
        if (change !== C.UNMAXIMIZE && change !== C.FULLSCREEN && change !== C.UNFULLSCREEN) {
            const work = rectOf(e.win.get_work_area_for_monitor(e.win.get_monitor()));
            // a floating frame (one that does not fill the work area's height)
            const floating = !(Math.abs(from.y - work.y) <= 1 && Math.abs(from.y + from.h - work.y - work.h) <= 1);
            m.max = change === C.MAXIMIZE && counted && floating && e.win.get_maximize_flags?.() === Meta.MaximizeFlags.BOTH
                ? {...from} : null;
        }
        this._memo.set(e.win, m);
    }

    // Right after GNOME's size-change handler: when it handed the change to _prepare in this same emission, mutter counted
    // it and expects one completion for it. When someone else took it (the fullscreen motion, GNOME), this motion ends.
    _onSizeChange(actor, which) {
        const c = this._counted;
        this._counted = null;
        if (!c || c.actor !== actor || GLib.get_monotonic_time() - c.us > 50000)
            return;
        const e = this._entries?.get(actor);
        if (c.entry) {
            if (e === c.entry) {
                e.owed = 1;
                e.which = which;
                if (e.mode === 'still')
                    this._finish(e, 'still');
            } else {
                // already let go in this same emission: its completion is still due
                global.window_manager.completed_size_change(actor);
            }
        } else if (e) {
            this._finish(e, 'taken');
        }
    }

    // ---- the app draws ------------------------------------------------------------------------------------------------

    _onSizeChanged(actor) {
        const e = this._entries?.get(actor);
        if (!e || e.mode === 'still')
            return;
        const F = rectOf(e.win.get_frame_rect());
        const B = rectOf(e.win.get_buffer_rect());
        if (e.frozen) {
            if (sameSize(F, e.mapF) && sameSize(B, e.mapB)) {
                // the same size, only moved (tiling-assistant moves first, then resizes): not the app's new size
                this._heldMove(e, F, e.mt);
                return;
            }
            this._commit(e, e.mt, true);
            return;
        }
        if (e.mode !== 'motion')
            return;
        this._track(e, e.mt);
        this._aim(e, e.mt);
        if (!e.killed)
            this._apply(e, e.mt);
    }

    // The app has drawn (or the window only moved): a picture of what the held window showed lies over it while it takes its
    // new buffer, and the motion heads for the frame it really has now.
    _commit(e, now, resized) {
        const F = rectOf(e.win.get_frame_rect());
        const grow = area(F) >= area(e.mapF);
        // (reduced motion always: the old window fades out where it was; a cut shows the new state at once)
        if ((resized && e.mode === 'motion') || e.mode === 'fade')
            this._picture(e, now, grow);
        this._thaw(e);
        if (e.mode === 'cut') {
            this._note(e.actor, 'commit');
            this._finish(e, 'cut');
            return;
        }
        e.lastF = F;
        e.movedUs = 0;
        e.ticks = Math.min(e.ticks, 1);   // the first paint of a new buffer can hold a frame
        this._note(e.actor, 'commit');
        if (e.mode === 'fade') {
            this._fadeStart(e, now);
            return;
        }
        if (e.expect && !near(F, e.expect, SNAP.near)) {
            // an in-between size (tiling-assistant's steps): shown, and held again for the next one
            this._freeze(e);
            e.interimAt = now;
        } else {
            e.interimAt = null;
        }
        e.final = e.interimAt === null ? F : e.expect;
        this._aim(e, now);
        if (!e.killed)
            this._apply(e, now);
    }

    // a picture of what the held window shows, over the window, on the same rectangle
    _picture(e, now, grow) {
        const B = e.mapB;
        const box = {x: Math.round(B.x), y: Math.round(B.y), w: Math.round(B.w), h: Math.round(B.h)};
        this._identity(e);          // paint_to_content draws the actor as it is on the stage
        let content = null;
        try {
            content = e.actor.paint_to_content(new Mtk.Rectangle({x: box.x, y: box.y, width: box.w, height: box.h}));
        } catch (_err) {
            content = null;
        }
        if (!content)
            return false;
        for (const p of e.pics) {
            p.a0 = this._picAlpha(p, now);
            p.t0 = now;
            p.kind = 'old';
            p.fade = makeFade(p.a0, 0, now, role('fade', {exit: true}));
        }
        const actor = new St.Widget({content, x: box.x, y: box.y, width: box.w, height: box.h, reactive: false});
        global.window_group.insert_child_above(actor, e.actor);
        const k = grow ? 1 : 0;
        const kind = e.mode === 'fade' ? 'fade' : 'main';
        e.pics.push({actor, F: {...e.mapF}, B: box, kind, t0: now, a0: 1,
            fade: kind === 'fade' ? makeFade(1, 0, now, REDUCED) : makeFade(1, 0, now, role('fade', {exit: true}), SNAP.swapInMs[k])});
        return true;
    }

    _picAlpha(p, now) {
        return fadeDone(p.fade, now) ? 0 : fadeAt(p.fade, now);
    }

    // ---- the motion ----------------------------------------------------------------------------------------------------

    _rectAt(e, now) {
        return fromCh(e.edges.map(edge => edgeAt(edge, now)));
    }

    // Where the window heads now: its frame once the app has drawn it, the hold point short of it before, or (nothing known)
    // where it was going.
    _aim(e, now, fresh = false) {
        let target = e.target ?? e.from;
        if (e.final) {
            // held for a size the app has not drawn yet: wait short of it
            const waiting = e.frozen && !(sameSize(e.mapF, e.final) && near(e.mapF, e.final, 0.5));
            target = waiting ? lerpRect(e.from, e.final, SNAP.hold) : e.final;
        }
        if (!fresh && e.target && near(target, e.target, 0.01))
            return;
        const at = e.edges.map(edge => edgeAt(edge, now));
        const u = e.edges.map(edge => edgeSpeed(edge, now));
        const to = chOf(target);
        const most = Math.max(...to.map((v, i) => Math.abs(v - at[i])));
        // position on glide (it leads), size on glide trail (it follows on viscosity: the window is carried, not scaled); every
        // channel keeps its speed. In the user's hand the size comes back on glide itself (the window returns to its own size
        // under the finger)
        const lead = role('glide');
        const trail = e.held ? lead : role('glide', {trail: true});
        e.edges = e.edges.map((_edge, i) => makeEdge(at[i], to[i], u[i], now, i < 2 ? lead : trail));
        e.target = target;
        if (!e.started && most > 0.5) {
            e.started = true;
            this._note(e.actor, `start:${Math.round(most)}`);
        }
    }

    // Follow the window's real frame. In the user's hand the whole motion goes with the pointer at once, and only what is left
    // of the size change eases (where mutter or tiling-assistant puts the window under the pointer is a new end, reached
    // smoothly). Otherwise, after the app has drawn, a new frame is a new end, reached keeping place and speed.
    _track(e, now) {
        if (e.held) {
            const p = this._pointer();
            if (e.ptr && (p.x !== e.ptr.x || p.y !== e.ptr.y))
                this._shift(e, p.x - e.ptr.x, p.y - e.ptr.y);
            e.ptr = p;
        }
        const F = rectOf(e.win.get_frame_rect());
        const last = e.lastF ?? F;
        e.lastF = F;
        const moved = !near(F, last, 0.01);
        if (e.frozen) {
            if (sameSize(F, e.mapF))
                this._heldMove(e, F, now);
            // an in-between size with nothing after it: that is the frame
            if (e.frozen && e.interimAt !== null && now - e.interimAt > SNAP.interimMs) {
                this._thaw(e);
                e.interimAt = null;
                e.final = rectOf(e.win.get_frame_rect());
                e.lastF = e.final;
            }
            return;
        }
        if (moved)
            e.final = F;
    }

    // Held, and the frame only moved: straight onto its known frame there is nothing to wait for; with no known frame it is
    // a move-only change after a moment; otherwise the new size is still to come.
    _heldMove(e, F, now) {
        if (e.held || near(F, e.mapF, 0.5))
            return;
        if (e.expect && e.interimAt === null && near(F, e.expect, 1)) {
            this._commit(e, now, false);
        } else if (!e.expect) {
            e.movedUs ||= GLib.get_monotonic_time();
            if (GLib.get_monotonic_time() - e.movedUs > SNAP.movedUs)
                this._commit(e, now, e.mode === 'fade');
        }
    }

    _pointer() {
        const [x, y] = global.get_pointer();
        return {x, y};
    }

    // the window moved (the actor takes its new place right after this signal)
    _onMoved(e) {
        if (this._entries?.get(e.actor) !== e || e.mode !== 'motion' || e.killed)
            return;
        this._track(e, e.mt);
        this._aim(e, e.mt);
        this._apply(e, e.mt);
    }

    // the whole motion moves with the window's frame (a window in the user's hand)
    _shift(e, dx, dy) {
        e.edges = e.edges.map((edge, i) => {
            const d = i === 0 ? dx : i === 1 ? dy : 0;      // the size does not move with the hand
            return {...edge, s: edge.s + d, g: edge.g + d, off: (edge.off ?? 0) + d};
        });
        e.target = shifted(e.target, dx, dy);
        e.final = shifted(e.final, dx, dy);
        e.expect = shifted(e.expect, dx, dy);
        e.from = shifted(e.from, dx, dy);
    }

    // still fine to draw this window ourselves
    _safe(e) {
        const a = e.actor, win = e.win;
        if (!alive(a))
            return false;
        const here = win.is_on_all_workspaces() || win.get_workspace() === global.workspace_manager.get_active_workspace();
        return here && a.visible && a.mapped && !win.minimized && (e.mode !== 'motion' || a.opacity === 255) &&
            (e.mode === 'cut' || St.Settings.get().enable_animations) && Main.wm._shouldAnimate() && !Main.sessionMode.isLocked &&
            !Main.wm._mapping?.has(a) && !Main.wm._minimizing?.has(a) && !Main.wm._unminimizing?.has(a) &&
            !Main.wm._destroying?.has(a);
    }

    _step(e, now) {
        if (GLib.get_monotonic_time() - e.us0 > SNAP.watchdogMs * 1000 * slowNow())
            return this._finish(e, 'watchdog');
        if (!this._safe(e))
            return this._finish(e, 'unsafe');
        if (e.mode === 'fade' || e.mode === 'cut')
            return this._stepFade(e, now);
        // the app never drew its new size (nothing known about it: a short wait; a known frame or a window in the hand,
        // where a new size is surely coming: a slow app gets longer)
        if (e.frozen && now - e.changeAt > (e.expect || e.final || e.held ? SNAP.waitMs : SNAP.staticWaitMs)) {
            this._note(e.actor, 'give-up');
            this._thaw(e);
            e.interimAt = null;
            e.expect = null;
            e.final = rectOf(e.win.get_frame_rect());
            e.lastF = e.final;
        }
        this._track(e, now);
        this._aim(e, now);
        this._apply(e, now);
        if (this._landed(e, now))
            this._finish(e, 'done');
    }

    _landed(e, now) {
        if (!e.final || !e.target || !near(e.target, e.final, 0.01) || e.pics.length)
            return false;
        // held, it shows what it shows on its final frame (an in-between size that stayed): fine to land
        if (e.frozen && !(e.interimAt === null && sameSize(e.mapF, e.final) && near(e.mapF, e.final, 0.5)))
            return false;
        return e.edges.every(edge => edgeDone(edge, now));
    }

    // Put the window's frame, and every picture's frame, on the moving rectangle.
    _apply(e, now) {
        const a = e.actor;
        if (!alive(a))
            return;
        const R = this._rectAt(e, now);
        const F = e.frozen ? e.mapF : rectOf(e.win.get_frame_rect());
        const B = e.frozen ? e.mapB : rectOf(e.win.get_buffer_rect());
        // the pivot where rounded-window-corners' shadow (which copies our scale and pivot) has the same point as the window
        let px = 0, py = 0;
        const sh = a.rwcCustomData?.shadow;
        if (sh?.visible && sh.width > a.width && sh.height > a.height) {
            px = (a.x - sh.x) / (sh.width - a.width);
            py = (a.y - sh.y) / (sh.height - a.height);
        }
        if (!e.pivotSet || e.pivotSet[0] !== px || e.pivotSet[1] !== py) {
            a.set_pivot_point(px, py);
            e.pivotSet = [px, py];
        }
        const sx = R.w / F.w, sy = R.h / F.h;
        const Px = px * B.w, Py = py * B.h;
        a.set_scale(sx, sy);
        // relative to the buffer's place: the actor is there, or takes it right after a move signal (held, it stays put)
        a.translation_x = R.x - B.x - Px - sx * (F.x - B.x - Px);
        a.translation_y = R.y - B.y - Py - sy * (F.y - B.y - Py);
        e.pics = e.pics.filter(p => {
            const alpha = this._picAlpha(p, now);
            if (alpha <= 0 && fadeDone(p.fade, now)) {
                p.actor.destroy();
                return false;
            }
            const qx = R.w / p.F.w, qy = R.h / p.F.h;
            p.actor.set_scale(qx, qy);
            p.actor.translation_x = R.x - p.B.x - qx * (p.F.x - p.B.x);
            p.actor.translation_y = R.y - p.B.y - qy * (p.F.y - p.B.y);
            p.actor.opacity = Math.round(255 * alpha);
            return true;
        });
        e.lastR = R;
        if (this._trace)
            this._trace.push({t: now, R, pics: e.pics.map(p => p.actor.opacity), frozen: e.frozen});
    }

    // ---- reduced motion: hold, then a fade in place (animations off: hold, then one cut) ---------------------------------

    // reduced motion: the window's own fade in at its place (the 160 ms spring)
    _fadeIn(e, now) {
        e.fadeIn ??= makeFade(0, 1, e.fadeAt, REDUCED);
        return fadeAt(e.fadeIn, now);
    }

    _fadeStart(e, now) {
        e.fadeAt = now;
        e.fadeIn = makeFade(0, 1, now, REDUCED);
        if (alive(e.actor)) {
            e.actor.opacity = 0;
            e.opSet = true;
        }
    }

    _stepFade(e, now) {
        if (e.fadeAt === null) {
            const waited = (GLib.get_monotonic_time() - e.us0) / 1000 / slowNow();
            if (waited > SNAP.staticWaitMs)
                return this._finish(e, `${e.mode}-wait`);
            const F = rectOf(e.win.get_frame_rect());
            if (e.frozen && sameSize(F, e.mapF))
                this._heldMove(e, F, now);
            return;
        }
        e.actor.opacity = Math.round(255 * this._fadeIn(e, now));
        e.opSet = true;
        e.pics = e.pics.filter(p => {
            const alpha = this._picAlpha(p, now);
            if (alpha <= 0) {
                p.actor.destroy();
                return false;
            }
            p.actor.opacity = Math.round(255 * alpha);
            return true;
        });
        if (this._trace)
            this._trace.push({t: now, R: rectOf(e.win.get_frame_rect()), pics: e.pics.map(p => p.actor.opacity), live: e.actor.opacity});
        if (fadeDone(e.fadeIn, now) && e.pics.every(p => fadeDone(p.fade, now)))
            this._finish(e, 'faded');
    }

    // ---- other effects, the user's hand ---------------------------------------------------------------------------------

    // kill-window-effects: mutter is about to start another effect on this window (a size change follows at once when it is
    // snapped again; a minimize, a close), or the window goes away
    _onKill(actor) {
        this._counted = {actor, entry: null, us: GLib.get_monotonic_time()};
        const e = this._entries?.get(actor);
        if (!e)
            return;
        this._complete(e);
        if (e.mode === 'still')
            return;
        // another effect may start right now: it must find the window untransformed and opaque
        this._identity(e);
        if (e.opSet && alive(actor))
            actor.opacity = 255;
        e.opSet = false;
        e.killed = true;
        if (!e.killLater) {
            e.killLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                e.killLater = 0;
                this._guard(() => this._afterKill(e));
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _afterKill(e) {
        if (this._entries?.get(e.actor) !== e || !e.killed)
            return;
        const a = e.actor;
        if (!alive(a) || e.win.minimized || !a.visible || Main.wm._minimizing?.has(a) || Main.wm._unminimizing?.has(a) ||
            Main.wm._mapping?.has(a) || Main.wm._destroying?.has(a)) {
            this._finish(e, 'killed');
            return;
        }
        // nothing else started: carry on from where it was drawn
        e.killed = false;
        if (e.mode === 'fade' && e.fadeAt !== null) {
            a.opacity = Math.round(255 * this._fadeIn(e, e.mt));
            e.opSet = true;
        } else if (e.mode === 'motion') {
            this._apply(e, e.mt);
        }
    }

    _onGrab(win, op) {
        // a move with the pointer (without mutter's 'unconstrained' flag); a keyboard move steps, and each step is a new end
        if ((op & ~1024) !== Meta.GrabOp.MOVING)
            return;
        this._grab = win;
        // taken in hand mid-flight: it follows the pointer from here while its size keeps easing
        const e = this._entries?.get(win?.get_compositor_private());
        if (e?.mode === 'motion') {
            e.held = true;
            e.ptr = this._pointer();
        }
    }

    _onGrabEnd(win) {
        if (!win || this._grab === win)
            this._grab = null;
        const e = win ? this._entries?.get(win.get_compositor_private()) : null;
        if (e)
            e.held = false;
    }

    // pictures stay right above their window when the stacking changes
    _restack() {
        for (const e of this._entries?.values() ?? []) {
            if (!alive(e.actor) || e.actor.get_parent() !== global.window_group)
                continue;
            for (const p of e.pics) {
                if (p.actor.get_parent() === global.window_group)
                    global.window_group.set_child_above_sibling(p.actor, e.actor);
            }
        }
    }

    // ---- ending ---------------------------------------------------------------------------------------------------------

    _identity(e) {
        const a = e.actor;
        if (!e.pivotSet || !alive(a))
            return;
        // another effect owns the window now: its transitions are not to be cut (it puts the window right itself)
        if (Main.wm._destroying?.has(a) || Main.wm._minimizing?.has(a) || Main.wm._unminimizing?.has(a) || Main.wm._mapping?.has(a)) {
            e.pivotSet = null;
            return;
        }
        a.set_scale(1, 1);
        a.translation_x = 0;
        a.translation_y = 0;
        a.set_pivot_point(e.pivot0.x, e.pivot0.y);
        e.pivotSet = null;
    }

    // hold what the window shows now until the app has drawn the size this change is going to
    _freeze(e) {
        if (e.frozen || !alive(e.actor))
            return;
        e.mapF = rectOf(e.win.get_frame_rect());
        e.mapB = allocOf(e.actor);
        e.actor.freeze();
        e.frozen = true;
    }

    _thaw(e) {
        if (!e.frozen)
            return;
        e.frozen = false;
        if (alive(e.actor))
            e.actor.thaw();
    }

    _complete(e) {
        if (e.owed) {
            e.owed = 0;
            if (alive(e.actor))
                global.window_manager.completed_size_change(e.actor);
        }
    }

    _finish(e, why = '') {
        if (this._entries?.get(e.actor) !== e)
            return;
        this._entries.delete(e.actor);
        if (e.killLater) {
            global.compositor.get_laters().remove(e.killLater);
            e.killLater = 0;
        }
        this._identity(e);
        if (e.opSet && alive(e.actor))
            e.actor.opacity = 255;
        e.opSet = false;
        for (const p of e.pics)
            p.actor.destroy();
        e.pics = [];
        this._thaw(e);
        this._complete(e);
        if (e.destroyId && alive(e.actor))
            e.actor.disconnect(e.destroyId);
        e.destroyId = 0;
        for (const id of [e.moveId, e.closeId]) {
            try {
                if (id)
                    e.win.disconnect(id);
            } catch (_err) { /* gone */ }
        }
        e.moveId = e.closeId = 0;
        if (e.mode !== 'still')
            this._note(e.actor, `end:${why}`);
        if (!this._entries.size)
            this._stopClock();
    }

    // _prepare failed: GNOME takes this change over, with its accounting; nothing of ours stays on the window (an earlier
    // change it was still owed is completed)
    _bail(actor) {
        if (this._counted?.actor === actor)
            this._counted.entry = null;
        const e = this._entries?.get(actor);
        if (e)
            this._finish(e, 'error');
    }

    // the window actor is being destroyed: forget it (mutter has killed its effects first)
    _drop(actor) {
        const e = this._entries?.get(actor);
        if (!e)
            return;
        e.owed = 0;
        e.frozen = false;
        e.pivotSet = null;
        e.opSet = false;
        this._finish(e, 'destroyed');
    }

    _finishAll(why) {
        for (const e of [...this._entries?.values() ?? []])
            this._finish(e, why);
    }

    // ---- the clock (one tick per frame; time from the wall clock, as the fullscreen motion) --------------------------------

    _startClock() {
        if (this._timeline)
            return;
        const tl = new Clutter.Timeline({duration: 3600000, actor: Main.layoutManager.uiGroup});
        tl.connect('new-frame', () => this._guard(() => this._tick()));
        this._timeline = tl;
        tl.start();
    }

    _stopClock() {
        const tl = this._timeline;
        this._timeline = null;
        tl?.stop();
    }

    // the motion's own clock: real time, except that its first frame shows the start and the next few frames after any change
    // advance at most capMs each (a frame the shell held right after the change slows the motion instead of skipping it)
    _advance(e, real) {
        const dt = real - e.lastReal;
        e.lastReal = real;
        e.ticks++;
        if (e.ticks === 1)
            e.lag += dt;
        else if (e.ticks <= SNAP.startTicks && dt > SNAP.capMs)
            e.lag += dt - SNAP.capMs;
        e.mt = real - e.lag;
        return e.mt;
    }

    _tick() {
        const real = this._now();
        for (const e of [...this._entries?.values() ?? []]) {
            try {
                if (e.mode === 'still') {
                    this._finish(e, 'still');
                    continue;
                }
                if (e.killed)
                    continue;       // decided before the next frame (_afterKill)
                this._step(e, this._advance(e, real));
            } catch (err) {
                console.warn(`Vitre snap motion: let go (${err.message})`);
                this._finish(e, 'error');
            }
        }
        if (!this._entries?.size)
            this._stopClock();
    }

    // ---- rig ------------------------------------------------------------------------------------------------------------

    // the moving rectangle per frame while set
    traceOn(on) {
        this._trace = on ? [] : null;
    }

    takeTrace() {
        const t = this._trace ?? [];
        if (this._trace)
            this._trace = [];
        return t;
    }

    state() {
        return [...this._entries?.values() ?? []].map(e => ({title: e.win.get_title(), mode: e.mode, frozen: e.frozen,
            held: e.held, killed: e.killed, owed: e.owed, interim: e.interimAt !== null, final: e.final ?? null,
            target: e.target ?? null, pics: e.pics.map(p => ({kind: p.kind, opacity: p.actor.opacity}))}));
    }
}

// Vitre snap motion (2026-10-16; reworked 2026-10-22 on the fullscreen motion's model): a window that is tiled, maximized,
// restored, pulled out of its tile, sent to another monitor or made fullscreen flows from its old frame to its new one on the
// Vitre stretch spring (vitre-menus dripMotion.js STRETCH: period 400 ms, damping 0.86). Spring, clock and content handling
// are the ones of vitre-fullscreen-spaces' fullscreenMotion.js, so a snap and a fullscreen change move alike:
//
// - The motion starts with the key press or the click: the window grows or shrinks toward its new frame while it still shows
//   what it showed. Until the app has drawn its new size the window waits 90 % of the way, so a stretched old picture is never
//   what the motion lands on. When the app draws, a picture of the old content stays over the live window for 30-45 ms and
//   fades out over 100-130 ms (an enlarged old picture goes sooner). The new frame is known at once for maximize and
//   fullscreen (the work area, the monitor), for tiling-assistant's tiles (its own rectangles, read only) and for a restore
//   (the frame the window had before it was maximized). Otherwise (another monitor, mutter's own edge tiling) the window holds
//   still until the app has drawn, then moves.
// - The edge that travels furthest leads, the others follow by up to 34 ms; the last 80 ms of every edge ease exactly onto the
//   new frame, so the motion ends on whole pixels with the window untransformed: no step when the real window takes over.
// - A change while it still moves (snap again; tiling-assistant sends two or three for one key) turns from where the window is
//   drawn, with its speed. A window in the user's hand (a maximized or tiled window dragged out of place) follows the pointer
//   exactly while its size eases to the new one.
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
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const SNAP = {
    responseMs: 400,        // the Vitre stretch spring: period (ms) ...                     } as fullscreenMotion.js
    damping: 0.86,          // ... and damping ratio                                          }
    lagMs: 34,              // the edge that moves least follows the edge that moves most by this much
    settle: 0.004,          // an edge is done when it stays within this share of its travel ...
    landMs: 80,             // ... and its last 80 ms ease exactly onto the target
    hold: 0.9,              // the app has not drawn its new size yet: the window waits this far along
    swapInMs: [45, 30],     // once it has drawn ([shrinking, growing]): the new content comes in under the old picture ...
    swapOutMs: [130, 100],  // ... then the picture fades out (an enlarged old picture goes sooner)
    refadeMs: 140,          // pictures of older states (a change before) fade out over this long
    near: 24,               // a drawn size this close to the expected frame is the frame (size steps, gaps)
    interimMs: 220,         // an in-between size with nothing after it is taken as the frame after this long
    waitMs: 1500,           // an app that never draws its new size is let go after this long (motion time)
    movedUs: 100000,        // a frame that only moved, with no known target, is taken as the target after this long (real)
    startTicks: 6,          // the first frames after a change advance at most capMs each: the shell's own work right
    capMs: 17,              // ... after a change can hold a frame; the motion slows there instead of skipping
    fadeInMs: 80,           // reduced motion: the new window fades in at its place over this long ...
    fadeFromMs: 60,         // ... while the picture of the old one fades out from here ...
    fadeMs: 160,            // ... to here
    staticWaitMs: 450,      // reduced motion: the longest the old frame is held for the app
    watchdogMs: 4000,       // nothing of this runs longer (real time)
};

// Rig only: VITRE_MOTION_SLOW=8 plays the motion 8 times slower, for filmstrips (as the rest of Vitre's motion).
const ENV_SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);
const slowNow = () => Math.max(1, Number(globalThis.__vitreMotionSlow) || ENV_SLOW);

const SPACES = 'vitre-fullscreen-spaces@vitre-desktop';

const clamp01 = v => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, v) => {
    const s = clamp01((v - a) / (b - a));
    return s * s * (3 - 2 * s);
};

// ---- the spring (the same as fullscreenMotion.js) ----------------------------------------------------------------------

const W0 = 2 * Math.PI / SNAP.responseMs;      // rad per ms
const ZW = SNAP.damping * W0;
const WD = W0 * Math.sqrt(1 - SNAP.damping * SNAP.damping);

// displacement from the target `tau` ms after a start at displacement `a` with speed `u` (px per ms) ...
function springDisp(a, u, tau) {
    if (tau <= 0)
        return a;
    const b = (u + ZW * a) / WD;
    return Math.exp(-ZW * tau) * (a * Math.cos(WD * tau) + b * Math.sin(WD * tau));
}

// ... and the speed then
function springSpeed(a, u, tau) {
    if (tau < 0)
        return 0;
    const b = (u + ZW * a) / WD;
    return Math.exp(-ZW * tau) * ((b * WD - ZW * a) * Math.cos(WD * tau) - (a * WD + ZW * b) * Math.sin(WD * tau));
}

let _settleMs = 0;
function settleMs() {
    if (!_settleMs) {
        let last = 0;
        for (let t = 0; t <= 3000; t++) {
            if (Math.abs(springDisp(1, 0, t)) > SNAP.settle)
                last = t;
        }
        _settleMs = last + 1;
    }
    return _settleMs;
}

// one edge of the moving rectangle: from `s` (at speed `u`) to `g`, starting `lag` ms after `t0`; exactly `g` from t0 + end on
const makeEdge = (s, g, u, t0, lag) => ({s, g, u, t0, lag, end: lag + settleMs()});

function edgeAt(e, t) {
    const local = t - e.t0;
    if (local >= e.end)
        return e.g;
    const x = e.g + springDisp(e.s - e.g, e.u, local - e.lag);
    return x + (e.g - x) * smoothstep(e.end - SNAP.landMs, e.end, local);
}

// the edge's speed at t (px per ms), exact, so a change that follows another within the same frame keeps the window's speed
function edgeSpeed(e, t) {
    const local = t - e.t0;
    const x = e.g + springDisp(e.s - e.g, e.u, local - e.lag);
    const v = springSpeed(e.s - e.g, e.u, local - e.lag);
    const a = e.end - SNAP.landMs;
    const k = clamp01((local - a) / SNAP.landMs);
    const land = k * k * (3 - 2 * k);
    const dLand = k > 0 && k < 1 ? 6 * k * (1 - k) / SNAP.landMs : 0;
    return v * (1 - land) + (e.g - x) * dLand;
}

const edgeDone = (e, t) => t - e.t0 >= e.end;

// ---- geometry ---------------------------------------------------------------------------------------------------------

const rectOf = r => ({x: r.x, y: r.y, w: r.width, h: r.height});
const edgesOf = r => [r.x, r.y, r.x + r.w, r.y + r.h];
const fromEdges = ([l, t, r, b]) => ({x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t)});
const near = (a, b, eps = 1) => Boolean(a && b) && edgesOf(a).every((v, i) => Math.abs(v - edgesOf(b)[i]) <= eps);
const sameSize = (a, b, eps = 0.5) => Boolean(a && b) && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps;
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
        e.edges = edgesOf(from).map(v => makeEdge(v, v, 0, now, 0));
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
            e.actor.opacity = Math.round(255 * smoothstep(0, SNAP.fadeInMs, e.mt - e.fadeAt));
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
        }
        const actor = new St.Widget({content, x: box.x, y: box.y, width: box.w, height: box.h, reactive: false});
        global.window_group.insert_child_above(actor, e.actor);
        const k = grow ? 1 : 0;
        e.pics.push({actor, F: {...e.mapF}, B: box, kind: e.mode === 'fade' ? 'fade' : 'main', t0: now, a0: 1,
            inMs: SNAP.swapInMs[k], outMs: SNAP.swapOutMs[k]});
        return true;
    }

    _picAlpha(p, now) {
        if (p.kind === 'old')
            return p.a0 * (1 - smoothstep(0, SNAP.refadeMs, now - p.t0));
        if (p.kind === 'fade')
            return 1 - smoothstep(SNAP.fadeFromMs, SNAP.fadeMs, now - p.t0);
        return 1 - smoothstep(p.inMs, p.inMs + p.outMs, now - p.t0);
    }

    // ---- the motion ----------------------------------------------------------------------------------------------------

    _rectAt(e, now) {
        return fromEdges(e.edges.map(edge => edgeAt(edge, now)));
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
        const to = edgesOf(target);
        const travel = at.map((v, i) => Math.abs(to[i] - v));
        const most = Math.max(...travel);
        const still = u.every(v => Math.abs(v) < 0.02);
        // from rest, the edge that travels least follows the one that travels most; on the move, every edge keeps its speed;
        // in the user's hand, all edges together (the pointer keeps its place on the window)
        e.edges = e.edges.map((_edge, i) => makeEdge(at[i], to[i], u[i], now,
            (fresh || still) && !e.held && most > 0.5 && Math.abs(u[i]) < 0.02 ? SNAP.lagMs * (1 - travel[i] / most) : 0));
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
            const d = i % 2 ? dy : dx;
            return {...edge, s: edge.s + d, g: edge.g + d};
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
            if (alpha <= 0 && now - p.t0 > p.inMs) {
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

    _fadeStart(e, now) {
        e.fadeAt = now;
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
        const k = now - e.fadeAt;
        e.actor.opacity = Math.round(255 * smoothstep(0, SNAP.fadeInMs, k));
        e.opSet = true;
        e.pics = e.pics.filter(p => {
            const alpha = this._picAlpha(p, now);
            if (alpha <= 0 && k > SNAP.fadeFromMs) {
                p.actor.destroy();
                return false;
            }
            p.actor.opacity = Math.round(255 * alpha);
            return true;
        });
        if (this._trace)
            this._trace.push({t: now, R: rectOf(e.win.get_frame_rect()), pics: e.pics.map(p => p.actor.opacity), live: e.actor.opacity});
        if (k >= SNAP.fadeMs)
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
            a.opacity = Math.round(255 * smoothstep(0, SNAP.fadeInMs, e.mt - e.fadeAt));
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

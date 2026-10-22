// SPDX-License-Identifier: GPL-3.0-or-later
// Vitre fullscreen motion (2026-10-22): entering and leaving fullscreen as one gesture.
//
// Entering fullscreen is one gesture: the window grows from its frame to the whole screen on the Vitre stretch spring
// (vitre-menus dripMotion.js STRETCH: period 400 ms, damping 0.86), the desktop behind it steps back (its windows sink to
// 95 % and the whole desktop dims) and the top bar, the Dock and the Stage strip slide off their edges. Leaving is the exact
// reverse and lands the window on its frame.
//
// How: for the length of the motion a transition layer covers the window's monitor. It draws the desktop the window leaves
// (live clones of the wallpaper and of that workspace's windows), the window (a live clone of it, and a picture of what it
// showed before the app drew its new size, cross-faded) and the chrome (live clones of the top bar, Dock and strip). Under
// the layer the real desktop does what it has to: Fullscreen Spaces moves the window to its own workspace (with no slide:
// the layer is the motion), GNOME hides or shows the chrome, the app draws at its new size. The layer leaves in a frame
// where the real desktop shows exactly what the layer shows: the window on its real frame with its real content, the
// workspace switch done, the chrome at rest. GNOME's own size-change effect is not used for these changes.
//
// An app that has not drawn its new size yet: the window waits 90 % of the way, showing what it showed, and finishes once
// the app has drawn, so a stretched old picture is never what the motion lands on. Interrupted (leave mid-enter, enter
// mid-exit, rapid F11): the motion turns from where the window is drawn, with its speed. Reduced motion: no motion; the
// layer holds the current frame until the new state is ready and cross-fades into it. Animations off: the same, as one cut.
// The overview, a screen lock, a workspace switch by the user or the window going away end the transition at once.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const FS = {
    responseMs: 400,    // the Vitre stretch spring: period (ms) ...
    damping: 0.86,      // ... and damping ratio
    lagMs: 34,          // the edge that moves least follows the edge that moves most by this much
    settle: 0.004,      // an edge is done when it stays within this share of its travel ...
    landMs: 80,         // ... and its last 80 ms ease exactly onto the target (no step when the real window takes over)
    sink: 0.95,         // the desktop's windows step back to this scale ...
    dim: 0.42,          // ... and the whole desktop dims by this much
    chromeGap: 12,      // the chrome slides this far past its screen edge
    chromeOut: 0.8,     // ... and is gone (out and faded) at this depth
    hold: 0.9,          // an app that has not drawn its new size yet: the window waits this far along
    swapInMs: [45, 30], // once the app has drawn: its new content comes in under the picture of the old one ...
    swapOutMs: [130, 100], // ... then the picture fades out ([leaving, entering]: an enlarged old picture goes sooner)
    refadeMs: 140,      // pictures of older states (a change before) fade out over this long
    shadowUntil: 0.4,   // the window's own shadow (rounded-window-corners) is gone at this depth
    waitMs: 1500,       // an app that never draws its new size is let go after this long (motion time)
    settleRealMs: 700,  // at most this long for the desktop under the layer to come to rest, then the layer goes anyway
    staticWaitMs: 450,  // reduced motion / animations off: the longest the current frame is held
    fadeMs: 160,        // reduced motion: the cross-fade into the new state
    watchdogMs: 4000,   // nothing of this runs longer (real time)
    shadowPad: 80,      // rounded-window-corners draws its shadow actor this far around the frame
    startTicks: 6,      // the first frames of a transition advance at most capMs each: the shell's own work right after
    capMs: 17,          // ... a fullscreen change (chrome, Stage, Dock) can hold a frame; the motion slows there instead of skipping
};

// A do-nothing effect on the real window while the layer is up: mutter does not cull behind a window that carries an
// effect, so the layer's clones of the desktop behind it keep their pixels (a fullscreen-sized window would cull them).
const NoCull = GObject.registerClass({GTypeName: 'VitreFullscreenNoCull'}, class NoCull extends Clutter.Effect {});
const NOCULL = 'vitre-fullscreen-nocull';

// Rig only: the slow-motion factor for films (as the rest of Vitre's motion). Unset in a session.
const ENV_SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);
const slowNow = () => Math.max(1, Number(globalThis.__vitreMotionSlow) || ENV_SLOW);

const BLACK = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 255});
const RWC_EFFECT = 'Rounded Corners Effect';     // rounded-window-corners' effect name (its shadow follows it)

const clamp01 = v => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, v) => {
    const s = clamp01((v - a) / (b - a));
    return s * s * (3 - 2 * s);
};

// ---- the spring (as vitre-window-open's snap motion) -------------------------------------------------------------------

const W0 = 2 * Math.PI / FS.responseMs;      // rad per ms
const ZW = FS.damping * W0;
const WD = W0 * Math.sqrt(1 - FS.damping * FS.damping);

// displacement from the target `tau` ms after a start at displacement `a` with speed `u` (units per ms) ...
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
            if (Math.abs(springDisp(1, 0, t)) > FS.settle)
                last = t;
        }
        _settleMs = last + 1;
    }
    return _settleMs;
}

// one value on the spring: from `s` (at speed `u`) to `g`, starting `lag` ms after `t0`; exactly `g` from t0 + end on
const makeEdge = (s, g, u, t0, lag) => ({s, g, u, t0, lag, end: lag + settleMs()});

function edgeAt(e, t) {
    const local = t - e.t0;
    if (local >= e.end)
        return e.g;
    const x = e.g + springDisp(e.s - e.g, e.u, local - e.lag);
    return x + (e.g - x) * smoothstep(e.end - FS.landMs, e.end, local);
}

function edgeSpeed(e, t) {
    const local = t - e.t0;
    const x = e.g + springDisp(e.s - e.g, e.u, local - e.lag);
    const v = springSpeed(e.s - e.g, e.u, local - e.lag);
    const a = e.end - FS.landMs;
    const k = clamp01((local - a) / FS.landMs);
    const land = k * k * (3 - 2 * k);
    const dLand = k > 0 && k < 1 ? 6 * k * (1 - k) / FS.landMs : 0;
    return v * (1 - land) + (e.g - x) * dLand;
}

const edgeDone = (e, t) => t - e.t0 >= e.end;

// ---- geometry helpers -------------------------------------------------------------------------------------------------

const rectOf = r => ({x: r.x, y: r.y, w: r.width, h: r.height});
const edgesOf = r => [r.x, r.y, r.x + r.w, r.y + r.h];
const fromEdges = ([l, t, r, b]) => ({x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t)});
const near = (a, b, eps = 1) => Boolean(a && b) && edgesOf(a).every((v, i) => Math.abs(v - edgesOf(b)[i]) <= eps);
const lerpRect = (a, b, s) => fromEdges(edgesOf(a).map((v, i) => v + (edgesOf(b)[i] - v) * s));
const alive = a => Boolean(a) && a.get_stage?.() !== null;
const allocOf = a => ({x: a.x, y: a.y, w: a.width, h: a.height});

// the stage rectangle of an actor as it rests in its parent (its own translation and opacity left out)
function restRect(a) {
    const p = a.get_parent();
    const [px, py] = p ? p.get_transformed_position() : [0, 0];
    return {x: px + a.x, y: py + a.y, w: a.width, h: a.height};
}

function nowRect(a) {
    const [x, y] = a.get_transformed_position();
    const [w, h] = a.get_transformed_size();
    return {x, y, w, h};
}

export class FullscreenMotion {
    // owner: the Fullscreen Spaces extension (it moves windows between workspaces; see its motion* methods)
    constructor(owner) {
        this._owner = owner;
    }

    enable() {
        this._entries = new Map();          // window actor -> transition
        this._memo = new WeakMap();         // window -> what it looked like windowed (chrome around it, its shadow)
        this._log = [];
        this._injections = new InjectionManager();
        const self = this;
        this._injections.overrideMethod(Main.wm, '_prepareAnimationInfo', original => function (shellwm, actor, oldFrameRect, change) {
            let mine = false;
            try {
                mine = self._prepare(shellwm, actor, oldFrameRect, change);
            } catch (e) {
                console.warn(`Vitre fullscreen motion: left to GNOME (${e.message})`);
                self._drop(actor, 'prepare-failed');
            }
            if (!mine)
                original.call(this, shellwm, actor, oldFrameRect, change);
        });
        const wm = global.window_manager;
        this._active = global.workspace_manager.get_active_workspace();
        this._signals = [
            [wm, wm.connect('size-changed', (_w, actor) => this._guard(() => this._onSizeChanged(actor)))],
            [wm, wm.connect('kill-window-effects', (_w, actor) => this._guard(() => this._onKill(actor)))],
            [Main.overview, Main.overview.connect('showing', () => this._guard(() => this._finishAll('overview')))],
            [Main.sessionMode, Main.sessionMode.connect('updated', () => this._guard(() => {
                if (Main.sessionMode.isLocked)
                    this._finishAll('locked');
            }))],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._guard(() => {
                // Fullscreen Spaces' own switches happen under the layer; anyone else's ends the transition (a removed
                // workspace before the active one only renumbers it)
                const active = global.workspace_manager.get_active_workspace();
                const moved = active !== this._active;
                this._active = active;
                if (moved && !this._owner.motionOwnsSwitch())
                    this._finishAll('workspace');
            }))],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._guard(() => this._finishAll('monitors')))],
            [global.display, global.display.connect('grab-op-begin', (_d, win) => this._guard(() => {
                const e = this._entries.get(win?.get_compositor_private());
                if (e)
                    this._finish(e, 'grab');
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
        this._log = null;
    }

    _guard(fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`Vitre fullscreen motion: ${e.message}`);
        }
    }

    _note(ev, detail = '') {
        if (!this._log)
            return;
        this._log.push({ev, detail, t: Math.round(GLib.get_monotonic_time() / 1000)});
        if (this._log.length > 80)
            this._log.shift();
    }

    _now() {
        return GLib.get_monotonic_time() / 1000 / slowNow();
    }

    _mode() {
        const s = St.Settings.get();
        if (!s.enable_animations)
            return 'cut';
        if (s.reducedMotion === St.ReducedMotion.REDUCE)
            return 'fade';
        return 'motion';
    }

    // ---- questions Fullscreen Spaces asks ------------------------------------------------------------------------------

    // the window's enter is still moving: Fullscreen Spaces moves it to its workspace when the motion has landed
    holdsEnter(win) {
        const e = this._entries?.get(win?.get_compositor_private());
        return Boolean(e) && e.mode === 'motion' && e.dir === 1 && e.phase === 'moving';
    }

    // a transition layer covers the window's monitor (a workspace switch there needs no slide of its own)
    covers(win) {
        const e = this._entries?.get(win?.get_compositor_private());
        return Boolean(e) && e.monitor === win.get_monitor();
    }

    busy() {
        return Boolean(this._entries?.size);
    }

    // ---- taking a change ----------------------------------------------------------------------------------------------

    _decide(actor, oldFrameRect, change) {
        const win = actor?.meta_window;
        if (!win)
            return 'no-window';
        if (change !== Meta.SizeChange.FULLSCREEN && change !== Meta.SizeChange.UNFULLSCREEN)
            return 'not-fullscreen';
        if (Main.wm._getAnimationWindowType(actor) !== Meta.WindowType.NORMAL || win.is_attached_dialog() ||
            win.get_transient_for())
            return 'type';
        if (Main.sessionMode.isLocked || !Main.wm._shouldAnimate())
            return 'busy-shell';
        if (!actor.visible || !actor.mapped || actor.opacity !== 255 || !actor.get_texture?.())
            return 'hidden';
        if (win.minimized || (!win.is_on_all_workspaces() && win.get_workspace() !== global.workspace_manager.get_active_workspace()))
            return 'elsewhere';
        if (oldFrameRect.width <= 0 || oldFrameRect.height <= 0)
            return 'no-frame';
        if (Main.wm._mapping?.has(actor) || Main.wm._minimizing?.has(actor) || Main.wm._unminimizing?.has(actor) ||
            Main.wm._destroying?.has(actor))
            return 'other-effect';
        const monitor = Main.layoutManager.monitors[win.get_monitor()];
        if (!monitor)
            return 'no-monitor';
        // a second window on the same monitor while one is moving: the older one lands at once
        for (const e of [...this._entries.values()]) {
            if (e.actor !== actor && e.monitor === monitor.index)
                this._finish(e, 'other-window');
        }
        return 'take';
    }

    _prepare(shellwm, actor, oldFrameRect, change) {
        if (!this._entries)
            return false;
        const old = this._entries.get(actor);
        const why = this._decide(actor, oldFrameRect, change);
        if (why !== 'take') {
            if (old)
                this._finish(old, `untaken:${why}`);
            if (why !== 'not-fullscreen')
                this._note('gnome', `${why}:${change}`);
            return false;
        }
        // GNOME's effect is not run for this change: its size-change accounting is completed here, once
        shellwm.completed_size_change(actor);
        const dir = change === Meta.SizeChange.FULLSCREEN ? 1 : 0;
        if (old && old.mode !== 'motion') {
            // reduced motion, animations off: what is on screen now becomes the new still picture
            this._finish(old, 'restart');
            this._begin(actor, dir, rectOf(oldFrameRect));
        } else if (old) {
            this._turn(old, dir, rectOf(oldFrameRect));
        } else {
            this._begin(actor, dir, rectOf(oldFrameRect));
        }
        return true;
    }

    // ---- a new transition ----------------------------------------------------------------------------------------------

    _begin(actor, dir, oldFrame) {
        const win = actor.meta_window;
        const monitor = Main.layoutManager.monitors[win.get_monitor()];
        const M = {x: monitor.x, y: monitor.y, w: monitor.width, h: monitor.height};
        const now = this._now();
        const mode = this._mode();
        const memo = this._memo.get(win) ?? null;
        const e = {actor, win, monitor: monitor.index, M, dir, mode, phase: 'moving', t0: now, us0: GLib.get_monotonic_time(),
            frozen: false, mapF: null, mapB: null, pics: [], swapAt: null, home: null, from: null, edges: null, target: null,
            depth: null, signals: [], chrome: [], shadow: null, layerFade: null, settleUs: 0, startedAt: now,
            lag: 0, lastReal: now, ticks: 0, mt: now, bgManager: null, turns: 0};
        if (dir === 1) {
            e.home = oldFrame;                    // where it goes back to
            e.from = oldFrame;
        } else {
            // the frame it had before fullscreen (the app may still choose another: the motion follows what it draws)
            e.home = memo?.home && memo.home.w > 0 ? {...memo.home} : null;
            e.from = oldFrame;
        }
        if (!e.home) {
            // never seen windowed: aim at two thirds of the screen, centred, until the app draws its real frame
            e.home = {x: M.x + M.w / 6, y: M.y + M.h / 6, w: M.w * 2 / 3, h: M.h * 2 / 3};
            e.homeGuessed = true;
        }
        // the desktop it leaves (enter) or returns to (exit)
        const ws = dir === 1 ? win.get_workspace() : (this._owner.motionDesktopFor(win) ?? win.get_workspace());
        this._build(e, ws, memo);
        const d0 = dir === 1 ? 0 : 1;
        e.staticR = oldFrame;
        e.staticD = d0;
        if (mode === 'motion') {
            this._freeze(e);
        } else {
            // reduced motion, animations off: a picture of the window as it is now stands still until the new state is ready
            e.mapF = rectOf(win.get_frame_rect());
            e.mapB = allocOf(actor);
            this._picture(e, now, 'static');
        }
        e.depth = makeEdge(d0, dir, 0, now, 0);
        e.edges = edgesOf(e.from).map((v, i) => makeEdge(v, v, 0, now, 0));
        e.target = e.from;
        this._aim(e, now);
        e.signals.push([actor, actor.connect('destroy', () => this._drop(actor, 'destroyed'))]);
        e.signals.push([win, win.connect('unmanaged', () => this._drop(actor, 'unmanaged'))]);
        e.signals.push([win, win.connect('notify::minimized', () => this._guard(() => {
            if (win.minimized)
                this._finish(e, 'minimized');
        }))]);
        try {
            if (!actor.get_effect(NOCULL))
                actor.add_effect_with_name(NOCULL, new NoCull());
        } catch (_err) { /* culling stays: the desktop behind may lose pixels, nothing worse */ }
        this._entries.set(actor, e);
        this._apply(e, now);
        this._startClock();
        this._note('begin', `${mode} dir=${dir} ${win.get_title()}`);
    }

    // a change in the other direction (or the same one again) while the transition runs: turn from where it is drawn
    _turn(e, dir, oldFrame) {
        // from where the window was last drawn (a change can come between two frames, or before the first)
        const now = e.mt;
        // the shell works hard right after a change: the next frames are capped again
        e.ticks = Math.min(e.ticks, 1);
        if (e.phase !== 'moving') {
            // it had landed and waited for the desktop under it: move again from the landed pose
            e.phase = 'moving';
        }
        if (dir === 1 && e.dir === 0 && !e.homeGuessed && oldFrame.w > 0 && !near(oldFrame, e.M, 1))
            e.home = oldFrame;
        e.dir = dir;
        e.turns++;
        if (e.mode === 'motion') {
            const R = this._rectAt(e, now);
            e.from = R;
            const d = edgeAt(e.depth, now);
            e.depth = makeEdge(d, dir, edgeSpeed(e.depth, now), now, 0);
        }
        e.layerFade = null;
        e.layer.opacity = 255;
        if (e.mode === 'motion')
            this._freeze(e);
        this._aim(e, now, true);
        this._note('turn', `dir=${dir}`);
    }

    // ---- the transition layer -----------------------------------------------------------------------------------------

    _build(e, ws, memo) {
        const {M} = e;
        const layer = new Clutter.Actor({name: 'vitreFullscreenMotion', x: M.x, y: M.y, width: M.w, height: M.h,
            clip_to_allocation: true, reactive: false, background_color: BLACK});
        e.layer = layer;
        // the desktop: the wallpaper, then the workspace's other windows (they sink), then the dim
        const desk = new Clutter.Actor({width: M.w, height: M.h});
        layer.add_child(desk);
        // the wallpaper is drawn by a background of the layer's own (as GNOME's workspace slide does): a clone of the real one
        // would only show the parts no window covers
        try {
            const bgGroup = new Meta.BackgroundGroup({width: M.w, height: M.h});
            desk.add_child(bgGroup);
            e.bgManager = new Background.BackgroundManager({container: bgGroup, monitorIndex: e.monitor, controlPosition: false});
        } catch (_err) {
            e.bgManager = null;
        }
        const wins = new Clutter.Actor({width: M.w, height: M.h, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        desk.add_child(wins);
        const monRect = new Mtk.Rectangle({x: M.x, y: M.y, width: M.w, height: M.h});
        for (const a of global.get_window_actors()) {
            const w = a.meta_window;
            if (!w || a === e.actor || w === e.win || e.win.is_ancestor_of_transient(w) || w.is_override_redirect())
                continue;
            if (w.minimized || !w.showing_on_its_workspace() || a.opacity === 0)
                continue;
            if (!w.is_on_all_workspaces() && !w.located_on_workspace(ws))
                continue;
            const [hit] = w.get_frame_rect().intersect(monRect);
            if (!hit)
                continue;
            const parent = w.get_window_type() === Meta.WindowType.DESKTOP ? desk : wins;
            const sh = a.rwcCustomData?.shadow;
            if (sh && parent === wins && a.rwcCustomData?.effectActor?.get_effect?.(RWC_EFFECT)?.enabled === true) {
                const f = w.get_frame_rect();
                parent.add_child(new Clutter.Clone({source: sh, x: f.x - M.x - FS.shadowPad, y: f.y - M.y - FS.shadowPad,
                    width: f.width + 2 * FS.shadowPad, height: f.height + 2 * FS.shadowPad}));
            }
            const clone = new Clutter.Clone({source: a, x: a.x - M.x, y: a.y - M.y, width: a.width, height: a.height});
            if (parent === desk)
                desk.insert_child_below(clone, wins);
            else
                parent.add_child(clone);
        }
        const dim = new Clutter.Actor({width: M.w, height: M.h, opacity: 0,
            background_color: BLACK});
        desk.add_child(dim);
        e.desk = desk;
        e.wins = wins;
        e.dim = dim;
        // the window: its own shadow, the live window, and the pictures of what it showed before
        const winLayer = new Clutter.Actor({width: M.w, height: M.h});
        layer.add_child(winLayer);
        e.winLayer = winLayer;
        const sh = e.actor.rwcCustomData?.shadow;
        const rwcOn = e.actor.rwcCustomData?.effectActor?.get_effect?.(RWC_EFFECT)?.enabled === true;
        const hadShadow = memo ? memo.shadow : Boolean(sh);
        if (sh && hadShadow && (e.dir === 0 || (rwcOn && sh.visible && sh.opacity > 0))) {
            e.shadow = new Clutter.Clone({source: sh, opacity: 0});
            winLayer.add_child(e.shadow);
        }
        e.live = new Clutter.Clone({source: e.actor});
        winLayer.add_child(e.live);
        // the chrome over everything (as on the real desktop): the top bar, the Dock, the Stage strip
        const chromeLayer = new Clutter.Actor({width: M.w, height: M.h});
        layer.add_child(chromeLayer);
        for (const c of this._chromeFor(e, memo)) {
            const clone = new Clutter.Clone({source: c.actor, x: c.r.x - M.x, y: c.r.y - M.y, width: c.r.w, height: c.r.h, opacity: 0});
            chromeLayer.add_child(clone);
            const dTop = c.r.y - M.y, dBot = M.y + M.h - (c.r.y + c.r.h), dLeft = c.r.x - M.x, dRight = M.x + M.w - (c.r.x + c.r.w);
            const m = Math.min(dTop, dBot, dLeft, dRight);
            const g = FS.chromeGap;
            const off = m === dTop ? [0, -(dTop + c.r.h + g)] : m === dBot ? [0, dBot + c.r.h + g]
                : m === dLeft ? [-(dLeft + c.r.w + g), 0] : [dRight + c.r.w + g, 0];
            e.chrome.push({src: c.actor, clone, op: c.op, tx: c.tx ?? 0, ty: c.ty ?? 0, off, gone: null});
        }
        if (e.dir === 1) {
            this._memo.set(e.win, {...this._memo.get(e.win) ?? {}, home: e.home, shadow: Boolean(e.shadow),
                chrome: e.chrome.map(c => ({actor: c.src, r: {x: c.clone.x + M.x, y: c.clone.y + M.y, w: c.clone.width, h: c.clone.height},
                    op: c.op, tx: c.tx, ty: c.ty}))});
        }
        Main.layoutManager.uiGroup.insert_child_below(layer, Main.layoutManager.modalDialogGroup);
    }

    // The chrome that fullscreen hides on this monitor: as it is now when the window goes fullscreen (and remembered for
    // the way back), else its usual place.
    _chromeFor(e, memo) {
        const {M} = e;
        const area = M.w * M.h;
        const tracked = (Main.layoutManager._trackedActors ?? []).filter(d => d.trackFullscreen).map(d => d.actor);
        const onMonitor = r => {
            const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
            return cx >= M.x && cx < M.x + M.w && cy >= M.y && cy < M.y + M.h && r.w > 1 && r.h > 1 && r.w * r.h < 0.6 * area;
        };
        if (e.dir === 1) {
            return tracked.filter(a => alive(a) && a.visible && a.mapped && a.get_paint_opacity() > 0)
                .map(a => ({actor: a, r: nowRect(a), op: a.get_paint_opacity(), tx: a.translation_x, ty: a.translation_y}))
                .filter(c => onMonitor(c.r));
        }
        if (memo?.chrome)
            return memo.chrome.filter(c => alive(c.actor) && tracked.includes(c.actor));
        // never seen windowed: the top bar, the Dock and the Stage strip at their usual places
        const known = [Main.layoutManager.panelBox];
        for (const a of tracked) {
            if (a.get_name?.() === 'DhruvaContainer' || a === this._owner.motionStageStrip())
                known.push(a);
        }
        return known.filter(a => alive(a) && tracked.includes(a)).map(a => ({actor: a, r: restRect(a), op: 255}))
            .filter(c => onMonitor(c.r));
    }

    // ---- the window's content ------------------------------------------------------------------------------------------

    // hold what the window shows now until the app has drawn the size this transition is going to
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

    // the window's final frame for the current direction
    _final(e) {
        if (e.giveUp)
            return rectOf(e.win.get_frame_rect());
        return e.dir === 1 ? e.M : e.home;
    }

    // the app has drawn the final size (and nothing of the window is held)
    _ready(e) {
        if (e.frozen)
            return false;
        const F = rectOf(e.win.get_frame_rect());
        const a = e.actor;
        return near(F, this._final(e), 1.5) && Math.abs(a.width - e.win.get_buffer_rect().width) <= 1 &&
            Math.abs(a.height - e.win.get_buffer_rect().height) <= 1;
    }

    _onSizeChanged(actor) {
        const e = this._entries?.get(actor);
        if (!e)
            return;
        const win = e.win;
        const F = rectOf(win.get_frame_rect());
        const now = e.mt;       // the motion's time as last drawn
        // leaving: the frame the app really took is where the window lands
        if (e.dir === 0 && !win.is_fullscreen() && !near(F, e.M, 1)) {
            e.home = F;
            e.homeGuessed = false;
        }
        if (e.mode !== 'motion') {
            // reduced motion and animations off show the picture taken at the start until the new state is ready
            this._aim(e, now);
            return;
        }
        if (e.frozen) {
            const resized = Math.abs(F.w - e.mapF.w) > 1 || Math.abs(F.h - e.mapF.h) > 1;
            const pictured = resized && this._picture(e, now);
            this._thaw(e);
            if (pictured) {
                e.swapAt = now;
                e.swapInMs = FS.swapInMs[e.dir];
            }
        }
        // an in-between size (a change that was already overtaken by the next one): show it, but hold it again
        if (!near(F, this._final(e), 1.5))
            this._freeze(e);
        this._aim(e, now);
        this._note('size-changed', `${F.x},${F.y} ${F.w}x${F.h} ready=${this._ready(e)}`);
    }

    // a picture of what the held window shows (taken before it takes its new size)
    _picture(e, now, kind = 'main') {
        const B = e.mapB;
        let content = null;
        try {
            content = e.actor.paint_to_content(new Mtk.Rectangle({x: Math.round(B.x), y: Math.round(B.y),
                width: Math.round(B.w), height: Math.round(B.h)}));
        } catch (_err) {
            content = null;
        }
        if (!content)
            return false;
        for (const p of e.pics) {
            if (p.kind === 'static')
                continue;
            p.a0 = this._picAlpha(e, p, now);
            p.t0 = now;
            p.kind = 'old';
        }
        const actor = new St.Widget({content, width: B.w, height: B.h, reactive: false});
        e.winLayer.add_child(actor);
        e.pics.push({actor, F: {...e.mapF}, B: {...B}, kind, t0: now, a0: 1, inMs: FS.swapInMs[e.dir], outMs: FS.swapOutMs[e.dir]});
        return true;
    }

    _picAlpha(e, p, now) {
        if (p.kind === 'static')
            return 1;
        if (p.kind === 'old')
            return p.a0 * (1 - smoothstep(0, FS.refadeMs, now - p.t0));
        return 1 - smoothstep(p.inMs, p.inMs + p.outMs, now - p.t0);
    }

    _liveAlpha(e, now) {
        if (e.mode !== 'motion')
            return e.pics.length ? 0 : 1;
        return e.swapAt === null ? 1 : smoothstep(0, e.swapInMs ?? FS.swapInMs[e.dir], now - e.swapAt);
    }

    // ---- the motion ----------------------------------------------------------------------------------------------------

    _rectAt(e, now) {
        let [l, t, r, b] = e.edges.map(edge => edgeAt(edge, now));
        if (e.dir === 1 && near(e.target, e.M, 0.5)) {
            // growing to the screen: an edge stops at the screen's edge (no overshoot past it)
            l = Math.max(l, e.M.x);
            t = Math.max(t, e.M.y);
            r = Math.min(r, e.M.x + e.M.w);
            b = Math.min(b, e.M.y + e.M.h);
        }
        return fromEdges([l, t, r, b]);
    }

    // where the window heads now: its final frame once the app has drawn it, else the hold point short of it
    _aim(e, now, turned = false) {
        const final = this._final(e);
        let target = final;
        if (e.mode === 'motion' && !this._ready(e))
            target = lerpRect(e.from, final, FS.hold);
        if (e.mode !== 'motion') {
            e.target = target;
            return;
        }
        if (!turned && near(target, e.target, 0.01))
            return;
        const from = edgesOf(e.target === null ? e.from : this._rectAt(e, now));
        const to = edgesOf(target);
        if (turned || !e.edgesStarted) {
            // a fresh start: the edge that travels least follows the one that travels most
            const travel = from.map((v, i) => Math.abs(to[i] - v));
            const most = Math.max(...travel);
            e.edges = e.edges.map((edge, i) => makeEdge(edgeAt(edge, now), to[i], edgeSpeed(edge, now), now,
                most > 0 ? FS.lagMs * (1 - travel[i] / most) : 0));
            e.edgesStarted = true;
        } else {
            // the same move with a new end (the app has drawn its size, or chose another frame): keep place and speed
            e.edges = e.edges.map((edge, i) => makeEdge(edgeAt(edge, now), to[i], edgeSpeed(edge, now), now, 0));
        }
        e.target = target;
    }

    _place(actor, F, B, R, M) {
        const sx = R.w / F.w, sy = R.h / F.h;
        if (actor.width !== B.w || actor.height !== B.h)
            actor.set_size(B.w, B.h);
        actor.set_scale(sx, sy);
        actor.set_position(R.x - M.x - sx * (F.x - B.x), R.y - M.y - sy * (F.y - B.y));
    }

    _apply(e, now) {
        const {M} = e;
        const motion = e.mode === 'motion';
        const R = motion ? this._rectAt(e, now) : e.staticR;
        const d = motion ? clamp01(edgeAt(e.depth, now)) : e.staticD;
        // the desktop steps back
        const s = 1 - (1 - FS.sink) * d;
        e.wins.set_scale(s, s);
        e.dim.opacity = Math.round(255 * FS.dim * d);
        // the window: the live window under the pictures of what it showed
        const F = e.frozen ? e.mapF : rectOf(e.win.get_frame_rect());
        const B = e.frozen ? e.mapB : allocOf(e.actor);
        this._place(e.live, F, B, R, M);
        e.live.opacity = Math.round(255 * this._liveAlpha(e, now));
        e.pics = e.pics.filter(p => {
            const a = this._picAlpha(e, p, now);
            if (a <= 0 && now - p.t0 > (p.inMs ?? 0)) {
                p.actor.destroy();
                return false;
            }
            this._place(p.actor, p.F, p.B, R, M);
            p.actor.opacity = Math.round(255 * a);
            return true;
        });
        if (e.shadow) {
            const P = FS.shadowPad;
            e.shadow.set_position(R.x - M.x - P, R.y - M.y - P);
            e.shadow.set_size(R.w + 2 * P, R.h + 2 * P);
            e.shadow.opacity = Math.round(255 * (1 - smoothstep(0, FS.shadowUntil, d)));
        }
        // the chrome slides off its edges (and back)
        const out = smoothstep(0, FS.chromeOut, d);
        const fade = 1 - smoothstep(FS.chromeOut * 0.3, FS.chromeOut, d);
        for (const c of e.chrome) {
            c.clone.translation_x = c.off[0] * out;
            c.clone.translation_y = c.off[1] * out;
            const g = c.gone === null ? 1 : 1 - smoothstep(0, 120, GLib.get_monotonic_time() / 1000 - c.gone);
            c.clone.opacity = Math.round(c.op * fade * g);
        }
        if (e.trace)
            e.trace.push({t: now, R, d, pics: e.pics.map(p => p.actor.opacity), live: e.live.opacity});
        e.lastR = R;
        e.lastD = d;
    }

    // ---- landing, and the hand-over to the real desktop -------------------------------------------------------------------

    _landed(e, now) {
        if (!this._ready(e) || !near(e.target, this._final(e), 0.01))
            return false;
        if (e.pics.length || this._liveAlpha(e, now) < 1)
            return false;
        return e.edges.every(edge => edgeDone(edge, now)) && edgeDone(e.depth, now);
    }

    // the real desktop under the layer shows what the layer shows (reduced motion and animations off only wait for the
    // window: the chrome comes back on its own)
    _settled(e, chrome = true) {
        const a = e.actor, win = e.win;
        if (Main.wm._workspaceAnimation?._switchData || this._owner.motionPending(win))
            return false;
        if (e.frozen || !alive(a) || !a.visible)
            return false;
        if (!win.is_on_all_workspaces() && win.get_workspace() !== global.workspace_manager.get_active_workspace())
            return false;
        if (!near(rectOf(win.get_frame_rect()), this._final(e), 1) || a.scale_x !== 1 || a.scale_y !== 1 ||
            a.translation_x !== 0 || a.translation_y !== 0 || a.opacity !== 255)
            return false;
        if (e.dir === 1 && !global.display.get_monitor_in_fullscreen(e.monitor))
            return false;
        if (!chrome)
            return true;
        const nowMs = GLib.get_monotonic_time() / 1000;
        for (const c of e.chrome) {
            const src = c.src;
            const shows = alive(src) && src.visible && src.mapped && src.get_paint_opacity() > 0;
            if (e.dir === 1) {
                // an empty helper (an edge or a strut) may stay; anything that draws must be gone
                if (shows && (src.get_n_children?.() > 0 || src.content))
                    return false;
                continue;
            }
            if (!shows) {
                // hidden on the real desktop for its own reasons (a Dock that hides itself): its picture fades away
                if (c.gone === null)
                    c.gone = nowMs;
                if (nowMs - c.gone < 120 * slowNow())
                    return false;
                continue;
            }
            c.gone = null;
            if (src.get_paint_opacity() !== c.op || Math.abs(src.translation_x - c.tx) > 0.5 || Math.abs(src.translation_y - c.ty) > 0.5 ||
                src.get_transition?.('opacity') || src.get_transition?.('translation-y') || src.get_transition?.('translation-x'))
                return false;
        }
        if (e.dir === 0) {
            const sh = a.rwcCustomData?.shadow;
            if (e.shadow && sh && sh.visible !== a.visible)
                return false;
            if (!this._owner.motionStageIdle())
                return false;
        }
        return true;
    }

    _step(e, now) {
        const us = GLib.get_monotonic_time();
        if ((us - e.us0) / 1000 > FS.watchdogMs * slowNow())
            return this._finish(e, 'watchdog');
        if (!alive(e.actor) || e.win.get_monitor() !== e.monitor)
            return this._finish(e, 'moved');
        if (e.mode !== 'motion')
            return this._stepStatic(e, now, us);
        if (!e.giveUp && now - e.startedAt > FS.waitMs && !this._ready(e)) {
            // the app never drew its new size: land on whatever frame it has
            this._thaw(e);
            e.giveUp = true;
            this._note('give-up', `${e.win.get_title()}`);
        }
        this._aim(e, now);
        this._apply(e, now);
        if (e.phase === 'moving' && this._landed(e, now)) {
            e.phase = 'settling';
            e.settleUs = us;
            this._note('landed', `dir=${e.dir}`);
            if (e.dir === 1)
                this._owner.motionLanded(e.win);
        }
        if (e.phase === 'settling' && (this._settled(e) || (us - e.settleUs) / 1000 > FS.settleRealMs * slowNow()))
            this._finish(e, 'done');
    }

    // reduced motion and animations off: hold the current frame, then cut or cross-fade into the new state
    _stepStatic(e, now, us) {
        this._apply(e, now);
        if (e.layerFade === null) {
            const waited = (us - e.us0) / 1000 / slowNow();
            if (this._ready(e) && this._settled(e, false) || waited > FS.staticWaitMs) {
                if (!this._ready(e))
                    this._thaw(e);
                if (e.mode === 'cut')
                    return this._finish(e, 'cut');
                e.layerFade = now;
            }
            return;
        }
        const k = smoothstep(0, FS.fadeMs, now - e.layerFade);
        e.layer.opacity = Math.round(255 * (1 - k));
        if (k >= 1)
            this._finish(e, 'faded');
    }

    // ---- ending ---------------------------------------------------------------------------------------------------------

    _finish(e, why) {
        if (this._entries?.get(e.actor) !== e)
            return;
        this._entries.delete(e.actor);
        for (const [obj, id] of e.signals) {
            try {
                obj.disconnect(id);
            } catch (_err) { /* gone */ }
        }
        e.signals = [];
        try {
            if (alive(e.actor) && e.actor.get_effect(NOCULL))
                e.actor.remove_effect_by_name(NOCULL);
        } catch (_err) { /* gone */ }
        try {
            e.bgManager?.destroy();
        } catch (_err) { /* gone */ }
        e.bgManager = null;
        try {
            e.layer?.destroy();
        } catch (_err) { /* gone */ }
        e.pics = [];
        this._thaw(e);
        this._note('finish', why);
        if (!this._entries.size)
            this._stopClock();
        // a workspace move still waiting for the motion happens now
        this._owner.motionEnded(e.win);
    }

    // the window actor went away
    _drop(actor, why) {
        const e = this._entries?.get(actor);
        if (!e)
            return;
        e.frozen = false;
        this._finish(e, why);
    }

    _finishAll(why) {
        for (const e of [...this._entries?.values() ?? []])
            this._finish(e, why);
    }

    // kill-window-effects comes before every size change, and when the window is minimized, hidden or destroyed
    _onKill(actor) {
        const e = this._entries?.get(actor);
        if (!e)
            return;
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._guard(() => {
                if (this._entries?.get(actor) === e && (e.win.minimized || Main.wm._minimizing?.has(actor) ||
                    Main.wm._destroying?.has(actor)))
                    this._finish(e, 'killed');
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- the clock (one tick per frame; time from the wall clock, as Vitre's other motion) ---------------------------------

    _startClock() {
        if (this._timeline)
            return;
        const tl = new Clutter.Timeline({duration: 3600000, actor: Main.layoutManager.uiGroup});
        tl.connect('new-frame', () => this._tick());
        this._timeline = tl;
        tl.start();
    }

    _stopClock() {
        const tl = this._timeline;
        this._timeline = null;
        tl?.stop();
    }

    // the transition's own clock: real time, except that its first frame shows the start and its next few frames advance at
    // most capMs each (a frame the shell held right after the change slows the motion instead of skipping it)
    _advance(e, real) {
        const dt = real - e.lastReal;
        e.lastReal = real;
        e.ticks++;
        if (e.ticks === 1)
            e.lag += dt;
        else if (e.ticks <= FS.startTicks && dt > FS.capMs)
            e.lag += dt - FS.capMs;
        e.mt = real - e.lag;
        return e.mt;
    }

    _tick() {
        const real = this._now();
        for (const e of [...this._entries?.values() ?? []]) {
            try {
                this._step(e, this._advance(e, real));
            } catch (err) {
                console.warn(`Vitre fullscreen motion: let go (${err.message})`);
                this._finish(e, 'error');
            }
        }
        if (!this._entries?.size)
            this._stopClock();
    }

    // ---- rig ------------------------------------------------------------------------------------------------------------

    traceOn(on) {
        for (const e of this._entries?.values() ?? [])
            e.trace = on ? [] : null;
        this._tracing = on;
    }

    // what is on screen for the rig's per-frame sampler
    state() {
        const e = [...this._entries?.values() ?? []][0];
        if (!e)
            return null;
        const pieces = [];
        const mapR = a => {
            const [x, y] = a.get_transformed_position();
            const [w, h] = a.get_transformed_size();
            return [x, y, w, h].map(v => Math.round(v * 100) / 100);
        };
        const lay = e.layer.opacity / 255;
        if (e.lastR) {
            const r = [e.lastR.x, e.lastR.y, e.lastR.w, e.lastR.h].map(v => Math.round(v * 100) / 100);
            const F = e.frozen ? e.mapF : rectOf(e.win.get_frame_rect());
            pieces.push({k: 'ov-live', r, op: Math.round(e.live.opacity * lay), st: Math.round(e.lastR.w / F.w * 1000) / 1000,
                held: e.frozen ? 1 : 0, box: mapR(e.live)});
            for (const p of e.pics)
                pieces.push({k: 'ov-pic', r, op: Math.round(p.actor.opacity * lay), st: Math.round(e.lastR.w / p.F.w * 1000) / 1000, kind: p.kind});
        }
        return {phase: e.phase, mode: e.mode, dir: e.dir, covering: e.layer.opacity > 0, d: e.lastD ?? null,
            ready: this._ready(e), frozen: e.frozen, layerOp: e.layer.opacity,
            chrome: e.chrome.map(c => ({n: c.src.get_name?.() || c.src.constructor.name, op: c.clone.opacity,
                t: [Math.round(c.clone.translation_x), Math.round(c.clone.translation_y)]})),
            pieces};
    }
}

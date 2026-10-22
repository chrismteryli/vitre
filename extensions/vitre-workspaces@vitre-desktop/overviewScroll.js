// SPDX-License-Identifier: GPL-3.0-or-later
// Vitre Workspaces: the overview's own workspace scroll on the Vitre stretch spring.
//
// Inside the overview GNOME moves from one workspace to the next by easing one value, the overview's workspace adjustment
// (ControlsManager._workspaceAdjustment, 1.0 = one workspace) over 250 ms ease-out cubic:
//   WorkspacesView._scrollToActive and WorkspacesDisplay._activeWorkspaceChanged   a key, a click on a workspace, the wheel
//   WorkspacesDisplay._switchWorkspaceEnd                                         a swipe inside the overview lets go
// Those handlers were bound when the shell started, before any extension loads, so they cannot be hooked; every one of them
// calls ease() on that one adjustment. This module gives that adjustment its own ease(): GNOME's ease still runs (the same
// target, the same callbacks, the same ownership of the transition, so GNOME's bookkeeping is untouched), but for that call
// the transition it builds is a ScrollTransition, whose value follows the spring of the desktop switch (springMath.js, the
// Vitre stretch: period 400 ms, damping 0.86):
//   - a key starts with the desktop's small push, so it moves on the first frame;
//   - a swipe's release starts at the fingers' speed (sampled while they move, the release estimator of Gesture History);
//   - a key pressed while the scroll still moves goes on from where the picture is, at its speed (GNOME stops and restarts
//     its ease there: two eases per key, one per view, each cancelling the last).
// Under the fingers nothing changes: GNOME sets the value one to one. A swipe that starts while a key's spring is still
// running takes the picture over where it is (GNOME's own ease kept writing the value under the fingers until it ended).
// The adjustment is only this module's while it is installed; vitre-swipe owns the overview's state adjustment (open and
// close) and Gesture History only that one's release, so nobody else writes this transition.
// Not changed: animations off (GNOME jumps), reduced motion (GNOME's own short ease), an ease of zero length.
// The overview closing while the spring still runs lands it at once (GNOME's callbacks run as if it had finished), so the
// value never stays between two workspaces behind a hidden overview.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {planSpring, estimateReleaseVelocity, SPRING} from './springMath.js';

const LOG = '[vitre-workspaces]';
const CARRY_MS = 40;            // an ease within this long after the last spring was stopped carries its speed on

// Rig only: the slow-motion factor for films (as the rest of Vitre's motion). Unset in a session.
const ENV_SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);
const slowNow = () => Math.max(1, Number(globalThis.__vitreMotionSlow) || ENV_SLOW);
const nowMs = () => GLib.get_monotonic_time() / 1000;

const warned = new Set();
function warnOnce(key, message) {
    if (warned.has(key))
        return;
    warned.add(key);
    console.warn(`${LOG} ${message}`);
}

function motionMode() {
    const s = St.Settings.get();
    if (!s.enable_animations)
        return 'off';
    try {
        const reduced = s.reduced_motion ?? s.reducedMotion;
        if (St.ReducedMotion && reduced === St.ReducedMotion.REDUCE)
            return 'reduce';
    } catch (_e) { /* no reduced-motion setting: full motion */ }
    return 'depth';
}

// The timeline runs LINEAR over the plan's length; the plan decides the value. The interval is set to [0, 1] once the
// transition exists, so the value handed to the interval IS the adjustment's value.
let ScrollTransition = null;
function scrollTransitionClass() {
    if (ScrollTransition)
        return ScrollTransition;
    ScrollTransition = GObject.registerClass({GTypeName: 'VitreWorkspacesScrollTransition'},
    class VitreWorkspacesScrollTransition extends Clutter.PropertyTransition {
        vfunc_compute_value(animatable, interval, progress) {
            const run = this._vitreRun;
            let value = progress;
            if (run) {
                try {
                    const t = Math.min(run.plan.T, Math.max(0, progress) * run.plan.T);
                    run.t = t;
                    value = run.plan.at(t);
                } catch (e) {
                    warnOnce('compute', `spring failed (${e.message}); finishing on a straight line`);
                    value = run.plan.from + (run.plan.to - run.plan.from) * progress;
                }
            }
            super.vfunc_compute_value(animatable, interval, value);
        }
    });
    return ScrollTransition;
}

export class OverviewScroll {
    constructor() {
        this._adj = null;
        this._display = null;
        this._ownEase = null;
        this._run = null;           // the spring scrolling now
        this._last = null;          // {pos, vel, at}: the spring that was stopped last (a new ease right after it carries on)
        this._gesture = false;      // fingers down inside the overview since the last ease
        this._samples = [];         // {time, delta} under the fingers, for the release speed
        this._lastValue = null;
        this._signals = [];
        this._installed = false;
        this.stats = {keys: 0, releases: 0, carries: 0, handOffs: 0, landed: 0, stock: 0, errors: 0};
        this.last = null;           // the last plan started (rig)
    }

    install() {
        const controls = Main.overview?._overview?.controls;
        const adj = controls?._workspaceAdjustment;
        const display = controls?._workspacesDisplay;
        if (!(adj instanceof St.Adjustment) || typeof adj.get_transition !== 'function' || !display?._swipeTracker)
            throw new Error('the overview workspace adjustment was not found');
        if (Object.hasOwn(adj, 'ease'))
            throw new Error('the overview workspace adjustment already has its own ease()');
        scrollTransitionClass();
        const self = this;
        const ownEase = function (target, params) {
            return self._ease(this, target, params);
        };
        adj.ease = ownEase;
        this._ownEase = ownEase;
        this._adj = adj;
        this._display = display;
        this._lastValue = adj.value;
        this._connect(display._swipeTracker, 'begin', () => this._onGestureBegin());
        this._connect(adj, 'notify::value', () => this._sample());
        this._connect(Main.overview, 'hiding', () => this._landNow('overview'));
        this._installed = true;
    }

    uninstall() {
        this._landNow('disable');
        for (const [obj, id] of this._signals.splice(0)) {
            try {
                obj.disconnect(id);
            } catch (_e) { /* gone */ }
        }
        const adj = this._adj;
        if (adj && Object.hasOwn(adj, 'ease')) {
            if (adj.ease === this._ownEase)
                delete adj.ease;
            else
                console.warn(`${LOG} the overview adjustment's ease was replaced after this extension; it is left as it is`);
        }
        this._adj = null;
        this._display = null;
        this._ownEase = null;
        this._run = null;
        this._last = null;
        this._samples = [];
        this._gesture = false;
        this._installed = false;
    }

    _connect(obj, name, fn) {
        this._signals.push([obj, obj.connect(name, (...args) => {
            try {
                fn(...args);
            } catch (e) {
                this._fail(name, e);
            }
        })]);
    }

    _fail(key, e) {
        this.stats.errors++;
        warnOnce(`ov-${key}`, `overview ${key}: ${e?.message ?? e}; GNOME's own scroll is used here`);
        if (GLib.getenv('VITRE_WS_DEBUG'))
            console.warn(`${LOG} ${e?.stack ?? ''}`);
    }

    // ---- the ease ---------------------------------------------------------------------------------------------------------

    _ease(adj, target, params) {
        const stock = St.Adjustment.prototype.ease;
        // the first ease after the fingers went down is their release (or GNOME's cancel, which has no length)
        const release = this._gesture && Boolean(this._display?._gestureActive);
        this._gesture = false;
        let plan = null;
        try {
            plan = this._plan(adj, target, params, release);
        } catch (e) {
            this._fail('plan', e);
        }
        if (!plan) {
            this.stats.stock++;
            this._samples = [];
            return stock.call(adj, target, params);
        }
        try {
            if (this._start(adj, target, params, plan, stock))
                return undefined;
        } catch (e) {
            this._fail('start', e);
            if (adj.get_transition('value') instanceof ScrollTransition)
                return undefined;           // ours is running; GNOME's callbacks are attached to it
        }
        return stock.call(adj, target, params);
    }

    _plan(adj, target, params, release) {
        if (motionMode() !== 'depth' || !(params?.duration > 0) || !Number.isFinite(target) || !adj.get_actor?.()?.mapped)
            return null;
        const from = adj.value;
        const dir = Math.sign(target - from);
        // where it was going and how fast: the spring running now, or one stopped a moment ago (GNOME stops it right before
        // it eases again)
        let vel = null;
        const prev = this._run && !this._run.done ? this._run : null;
        if (prev)
            vel = prev.plan.vel(prev.t);
        else if (this._last && nowMs() - this._last.at < CARRY_MS && Math.abs(this._last.pos - from) < 1e-6)
            vel = this._last.vel;
        let kind, v0;
        if (release) {
            kind = 'release';
            v0 = this._releaseVelocity();
        } else if (vel !== null && Number.isFinite(vel)) {
            kind = 'carry';
            const d = dir || Math.sign(vel);
            v0 = vel * d >= 0 ? d * Math.max(Math.abs(vel), SPRING.kbdPush) : vel;
        } else {
            kind = 'key';
            v0 = dir * SPRING.kbdPush;
        }
        this._samples = [];
        const unitPx = Math.max(1, this._display?.width || global.screen_width || 1920);
        const plan = planSpring({from, to: target, v0, unitPx});
        if (!plan || !(plan.T > 0))
            return null;
        plan.kind = kind;
        return plan;
    }

    _start(adj, target, params, plan, stock) {
        const Klass = scrollTransitionClass();
        // GNOME scales every ease by its slow-down factor; the spring keeps its own time, as the desktop switch does
        const slowDown = St.Settings.get().slow_down_factor || 1;
        const run = {plan, kind: plan.kind, target, t: 0, done: false, landNow: false,
            onStopped: params.onStopped ?? null, onComplete: params.onComplete ?? null};
        const p = {...params, duration: Math.max(1, plan.T * slowNow() / slowDown), mode: Clutter.AnimationMode.LINEAR,
            onStopped: finished => this._ended(adj, run, finished)};
        delete p.onComplete;
        // GNOME's ease builds its transition with `new Clutter.PropertyTransition(...)`: for this one call it builds ours
        const Original = Clutter.PropertyTransition;
        let swapped = false;
        try {
            Clutter.PropertyTransition = Klass;
            swapped = Clutter.PropertyTransition === Klass;
        } catch (e) {
            warnOnce('swap', `cannot build the scroll transition (${e.message}); GNOME's ease is used`);
        }
        if (!swapped)
            return false;
        try {
            stock.call(adj, target, p);
        } finally {
            try {
                Clutter.PropertyTransition = Original;
            } catch (e) {
                warnOnce('restore', `could not restore Clutter.PropertyTransition: ${e.message}`);
            }
        }
        const tr = adj.get_transition('value');
        if (!(tr instanceof Klass)) {
            // not ours after all: its callbacks are ours, so it must still end exactly where GNOME's would
            if (tr) {
                tr.progress_mode = params.mode ?? Clutter.AnimationMode.EASE_OUT_CUBIC;
                warnOnce('adopt', "the scroll transition was not created; GNOME's curve is used");
            }
            return true;
        }
        tr._vitreRun = run;
        tr.set_from(0);
        tr.set_to(1);
        this._run = run;
        this.stats[plan.kind === 'release' ? 'releases' : plan.kind === 'carry' ? 'carries' : 'keys']++;
        this.last = {kind: plan.kind, from: plan.from, to: plan.to, v0: plan.v0, T: plan.T, Tlogic: plan.Tlogic,
            period: plan.periodMs ?? null, slow: slowNow(), at: Math.round(nowMs())};
        return true;
    }

    // GNOME's completion callback for our transition: finished, removed (another ease, a swipe, the workspace count changed),
    // or landed at once by _landNow
    _ended(adj, run, finished) {
        if (run.done)
            return;
        run.done = true;
        if (this._run === run)
            this._run = null;
        let done = finished;
        if (!finished && run.landNow) {
            done = true;
            this.stats.landed++;
            try {
                if (adj.value !== run.target)
                    adj.value = run.target;
            } catch (e) {
                this._fail('land', e);
            }
        } else if (!finished) {
            this._last = {pos: adj.value, vel: run.plan.vel(run.t), at: nowMs()};
        }
        try {
            run.onStopped?.(done);
        } finally {
            if (done)
                run.onComplete?.();
        }
    }

    // the overview is closing (or this is being turned off) while the spring runs: land it now
    _landNow(why) {
        const run = this._run;
        const adj = this._adj;
        if (!run || run.done || !adj)
            return;
        run.landNow = why;
        try {
            adj.remove_transition('value');
        } catch (e) {
            this._fail('land', e);
        }
        if (!run.done)
            this._ended(adj, run, false);
    }

    // ---- under the fingers -------------------------------------------------------------------------------------------------

    _onGestureBegin() {
        const display = this._display;
        if (!display?._gestureActive)
            return;                 // GNOME did not take this swipe (a monitor without workspaces)
        this._gesture = true;
        this._samples = [];
        this._lastValue = this._adj.value;
        const run = this._run;
        if (run && !run.done && this._adj.get_transition('value')) {
            // a key's spring still runs (GNOME only stops a release here): the fingers take the picture where it is
            this.stats.handOffs++;
            this._adj.remove_transition('value');
        }
    }

    _sample() {
        const adj = this._adj;
        if (!adj)
            return;
        const v = adj.value;
        if (this._gesture && this._display?._gestureActive && !adj.get_transition('value')) {
            const time = this._eventTime();
            const s = this._samples;
            const lastS = s[s.length - 1];
            if (lastS && time - lastS.time > 100)
                s.length = 0;
            s.push({time, delta: s.length ? v - this._lastValue : 0});
            while (s.length > 64)
                s.shift();
        }
        this._lastValue = v;
    }

    _eventTime() {
        const t = Clutter.get_current_event_time();
        if (t > 0)
            return t;
        const h = this._display?._swipeTracker?._history?._data;
        if (Array.isArray(h) && h.length && Number.isFinite(h[h.length - 1].time))
            return h[h.length - 1].time;
        return nowMs();
    }

    _releaseVelocity() {
        const s = this._samples;
        if (!s.length)
            return 0;
        const stamp = this._display?._swipeTracker?._history?._releaseStamp;
        const now = Clutter.get_current_event_time();
        const rel = Number.isFinite(stamp) && stamp >= s[s.length - 1].time ? stamp : now > 0 ? now : NaN;
        const v = estimateReleaseVelocity(s, rel, 0);
        return Number.isFinite(v) ? v : 0;
    }

    // ---- rig -----------------------------------------------------------------------------------------------------------

    snapshot() {
        const r = this._run;
        return {installed: this._installed, own: Boolean(this._adj && this._adj.ease === this._ownEase),
            value: this._adj?.value ?? null, gesture: this._gesture, samples: this._samples.length,
            run: r ? {kind: r.kind, t: r.t, T: r.plan.T, from: r.plan.from, to: r.plan.to, v0: r.plan.v0} : null,
            stats: {...this.stats}, last: this.last};
    }
}

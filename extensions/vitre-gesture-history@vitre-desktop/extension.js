// Gesture History v2 (A5).
//
// 1. (v1, unchanged) GNOME 51's EventHistory.trim() keeps every old sample when all of them are older than the 150 ms
//    window (findIndex() returns -1, splice(0, -1) deletes nothing), so a release after a hold inherits an old flick.
//    The fix resets the history in exactly that case.
//
// 2. (v2) Three-finger overview and workspace swipes: on lift-off the animation continues at the fingers' speed.
//    GNOME 51 discards the release velocity and eases with EASE_OUT_CUBIC over |distance / v| x 3 ms, then
//    clamps it to [100 ms, 400 ms x log2(1 + n)], and St scales every ease by Just Perfection's slow-down (0.8), so the
//    first animated frame starts at a different speed than the fingers (rig numbers in README.txt).  Here:
//      - SwipeTracker._endGesture notes the release (a better fingers' speed than GNOME's 150 ms average),
//      - ControlsManager.gestureEnd (overview) and MonitorGroup.ease_property (workspace swipe) run the SAME ease
//        GNOME would, but the transition is a ReleaseTransition whose value follows a critically damped spring that
//        starts at the fingers' speed and ends exactly on the target.  Same target, same onComplete, same ownership;
//        a new gesture removes the transition exactly as before.  Animations off: GNOME jumps, so do we.
//    This is NOT Spring Motion: no global ease wrapper, no change to any non-gesture animation.
//    Everything is guarded: a missing class or method is logged once and GNOME's behaviour is left alone.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwipeTrackerModule from 'resource:///org/gnome/shell/ui/swipeTracker.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import {estimateReleaseVelocity, planRelease, springProgress} from './releaseMotion.js';

// Matches the installed GNOME 51 EventHistory threshold; not an the reference constant.
const HISTORY_WINDOW_MS = 150;
const LOG_TAG = '[gesture-history]';

export function discardExpiredHistory(history, time) {
    const data = history?._data;
    if (!Array.isArray(data) || !data.length || !Number.isFinite(time) ||
        typeof history.reset !== 'function')
        return;
    const threshold = time - HISTORY_WINDOW_MS;
    // Retain the native inclusive boundary and mixed/recent sample handling.
    if (data.every(sample => Number.isFinite(sample.time) && sample.time < threshold))
        history.reset();
}

// -- shared state (module level: the transition class and the pending release outlive enable/disable) -----------------
const state = {
    pending: null,          // the release being handled inside SwipeTracker._endGesture (null at all other times)
    last: null,             // the last release that was taken over (rig/debug)
    TransitionClass: null,
    warned: new Set(),
};

function warnOnce(key, message) {
    if (state.warned.has(key))
        return;
    state.warned.add(key);
    console.warn(`${LOG_TAG} ${message}`);
}

function getTransitionClass() {
    if (state.TransitionClass)
        return state.TransitionClass;
    state.TransitionClass = GObject.registerClass(
    class GestureReleaseTransition extends Clutter.PropertyTransition {
        // GNOME's ease() builds a PropertyTransition; while a release is being taken over it builds this one. The
        // timeline runs in LINEAR mode, so `progress` is elapsed / duration and the spring decides the value.
        vfunc_compute_value(animatable, interval, progress) {
            const plan = this._releasePlan;
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
    return state.TransitionClass;
}

// -- release capture -------------------------------------------------------------------------------------------------

function captureRelease(tracker, velocity, distance, isTouchpad) {
    if (!(distance > 0))
        return null;
    const gnomeV = Number.isFinite(velocity) ? velocity / distance : 0;
    let v;
    if (tracker._cancelled) {
        v = 0;
    } else if (isTouchpad) {
        const history = tracker._history;
        v = estimateReleaseVelocity(history?._data, history?._releaseStamp, Number.isFinite(velocity) ? velocity : 0) / distance;
    } else {
        v = gnomeV;                       // touchscreen / pan gesture: GNOME's own end velocity, per progress unit
    }
    return {tracker, v, gnomeV, distance, isTouchpad};
}

// Replaces the stock ease for one release.  `call(params)` runs GNOME's own ease with the given params.
function runRelease(kind, owner, prop, target, params, rel, basePx, call) {
    const TransitionClass = state.TransitionClass;
    let plan = null;
    try {
        const slow = St.Settings.get().slow_down_factor;
        plan = planRelease(owner[prop], target, rel.v, slow, basePx);
        if (plan)
            plan.slow = slow;
    } catch (e) {
        warnOnce('plan', `could not plan a release (${e.message}); GNOME's animation is used`);
    }
    if (!plan || !TransitionClass || !params || !(params.duration > 0))
        return call(params);

    const Original = Clutter.PropertyTransition;
    let swapped = false;
    try {
        Clutter.PropertyTransition = TransitionClass;
        swapped = Clutter.PropertyTransition === TransitionClass;
    } catch (e) {
        warnOnce('swap', `cannot build the release transition (${e.message}); GNOME's animation is used`);
    }
    if (!swapped)
        return call(params);

    let result;
    try {
        result = call({...params, mode: Clutter.AnimationMode.LINEAR});
    } finally {
        try {
            Clutter.PropertyTransition = Original;
        } catch (e) {
            warnOnce('restore', `could not restore Clutter.PropertyTransition: ${e.message}`);
        }
    }
    try {
        const transition = owner.get_transition(prop);
        if (transition instanceof TransitionClass) {
            transition._releasePlan = plan;
            transition.set_duration(plan.T);
            state.last = {
                kind, start: plan.start, target: plan.target, e0: plan.e0, v0: plan.v0, w: plan.w, T: plan.T,
                slow: plan.slow, gnomeV: rel.gnomeV, touchpad: rel.isTouchpad,
            };
        } else if (transition) {
            // could not take the transition over: put the stock curve back
            transition.progress_mode = params.mode ?? Clutter.AnimationMode.EASE_OUT_CUBIC;
            warnOnce('adopt', 'the release transition was not created; GNOME\'s curve was restored');
        }
    } catch (e) {
        warnOnce('adopt2', `release hand-off failed (${e.message})`);
    }
    return result;
}

// -- the extension ---------------------------------------------------------------------------------------------------

export default class GestureHistoryFix extends Extension {
    get lastRelease() {
        return state.last;
    }

    enable() {
        this._injections = new InjectionManager();
        this._protoRestores = [];
        try {
            // SwipeTracker binds its signal callbacks before extensions load.
            // Those callbacks dynamically invoke this shared history method,
            // so existing and future trackers both see enable/disable changes.
            const history = Main.wm?._workspaceAnimation?._swipeTracker?._history;
            const prototype = history && Object.getPrototypeOf(history);
            if (!Array.isArray(history?._data) || !prototype ||
                ['trim', 'append', 'reset', 'calculateVelocity'].some(
                    name => typeof prototype[name] !== 'function'))
                throw new Error('unsupported GNOME 51 gesture history');
            this._injections.overrideMethod(prototype, 'trim', original =>
                function (time) {
                    // the last trim before _endGesture is the release event's own time (see _endTouchpadGesture)
                    if (Number.isFinite(time))
                        this._releaseStamp = time;
                    discardExpiredHistory(this, time);
                    return original.call(this, time);
                });
        } catch (error) {
            this._injections.clear();
            this._injections = null;
            throw error;
        }
        try {
            this._installRelease();
        } catch (e) {
            warnOnce('install', `release hand-off not installed (${e.message}); GNOME's animation is left as is`);
            this._restoreProtos();
        }
    }

    disable() {
        this._restoreProtos();
        this._injections?.clear();
        this._injections = null;
        state.pending = null;
    }

    _restoreProtos() {
        for (const restore of this._protoRestores?.splice(0).reverse() ?? []) {
            try {
                restore();
            } catch (e) {
                warnOnce('uninstall', `restore failed: ${e.message}`);
            }
        }
    }

    // override proto[name] with make(original); undone by _restoreProtos (puts back an own property or removes ours)
    _override(proto, name, make) {
        const hadOwn = Object.hasOwn(proto, name);
        const original = proto[name];
        proto[name] = make(original);
        const installed = proto[name];
        this._protoRestores.push(() => {
            if (proto[name] !== installed)
                return;                       // somebody else wrapped it after us: leave their chain alone
            if (hadOwn)
                proto[name] = original;
            else
                delete proto[name];
        });
    }

    _installRelease() {
        const SwipeTracker = SwipeTrackerModule.SwipeTracker;
        const ControlsManager = OverviewControls.ControlsManager;
        const MonitorGroup = WorkspaceAnimation.MonitorGroup;
        const missing = [];
        if (typeof SwipeTracker?.prototype?._endGesture !== 'function')
            missing.push('SwipeTracker._endGesture');
        if (typeof Clutter.PropertyTransition !== 'function' || typeof Clutter.Timeline?.prototype?.set_duration !== 'function')
            missing.push('Clutter.PropertyTransition');
        if (missing.length) {
            warnOnce('missing', `${missing.join(', ')} not found; GNOME's release animation is left as is`);
            return;
        }
        getTransitionClass();

        // 1. note the release before GNOME discards it
        this._override(SwipeTracker.prototype, '_endGesture', original =>
            function (velocity, distance, isTouchpad) {
                let rel = null;
                try {
                    rel = captureRelease(this, velocity, distance, isTouchpad);
                } catch (e) {
                    warnOnce('capture', `could not read the release velocity (${e.message})`);
                }
                const previous = state.pending;
                state.pending = rel;
                try {
                    return original.call(this, velocity, distance, isTouchpad);
                } finally {
                    state.pending = previous;
                }
            });

        // 2. overview: ControlsManager.gestureEnd eases the state adjustment
        if (typeof ControlsManager?.prototype?.gestureEnd === 'function') {
            this._override(ControlsManager.prototype, 'gestureEnd', original =>
                function (target, duration, onComplete) {
                    const rel = state.pending;
                    if (!rel || rel.tracker !== Main.overview?._swipeTracker || !this._stateAdjustment)
                        return original.call(this, target, duration, onComplete);
                    const adjustment = this._stateAdjustment;
                    const stockEase = adjustment.ease;
                    adjustment.ease = function (to, params) {
                        delete adjustment.ease;
                        return runRelease('overview', adjustment, 'value', to, params, rel, global.screen_height,
                            p => stockEase.call(adjustment, to, p));
                    };
                    try {
                        return original.call(this, target, duration, onComplete);
                    } finally {
                        if (Object.hasOwn(adjustment, 'ease'))
                            delete adjustment.ease;
                    }
                });
        } else {
            warnOnce('controls', 'ControlsManager.gestureEnd not found; the overview swipe keeps GNOME\'s release');
        }

        // 3. workspace swipe: WorkspaceAnimationController._switchWorkspaceEnd was bound before we loaded, so hook the
        //    MonitorGroup ease it calls; only active inside the workspace tracker's own _endGesture
        if (typeof MonitorGroup?.prototype?.ease_property === 'function') {
            this._override(MonitorGroup.prototype, 'ease_property', original =>
                function (propName, target, params) {
                    const rel = state.pending;
                    if (!rel || propName !== 'progress' ||
                        rel.tracker !== Main.wm?._workspaceAnimation?._swipeTracker)
                        return original.call(this, propName, target, params);
                    return runRelease('workspace', this, 'progress', target, params, rel, this.baseDistance,
                        p => original.call(this, propName, target, p));
                });
        } else {
            warnOnce('monitor', 'MonitorGroup.ease_property not found; the workspace swipe keeps GNOME\'s release');
        }
    }
}

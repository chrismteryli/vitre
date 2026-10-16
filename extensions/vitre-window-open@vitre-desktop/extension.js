// Vitre window motion (B19, 2026-10-15).
//
// One motion language for a window's whole life, taken from the Stage swaps he likes (a window flies between a small
// picture and its place and clicks in):
//
//   restore      the window flies out of its Dock button: it rises first, then slides across (a slight arc, as if lifted
//                out of the Dock), grows from the button's size and clicks into place (1 % overshoot), 460 ms
//   minimize     the exact reverse: a 1 % wind-up, then it slides into the Dock button, staying opaque until the
//                last moment, 400 ms
//   open         a new window grows 0.9 -> 1 about its centre while it fades in, 300 ms (no travel, no extra layers)
//   close        it shrinks to 0.92 and fades, 200 ms
//   dialogs, transient windows, Stage's own swaps and parks, show-desktop: untouched (GNOME, or their owner)
//
// The Dock button is the one that was clicked (Dhruva tells us through global.__vitreWindowMotion.noteOrigin), else
// the app's button in the Dock; a window with no button (or minimized by the Desktop button) shrinks in place.
//
// How it works: GNOME's own map / minimize / unminimize / destroy handlers keep ownership of the effect and of its
// completion (completed_*). This extension runs after them and reshapes the transitions GNOME's ease() created
// (start, end, duration, curve), and adds translation and opacity transitions of its own with the same length. Only
// properties rounded-window-corners mirrors onto its shadow are moved (scale, translation, opacity, pivot), so the
// shadow travels with the window. Durations are absolute (set on the Clutter transitions, so Just Perfection's
// slow-down factor does not stretch them). Reduced motion or animations off: GNOME's behaviour, untouched.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Rig only: VITRE_MOTION_SLOW=8 plays every motion 8 times slower, for filmstrips. Unset in a session.
const SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);

// Progress curves are cubic-bezier(x1, y1, x2, y2), as in CSS. A y above 1 overshoots and comes back.
const rev = ([x1, y1, x2, y2]) => [1 - x2, 1 - y2, 1 - x1, 1 - y1];    // the same curve played backwards

const RESTORE = {
    ms: 460,
    x: [0.4, 0.55, 0.3, 1],         // across: starts later than the rise ...
    y: [0.18, 0.9, 0.3, 1],         // ... up: lifts out of the Dock first
    scale: [0.3, 0.8, 0.3, 1.035],  // grows, ~1 % past its size at 85 %, clicks back
    fade: [0.05, 0.9, 0.3, 1],      // visible from the first frames
};
const MOTION = {
    restore: RESTORE,
    minimize: {ms: 400, x: rev(RESTORE.y), y: rev(RESTORE.x), scale: rev(RESTORE.scale), fade: rev(RESTORE.fade)},
    // no Dock button: in place
    restoreInPlace: {ms: 300, from: 0.88, scale: [0.2, 0.85, 0.3, 1], fade: [0.15, 0.85, 0.35, 1]},
    minimizeInPlace: {ms: 220, to: 0.88, scale: [0.4, 0, 0.6, 1], fade: [0.45, 0, 0.75, 0.5]},
    open: {ms: 300, from: 0.9, scale: [0.2, 0.85, 0.3, 1], fade: [0.15, 0.85, 0.35, 1]},
    close: {ms: 200, to: 0.92, scale: [0.3, 0, 0.1, 1], fade: [0.4, 0, 0.6, 1]},
};
const LINEAR = [0, 0, 1, 1];

// Launch feedback (B25): the Dock icon hops (rises 38 % of its height and falls with a small squash, 0.62 s a hop) until a
// window of the app appears, at most 8 s; the hop in flight always finishes, so the icon never stops in the air.
const HOP = {rise: 0.38, upMs: 250, downMs: 230, squashMs: 140, squash: 0.9, maxMs: 8000};
const ORIGIN_TTL_US = 1500 * 1000;  // a Dock click names the button for this long

// ---- helpers ---------------------------------------------------------------

// Shape a transition: absolute duration and a cubic-bezier progress curve.
function shape(transition, ms, [x1, y1, x2, y2]) {
    transition.set_duration(Math.max(1, Math.round(ms * SLOW)));
    transition.set_cubic_bezier_progress(new Graphene.Point({x: x1, y: y1}), new Graphene.Point({x: x2, y: y2}));
}

// A transition of our own on `prop` from `from` to `to`; `after` runs when it stops (finished or removed: GNOME's
// Done removes every transition when its effect ends).
function own(actor, prop, from, to, ms, curve, after = null) {
    actor[prop] = from;
    actor.ease({
        [prop]: to,
        duration: 1000,     // replaced below (ease() would scale it by the slow-down factor)
        mode: Clutter.AnimationMode.LINEAR,
        onStopped: after ?? undefined,
    });
    const t = actor.get_transition(prop.replace(/_/g, '-'));
    if (t)
        shape(t, ms, curve);
}

// Retarget one of GNOME's transitions (it may be the one that carries GNOME's completion).
function retarget(t, ms, curve, {from, to} = {}) {
    if (!t)
        return;
    if (from !== undefined)
        t.set_from(from);
    if (to !== undefined)
        t.set_to(to);
    shape(t, ms, curve);
}

const finalValue = transition => {
    try {
        return transition?.get_interval()?.peek_final_value();
    } catch {
        return undefined;
    }
};

function rectOf(actor) {
    if (!actor?.get_stage?.() || !actor.mapped)
        return null;
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return [x, y, w, h].every(Number.isFinite) && w > 1 && h > 1 ? {x, y, w, h} : null;
}

// The Dock (Dhruva) containers, found once and re-found when gone.
function findDocks() {
    const found = [];
    const walk = (a, depth) => {
        if (a.get_name?.() === 'DhruvaContainer' && a._dockUI) {
            found.push(a._dockUI);
            return;
        }
        if (depth < 4)
            for (const c of a.get_children?.() ?? [])
                walk(c, depth + 1);
    };
    walk(Main.layoutManager.uiGroup, 0);
    return found;
}

// The classification rule (the rig uses it on stand-in objects): 'native' (GNOME's own) or 'window'.
//   info: {attachedDialog, transient, animationType}
export function classify(info) {
    if (info.attachedDialog || info.transient || info.animationType !== Meta.WindowType.NORMAL)
        return 'native';
    return 'window';
}

export default class WindowMotion extends Extension {
    enable() {
        this._log = [];
        this._noted = new Map();        // window -> {btn, at}
        this._docks = [];
        const wm = global.window_manager;
        // 'after' handlers run once GNOME's own handler (and Dhruva's) have set up the effect
        this._ids = [
            wm.connect_after('map', (_wm, actor) => this._guard('map', actor, () => this._onMap(actor))),
            wm.connect_after('destroy', (_wm, actor) => this._guard('destroy', actor, () => this._onDestroy(actor))),
            wm.connect_after('minimize', (_wm, actor) => this._guard('minimize', actor, () => this._onMinimize(actor))),
            wm.connect_after('unminimize', (_wm, actor) => this._guard('unminimize', actor, () => this._onUnminimize(actor))),
        ];
        this._hops = new Map();         // app id -> {actor, stop}
        global.__vitreWindowMotion = {
            launchHop: (actor, appId) => this._launchHop(actor, appId),
            noteOrigin: (win, btn) => {
                if (this._noted)
                    this._noted.set(win, {btn, at: GLib.get_monotonic_time()});
            },
        };
    }

    disable() {
        for (const id of this._ids ?? [])
            global.window_manager.disconnect(id);
        this._ids = null;
        if (global.__vitreWindowMotion)
            delete global.__vitreWindowMotion;
        for (const hop of this._hops?.values() ?? [])
            hop.stop();
        this._hops = null;
        this._noted = null;
        this._docks = null;
        this._log = null;
    }

    // The icon (an St.Bin inside the app's Dock button) as it is now: the Dock rebuilds its icons whenever an app changes state
    // (right after a launch click), so the hop looks it up again at every hop and whenever the one it was moving has gone.
    _iconOf(appId) {
        if (!this._docks?.length || this._docks.some(d => !d.boxActor?.get_stage?.()))
            this._docks = findDocks();
        const bin = a => a instanceof St.Bin ? a : [...(a.get_children?.() ?? [])].map(bin).find(Boolean);
        for (const dock of this._docks) {
            for (const btn of dock.boxActor?.get_children?.() ?? []) {
                if (btn._delegate?.app?.get_id?.() === appId) {
                    const b = bin(btn);
                    if (b?.get_stage?.())
                        return b;
                }
            }
        }
        return null;
    }

    _launchHop(first, appId) {
        if (!first || !this._hops || this._reduced())
            return;
        this._hops.get(appId)?.stop();
        let stopped = false;
        let cur = first;
        let lostAt = 0;
        let gen = 0;                     // a step of an older run (its icon replaced meanwhile) must not carry on
        const alive = a => a?.get_stage?.() && !a.is_destroyed?.();
        const rest = a => {
            if (alive(a)) {
                a.remove_all_transitions();
                a.translation_y = 0;
                a.set_scale(1, 1);
                a.set_pivot_point(0.5, 0.5);
            }
        };
        const trace = (what, extra = '') => this._note({meta_window: null}, `hop:${what}`, `${appId} alive=${Boolean(alive(cur))} ty=${cur?.translation_y?.toFixed?.(1)} ${extra}`);
        const finish = () => {
            trace('finish');
            gen++;
            if (beat)
                GLib.Source.remove(beat);
            beat = 0;
            disconnectApp();
            // every icon the Dock shows for the app is put at rest: a rebuilt icon can start from the old one's lifted pose, and a
            // rebuild can come just after the end
            const settle = () => {
                rest(cur);
                rest(this._iconOf(appId));
            };
            settle();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                if (this._hops)
                    rest(this._iconOf(appId));
                return GLib.SOURCE_REMOVE;
            });
            if (this._hops?.get(appId) === hop)
                this._hops.delete(appId);
        };
        // one hop = up, down, squash, release; every step checks that its icon still exists (then carries on with the new one)
        const next = () => {
            const mine = ++gen;
            if (stopped)
                return finish();
            if (!alive(cur)) {
                trace('icon-lost');
                cur = this._iconOf(appId);
                trace('icon-found', String(Boolean(cur)));
                if (!cur) {
                    lostAt = lostAt || GLib.get_monotonic_time();
                    if (GLib.get_monotonic_time() - lostAt > 1500 * 1000)
                        return finish();
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        if (gen === mine)
                            next();
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                lostAt = 0;
                rest(cur);
            }
            const a = cur;
            const h = Math.max(8, a.height * HOP.rise);
            const step = (props, ms, mode, then) => {
                if (gen !== mine)
                    return;
                if (!alive(a))
                    return next();
                a.ease({...props, duration: Math.max(1, ms * SLOW), mode, onComplete: () => {
                    if (gen === mine)
                        then();
                }});
            };
            a.set_pivot_point(0.5, 1.0);
            const M = Clutter.AnimationMode;
            step({translation_y: -h, scale_y: 1.04, scale_x: 0.98}, HOP.upMs, M.EASE_OUT_QUAD, () =>
                step({translation_y: 0, scale_y: 1, scale_x: 1}, HOP.downMs, M.EASE_IN_QUAD, () =>
                    step({scale_y: HOP.squash, scale_x: 1 + (1 - HOP.squash) * 0.6}, HOP.squashMs * 0.4, M.EASE_OUT_QUAD, () =>
                        step({scale_y: 1, scale_x: 1}, HOP.squashMs * 0.6, M.EASE_OUT_QUAD, next))));
        };
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOP.maxMs, () => {
            stop();
            return GLib.SOURCE_REMOVE;
        });
        // the hop in flight finishes its cycle (the icon never stops in the air); stopping at rest is immediate
        const stop = () => {
            if (stopped)
                return;
            stopped = true;
            trace('stop');
            GLib.Source.remove(timeout);
            if (cur && alive(cur) && cur.translation_y === 0 && !cur.get_transition('translation-y') && !cur.get_transition('scale-y'))
                finish();
        };
        const hop = {actor: first, stop};
        this._hops.set(appId, hop);
        // the app has a window now (its window may not be tied to the app yet when it maps: the app announces it)
        const app = Shell.AppSystem.get_default().lookup_app(appId);
        const had = app ? app.get_windows().length : 0;
        const wid = app?.connect('windows-changed', () => {
            if (app.get_windows().length > had)
                stop();
        });
        const disconnectApp = () => {
            if (wid)
                app.disconnect(wid);
        };
        // a destroyed icon never completes its transition: this notices it and the hop carries on with the new one
        let beat = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (!alive(cur))
                next();             // (a stopped hop whose icon has gone finishes there)
            return beat ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        next();
        this._note({meta_window: null}, 'launch-hop', appId);
    }

    _guard(ev, actor, fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`Vitre window motion: ${ev} left to GNOME (${e.message})`);
        }
    }

    // last decisions (capped), read by the rig
    _note(actor, ev, kind) {
        if (!this._log)
            return;
        this._log.push({title: actor.meta_window?.get_title() ?? null, ev, kind});
        if (this._log.length > 64)
            this._log.shift();
    }

    _reduced() {
        const settings = St.Settings.get();
        return settings.reducedMotion === St.ReducedMotion.REDUCE || !settings.enableAnimations;
    }

    _kind(actor) {
        const window = actor.meta_window;
        return classify({
            attachedDialog: window.is_attached_dialog(),
            transient: window.get_transient_for() !== null,
            animationType: Main.wm._getAnimationWindowType(actor),
        });
    }

    // Where a window goes to / comes from in the Dock: the button that was just clicked for it, else its app's button.
    // null: in place (no button, or the Desktop button minimized it).
    _origin(win) {
        const noted = this._noted?.get(win);
        this._noted?.delete(win);
        if (noted && GLib.get_monotonic_time() - noted.at < ORIGIN_TTL_US) {
            if (noted.btn === null)
                return null;
            const r = rectOf(noted.btn);
            if (r)
                return this._clampToMonitor(r, win);
        }
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app)
            return null;
        if (!this._docks?.length || this._docks.some(d => !d.boxActor?.get_stage?.()))
            this._docks = findDocks();
        const monitor = win.get_monitor();
        const rects = [];
        for (const dock of this._docks) {
            for (const btn of dock.boxActor?.get_children?.() ?? []) {
                const a = btn._delegate?.app;
                if (a && typeof a.get_id === 'function' && a.get_id() === app.get_id()) {
                    const r = rectOf(btn);
                    if (r)
                        rects.push(r);
                }
            }
        }
        if (!rects.length)
            return null;
        const geo = global.display.get_monitor_geometry(monitor);
        const onMonitor = rects.find(r => r.x + r.w / 2 >= geo.x && r.x + r.w / 2 < geo.x + geo.width);
        return this._clampToMonitor(onMonitor ?? rects[0], win);
    }

    // A hidden Dock's buttons sit below the screen: aim at the bottom edge under them.
    _clampToMonitor(r, win) {
        const geo = global.display.get_monitor_geometry(win.get_monitor());
        const cx = Math.min(geo.x + geo.width - r.w / 2, Math.max(geo.x + r.w / 2, r.x + r.w / 2));
        const cy = Math.min(geo.y + geo.height - r.h * 0.3, Math.max(geo.y + r.h / 2, r.y + r.h / 2));
        return {x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h};
    }

    // Scale and translation (about the actor's centre) that put the window's frame on `r`: the frame is `s` of its
    // size and centred on the button. The actor is the buffer (frame plus the client's shadow), at (ax, ay).
    _pose(actor, win, r, ax = actor.x, ay = actor.y) {
        const f = win.get_frame_rect();
        const s = Math.min(1, Math.max(0.02, r.w / Math.max(1, f.width)));
        const c = {x: ax + actor.width / 2, y: ay + actor.height / 2};
        const fc = {x: f.x + f.width / 2 + (ax - actor.x), y: f.y + f.height / 2 + (ay - actor.y)};
        return {s, tx: r.x + r.w / 2 - c.x - s * (fc.x - c.x), ty: r.y + r.h / 2 - c.y - s * (fc.y - c.y)};
    }

    // ---- open ----

    _onMap(actor) {
        if (this._hops?.size && actor.meta_window) {
            const app = Shell.WindowTracker.get_default().get_window_app(actor.meta_window);
            if (app)
                this._hops.get(app.get_id())?.stop();
        }
        if (!actor.meta_window || !Main.wm._mapping?.has(actor) || this._reduced())
            return;
        const kind = this._kind(actor);
        this._note(actor, 'map', kind);
        if (kind === 'native' || actor.get_transition('scale-x'))
            return;
        const m = MOTION.open;
        actor.set_pivot_point(0.5, 0.5);
        actor.set_scale(m.from, m.from);
        actor.opacity = 0;
        this._retargetOpen(actor).catch(() => {});
    }

    // GNOME's map handler awaits the overview before it calls ease(); awaiting the same promise here queues this
    // continuation after GNOME's, so its transitions exist when it runs.
    async _retargetOpen(actor) {
        await Main.wm._waitForOverviewToHide();
        if (!Main.wm._mapping?.has(actor))
            return;
        const m = MOTION.open;
        const opacity = actor.get_transition('opacity');
        const sx = actor.get_transition('scale-x');
        const sy = actor.get_transition('scale-y');
        // only the exact native opening (nothing another owner chose)
        if (!opacity || finalValue(opacity) !== 255 || ![sx, sy].every(t => t && finalValue(t) === 1))
            return;
        retarget(opacity, m.ms, m.fade);
        retarget(sx, m.ms, m.scale);
        retarget(sy, m.ms, m.scale);
        this._note(actor, 'open', 'motion');
    }

    // ---- close ----

    _onDestroy(actor) {
        if (!actor.meta_window || !Main.wm._destroying?.has(actor) || this._reduced())
            return;
        if (this._kind(actor) === 'native')
            return;
        const opacity = actor.get_transition('opacity');
        const x = actor.get_transition('scale-x');
        const y = actor.get_transition('scale-y');
        // only the exact native normal-window close pose, in this signal's synchronous setup frame
        const matches = (t, target) => t && t.get_elapsed_time() === 0 && finalValue(t) === target;
        if (!matches(x, 0.8) || !matches(y, 0.8) || !matches(opacity, 0))
            return;
        const m = MOTION.close;
        // GNOME's open effect (a window closed while it still opens) resets the pivot to the corner: centre it again
        actor.set_pivot_point(0.5, 0.5);
        retarget(opacity, m.ms, m.fade);
        retarget(x, m.ms, m.scale, {to: m.to});
        retarget(y, m.ms, m.scale, {to: m.to});
        this._note(actor, 'destroy', 'close');
    }

    // ---- minimize: into the Dock ----

    _onMinimize(actor) {
        const win = actor.meta_window;
        if (!win || !Main.wm._minimizing?.has(actor) || this._reduced())
            return;        // GNOME declined (Stage's park, show-desktop, animations off): not ours
        if (this._kind(actor) === 'native')
            return;
        const origin = this._origin(win);
        const opacity = actor.get_transition('opacity');
        const tx = actor.get_transition('x'), ty = actor.get_transition('y');
        const sx = actor.get_transition('scale-x'), sy = actor.get_transition('scale-y');
        if (!opacity)
            return;
        const m = origin ? MOTION.minimize : MOTION.minimizeInPlace;
        // GNOME moves the window to the screen's corner (it does not know the Dock): it stays where it is instead
        retarget(tx, m.ms, LINEAR, {from: actor.x, to: actor.x});
        retarget(ty, m.ms, LINEAR, {from: actor.y, to: actor.y});
        actor.set_pivot_point(0.5, 0.5);
        retarget(opacity, m.ms, m.fade);      // GNOME's: 255 -> 0, and it carries GNOME's completion
        const pose = origin ? this._pose(actor, win, origin) : {s: m.to, tx: 0, ty: 0};
        for (const t of [sx, sy])
            retarget(t, m.ms, m.scale, {from: 1, to: pose.s});
        if (!sx)
            own(actor, 'scale_x', 1, pose.s, m.ms, m.scale);
        if (!sy)
            own(actor, 'scale_y', 1, pose.s, m.ms, m.scale);
        if (origin) {
            // translation is ours: put back to 0 when the effect ends (the hidden window keeps no offset)
            own(actor, 'translation_x', 0, pose.tx, m.ms, m.x, () => {
                actor.translation_x = 0;
            });
            own(actor, 'translation_y', 0, pose.ty, m.ms, m.y, () => {
                actor.translation_y = 0;
            });
        }
        this._note(actor, 'minimize', origin ? 'dock' : 'in-place');
    }

    // ---- restore: out of the Dock ----

    _onUnminimize(actor) {
        const win = actor.meta_window;
        if (!win || !Main.wm._unminimizing?.has(actor) || this._reduced())
            return;
        if (this._kind(actor) === 'native')
            return;
        const origin = this._origin(win);
        const m = origin ? MOTION.restore : MOTION.restoreInPlace;
        // GNOME starts the window at its icon geometry or the screen's corner and moves x / y to its place: it is put
        // at its place now, and those transitions stand still (one of them may carry GNOME's completion)
        // A property GNOME animates is never set directly here: that cancels its transition, and the one that carries
        // GNOME's completion would end the effect at once. Its transitions are reshaped instead (their first frame
        // writes the new start values).
        const dest = win.get_buffer_rect();
        const tx = actor.get_transition('x'), ty = actor.get_transition('y');
        retarget(tx, m.ms, LINEAR, {from: dest.x, to: dest.x});
        retarget(ty, m.ms, LINEAR, {from: dest.y, to: dest.y});
        if (!tx)
            actor.x = dest.x;
        if (!ty)
            actor.y = dest.y;
        actor.set_pivot_point(0.5, 0.5);
        const pose = origin ? this._pose(actor, win, origin, dest.x, dest.y) : {s: m.from, tx: 0, ty: 0};
        const sx = actor.get_transition('scale-x'), sy = actor.get_transition('scale-y');
        for (const t of [sx, sy])
            retarget(t, m.ms, m.scale, {from: pose.s, to: 1});
        if (!sx)
            own(actor, 'scale_x', pose.s, 1, m.ms, m.scale);
        if (!sy)
            own(actor, 'scale_y', pose.s, 1, m.ms, m.scale);
        const opacity = actor.get_transition('opacity');
        if (opacity)
            retarget(opacity, m.ms, m.fade);  // a monitor-sized window: GNOME fades it 0 -> 255
        else
            own(actor, 'opacity', 0, 255, m.ms, m.fade);
        if (origin) {
            own(actor, 'translation_x', pose.tx, 0, m.ms, m.x, () => {
                actor.translation_x = 0;
            });
            own(actor, 'translation_y', pose.ty, 0, m.ms, m.y, () => {
                actor.translation_y = 0;
            });
        }
        this._note(actor, 'unminimize', origin ? 'dock' : 'in-place');
        if (SLOW > 1 || GLib.getenv('VITRE_MOTION_DEBUG')) {
            const desc = p => {
                const t = actor.get_transition(p);
                if (!t)
                    return null;
                const i = t.get_interval();
                return {d: t.get_duration(), from: i?.peek_initial_value?.(), to: i?.peek_final_value?.(), playing: t.is_playing()};
            };
            this._note(actor, 'unminimize-debug', JSON.stringify({sx: desc('scale-x'), x: desc('x'), op: desc('opacity'),
                tx: desc('translation-x'), scale: actor.scale_x, pose}));
        }
    }
}

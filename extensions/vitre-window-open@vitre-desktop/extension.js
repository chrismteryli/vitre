// Vitre window motion (B19, 2026-10-15).
//
// One motion language for a window's whole life, on liquid.js springs (liquid v3, feel A Viscous; windowMotion.js):
//
//   restore      the window pours out of its Dock button: the box of its frame leaves the button and its far (top) edge
//                leads on the 'glide' spring, the edge at the Dock trailing on glide x viscosity; the icon gives as it leaves
//   minimize     it pours into the button: the bottom edge leads, the top trails; it melts as it nears the icon's size and the
//                icon swallows it (a bead kick)
//   open         a new window grows from 0.9 on the glide spring while it fades in (fade role)
//   close        it shrinks to 0.94 on the glide exit spring (never bouncing) and fades out (fade exit)
//   snap         tiled, maximized, restored, dragged out of a tile, sent to another monitor: the window flows from its old
//                frame to the new one on the glide spring (snapMotion.js)
//   launch hop   the Dock icon jumps under gravity until the app's window appears; each landing squashes from its impact
//                speed (area kept); the hop in flight always lands
//   dialogs, transient windows, Stage's own swaps and parks, show-desktop: untouched (GNOME, or their owner)
//
// The Dock button is the one that was clicked (Dhruva tells us through global.__vitreWindowMotion.noteOrigin), else
// the app's button in the Dock; a window with no button (or minimized by the Desktop button) shrinks in place.
//
// How it works: GNOME's own map / minimize / unminimize / destroy handlers keep ownership of the effect and of its
// completion (completed_*). This extension runs after them and takes GNOME's transitions over (windowMotion.js fly():
// the carrier transition is kept and follows the springs, the others are removed). Only properties rounded-window-corners
// mirrors onto its shadow are moved (scale, translation, opacity, pivot), so the shadow travels with the window. Every
// motion can be interrupted: the window's springs carry over into the next effect with their speed. Reduced motion: a
// 160 ms cross-fade in place. Animations off: GNOME's behaviour, untouched.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SnapMotion} from './snapMotion.js';
import {fly, IconKick, SCALE, scaled} from './windowMotion.js';
import {Spring, role, feel, squash, hopLaunch, stepHop} from './liquid.js';
import {Ticker, motionMode, animate} from './liquidClock.js';

// Launch feedback (B25): the Dock icon hops until a window of the app appears, at most 8 s; the hop in flight always lands.
// Under gravity (liquid.js feel: 1300 px/s^2): launched to rise this fraction of the icon's height, a short crouch before
// each jump and a short pause on the ground between jumps; the squash is a bead spring kicked at take-off and at landing
// (from the impact speed), drawn area-keeping.
const HOP = {rise: 0.38, crouchS: 0.07, groundS: 0.06, maxMs: 8000, crouch: -1.6, launch: 0.6, impact: 0.009};
const ORIGIN_TTL_US = 1500 * 1000;  // a Dock click names the button for this long

// ---- helpers ---------------------------------------------------------------

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

// Actors the shell may destroy while this extension still holds them (the Dock rebuilds its buttons and icons whenever an
// app changes state). A destroyed actor is never touched again: probing a disposed wrapper is what logs 'already disposed'.
class Mortal {
    constructor() {
        this._gone = new WeakSet();
        this._ids = new Map();          // actor -> its destroy handler, while it lives
    }

    watch(a) {
        if (a && !this._gone.has(a) && !this._ids.has(a)) {
            try {
                this._ids.set(a, a.connect('destroy', () => {
                    this._gone.add(a);
                    this._ids.delete(a);
                }));
            } catch (_e) {
                this._gone.add(a);      // not an actor: never used
            }
        }
        return a;
    }

    // it still exists and is on the stage (only an actor that still exists is asked)
    alive(a) {
        return Boolean(a) && !this._gone.has(a) && a.get_stage() !== null;
    }

    clear() {
        for (const [a, id] of this._ids)
            a.disconnect(id);
        this._ids.clear();
    }
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
        this._generation = (this._generation ?? 0) + 1;
        this._openFlights = new Map();  // actor -> its overview wait, cancelled by disable
        this._log = [];
        this._noted = new Map();        // window -> {btn, at}
        this._docks = [];
        this._boxes = new Mortal();     // the Dock boxes found
        this._buttons = new Mortal();   // Dock buttons named as a window's origin
        const wm = global.window_manager;
        // 'after' handlers run once GNOME's own handler (and Dhruva's) have set up the effect
        this._ids = [
            wm.connect_after('map', (_wm, actor) => this._guard('map', actor, () => this._onMap(actor))),
            wm.connect_after('destroy', (_wm, actor) => this._guard('destroy', actor, () => this._onDestroy(actor))),
            wm.connect_after('minimize', (_wm, actor) => this._guard('minimize', actor, () => this._onMinimize(actor))),
            wm.connect_after('unminimize', (_wm, actor) => this._guard('unminimize', actor, () => this._onUnminimize(actor))),
        ];
        this._hops = new Map();         // app id -> {actor, stop}
        // reduced motion: GNOME's restore eases a window that is not mapped yet, so it lands at once. When a window is
        // restored, note whether another owner (Stage, Show Desktop) told GNOME to skip its effect: the cross-fade is only
        // for restores GNOME meant to animate.
        this._restoring = new Map();    // window -> {at, skipped}
        this._winIds = new Map();       // window -> its signal ids
        this._displayId = global.display.connect('window-created', (_d, win) => this._watch(win));
        for (const a of global.get_window_actors())
            this._watch(a.meta_window);
        global.__vitreWindowMotion = {
            launchHop: (actor, appId) => this._launchHop(actor, appId),
            noteOrigin: (win, btn) => {
                if (this._noted)
                    this._noted.set(win, {btn: this._buttons.watch(btn), at: GLib.get_monotonic_time()});
            },
        };
        // snapping is its own part: if it cannot start, the rest of the window motion still runs
        try {
            this._snap = new SnapMotion(this);
            this._snap.enable();
        } catch (e) {
            console.warn(`Vitre window motion: snapping left to GNOME (${e.message})`);
            this._snap?.disable();
            this._snap = null;
        }
    }

    disable() {
        this._generation = (this._generation ?? 0) + 1;
        for (const actor of this._openFlights?.keys() ?? []) {
            try {
                if (actor.get_stage())
                    actor.opacity = 255;
            } catch (_e) {
                // the actor was destroyed while its overview wait was pending
            }
        }
        this._openFlights?.clear();
        this._snap?.disable();
        this._snap = null;
        for (const id of this._ids ?? [])
            global.window_manager.disconnect(id);
        this._ids = null;
        if (this._displayId)
            global.display.disconnect(this._displayId);
        this._displayId = 0;
        for (const win of [...(this._winIds?.keys() ?? [])])
            this._unwatch(win);
        this._winIds = null;
        this._restoring = null;
        if (global.__vitreWindowMotion)
            delete global.__vitreWindowMotion;
        for (const hop of this._hops?.values() ?? [])
            hop.stop();
        this._hops = null;
        this._noted = null;
        this._docks = null;
        this._boxes?.clear();
        this._buttons?.clear();
        this._boxes = this._buttons = null;
        this._log = null;
    }

    // The Dock containers, found again when a box has gone (the Dock rebuilds them itself). After disable (a hop finishing its
    // cycle) a fresh walk, held on to by nobody.
    _dockList() {
        if (!this._boxes)
            return findDocks();
        if (!this._docks?.length || this._docks.some(d => !this._boxes.alive(d.boxActor))) {
            this._docks = findDocks();
            for (const d of this._docks)
                this._boxes.watch(d.boxActor);
        }
        return this._docks;
    }

    // The icon (an St.Bin inside the app's Dock button) as it is now: the Dock rebuilds its icons whenever an app changes state
    // (right after a launch click), so the hop looks it up again at every hop and whenever the one it was moving has gone.
    _iconOf(appId) {
        const bin = a => a instanceof St.Bin ? a : [...(a.get_children?.() ?? [])].map(bin).find(Boolean);
        for (const dock of this._dockList()) {
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
        if (!first || !this._hops || motionMode() !== 'full')
            return;
        this._hops.get(appId)?.stop();
        let stopped = false;
        let ended = false;
        let cur = first;
        let lostFor = 0;
        let lookIn = 0;
        // the icons this hop moves: one the Dock has destroyed is never touched again
        const icons = new Mortal();
        icons.watch(first);
        const alive = a => icons.alive(a);
        const rest = a => {
            if (alive(a)) {
                a.remove_all_transitions();
                a.translation_y = 0;
                a.set_scale(1, 1);
                a.set_pivot_point(0.5, 0.5);
            }
        };
        const trace = (what, extra = '') => {
            const live = alive(cur);
            this._note({meta_window: null}, `hop:${what}`, `${appId} alive=${live} ty=${live ? cur.translation_y.toFixed(1) : '-'} ${extra}`);
        };
        // the physics: a crouch, a jump under gravity, a landing squashed from its impact speed, a pause on the ground
        const F = feel();
        const vol = F.volume;
        const h = {phase: 'crouch', wait: HOP.crouchS, y: 0, vy: 0};
        const sq = new Spring(0, role('bead'), 1e-3);
        sq.kick(HOP.crouch);
        const finish = () => {
            if (ended)
                return;
            ended = true;
            trace('finish');
            ticker.stop();
            disconnectApp();
            // every icon the Dock shows for the app is put at rest: a rebuilt icon can start from the old one's lifted pose, and a
            // rebuild can come just after the end
            rest(cur);
            rest(this._iconOf(appId));      // found just now: it exists
            icons.clear();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                if (this._hops)
                    rest(this._iconOf(appId));
                return GLib.SOURCE_REMOVE;
            });
            if (this._hops?.get(appId) === hop)
                this._hops.delete(appId);
        };
        const ticker = new Ticker(dt => {
            if (ended)
                return false;
            if (!alive(cur)) {
                // the Dock rebuilt the icon: carry on with the new one (looked up every 100 ms, given up after 1.5 s)
                lostFor += dt;
                lookIn -= dt;
                if (lookIn <= 0) {
                    lookIn = 0.1;
                    trace('icon-lost');
                    cur = icons.watch(this._iconOf(appId));
                    trace('icon-found', String(Boolean(cur)));
                }
                if (!alive(cur)) {
                    if (lostFor > 1.5 || stopped)
                        finish();
                    return !ended;
                }
                lostFor = 0;
                cur.remove_all_transitions();
            }
            const a = cur;
            if (h.phase === 'crouch' || h.phase === 'ground') {
                h.wait -= dt;
                if (h.wait <= 0) {
                    if (h.phase === 'ground') {
                        h.phase = 'crouch';
                        h.wait = HOP.crouchS;
                        sq.kick(HOP.crouch);
                    } else {
                        h.phase = 'air';
                        h.vy = hopLaunch(Math.max(8, a.height * HOP.rise), F.gravity);
                        sq.kick(3.2 * vol + HOP.launch);
                    }
                }
            } else if (h.phase === 'air') {
                const impact = stepHop(h, dt, F.gravity);
                if (impact > 0) {
                    sq.kick(-impact * HOP.impact * (0.4 + vol));
                    h.phase = stopped ? 'settle' : 'ground';
                    h.wait = HOP.groundS;
                }
            }
            sq.step(dt);
            const flight = h.phase === 'air' ? Math.min(0.12, Math.abs(h.vy) / 2600) * vol : 0;
            const q = squash(sq.x + flight, Math.max(0.5, vol));
            a.set_pivot_point(0.5, 1.0);
            a.translation_y = h.y;
            a.set_scale(q.across, q.along);
            if (h.phase === 'settle' && sq.rest) {
                finish();
                return false;
            }
            return true;
        });
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOP.maxMs, () => {
            stop();
            return GLib.SOURCE_REMOVE;
        });
        // the hop in flight lands (the icon never stops in the air); on the ground it settles its squash and ends
        const stop = () => {
            if (stopped)
                return;
            stopped = true;
            trace('stop');
            GLib.Source.remove(timeout);
            if (h.phase !== 'air')
                h.phase = 'settle';
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
        if (alive(cur))
            cur.remove_all_transitions();
        ticker.start();
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

    _watch(win) {
        if (!win || !this._winIds || this._winIds.has(win))
            return;
        this._winIds.set(win, [
            win.connect('notify::minimized', () => {
                if (win.minimized || !this._restoring)
                    return;
                const a = win.get_compositor_private();
                this._restoring.set(win, {at: GLib.get_monotonic_time(), skipped: Boolean(a && Main.wm._skippedActors?.has(a))});
            }),
            win.connect('unmanaged', () => this._unwatch(win)),
        ]);
    }

    _unwatch(win) {
        for (const id of this._winIds?.get(win) ?? []) {
            try {
                win.disconnect(id);
            } catch (_e) {
                // gone
            }
        }
        this._winIds?.delete(win);
        this._restoring?.delete(win);
    }

    // animations off: GNOME's own effects, untouched (reduced motion is ours: a cross-fade in place)
    _off() {
        return motionMode() === 'off';
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
        this._originBtn = null;
        const noted = this._noted?.get(win);
        this._noted?.delete(win);
        if (noted && GLib.get_monotonic_time() - noted.at < ORIGIN_TTL_US) {
            if (noted.btn === null)
                return null;
            // a button the Dock has rebuilt since the click is not asked (it is gone): its app's button is used below
            const r = this._buttons?.alive(noted.btn) ? rectOf(noted.btn) : null;
            if (r) {
                this._originBtn = noted.btn;
                return this._clampToMonitor(r, win);
            }
        }
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app)
            return null;
        const monitor = win.get_monitor();
        const rects = [];
        for (const dock of this._dockList()) {
            for (const btn of dock.boxActor?.get_children?.() ?? []) {
                const a = btn._delegate?.app;
                if (a && typeof a.get_id === 'function' && a.get_id() === app.get_id()) {
                    const r = rectOf(btn);
                    if (r) {
                        r.btn = this._buttons?.watch(btn);
                        rects.push(r);
                    }
                }
            }
        }
        if (!rects.length)
            return null;
        const geo = global.display.get_monitor_geometry(monitor);
        const onMonitor = rects.find(r => r.x + r.w / 2 >= geo.x && r.x + r.w / 2 < geo.x + geo.width);
        this._originBtn = (onMonitor ?? rects[0]).btn ?? null;
        return this._clampToMonitor(onMonitor ?? rects[0], win);
    }

    // A hidden Dock's buttons sit below the screen: aim at the bottom edge under them.
    _clampToMonitor(r, win) {
        const geo = global.display.get_monitor_geometry(win.get_monitor());
        const cx = Math.min(geo.x + geo.width - r.w / 2, Math.max(geo.x + r.w / 2, r.x + r.w / 2));
        const cy = Math.min(geo.y + geo.height - r.h * 0.3, Math.max(geo.y + r.h / 2, r.y + r.h / 2));
        return {x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h};
    }

    // where the window's frame is at rest, and where the actor is then (the buffer's origin)
    _rest(win) {
        const f = win.get_frame_rect();
        const b = win.get_buffer_rect();
        return {frame: {x: f.x, y: f.y, w: f.width, h: f.height}, at: {x: b.x, y: b.y}};
    }

    // the Dock icon (an St.Bin) inside the button a window goes to or comes from, as an IconKick
    _kickFor(btn) {
        if (!btn || !this._buttons?.alive(btn))
            return null;
        const bin = a => a instanceof St.Bin ? a : [...(a.get_children?.() ?? [])].map(bin).find(Boolean);
        const icon = bin(btn);
        if (!icon)
            return null;
        const life = new Mortal();
        life.watch(icon);
        return new IconKick(icon, x => life.alive(x));
    }

    // ---- open ----

    _onMap(actor) {
        if (this._hops?.size && actor.meta_window) {
            const app = Shell.WindowTracker.get_default().get_window_app(actor.meta_window);
            if (app)
                this._hops.get(app.get_id())?.stop();
        }
        if (!actor.meta_window || !Main.wm._mapping?.has(actor) || this._off())
            return;
        const kind = this._kind(actor);
        this._note(actor, 'map', kind);
        if (kind === 'native' || actor.get_transition('scale-x'))
            return;
        // nothing of the window shows before GNOME's ease exists (it may wait for the overview to hide)
        actor.opacity = 0;
        const generation = this._generation;
        this._openFlights.set(actor, generation);
        this._retargetOpen(actor, generation).catch(e => {
            console.warn(`Vitre window motion: open left to GNOME (${e.message})`);
            if (generation === this._generation && this._openFlights?.get(actor) === generation && actor.get_stage?.())
                actor.opacity = 255;
        }).finally(() => {
            if (this._openFlights?.get(actor) === generation)
                this._openFlights.delete(actor);
        });
    }

    // GNOME's map handler awaits the overview before it calls ease(); awaiting the same promise here queues this
    // continuation after GNOME's, so its transitions exist when it runs.
    async _retargetOpen(actor, generation) {
        await Main.wm._waitForOverviewToHide();
        if (generation !== this._generation || this._openFlights?.get(actor) !== generation ||
            !Main.wm._mapping?.has(actor))
            return;
        const opacity = actor.get_transition('opacity');
        const sx = actor.get_transition('scale-x');
        // only the exact native opening (nothing another owner chose)
        if (!opacity || finalValue(opacity) !== 255 || (sx && finalValue(sx) !== 1))
            return;
        const {frame, at} = this._rest(actor.meta_window);
        fly(actor, {kind: 'open', carrier: opacity, carrierProp: 'opacity', frame, at, from: scaled(frame, SCALE.open), to: frame,
            lead: 'bottom', exit: false, op: 'fade', opFrom: 0, opTo: 1, role: 'pour'});
        this._note(actor, 'open', 'motion');
    }

    // ---- close ----

    _onDestroy(actor) {
        if (!actor.meta_window || !Main.wm._destroying?.has(actor) || this._off())
            return;
        if (this._kind(actor) === 'native')
            return;
        const opacity = actor.get_transition('opacity');
        // only the exact native normal-window close, in this signal's synchronous setup frame
        if (!opacity || opacity.get_elapsed_time() !== 0 || finalValue(opacity) !== 0)
            return;
        const {frame, at} = this._rest(actor.meta_window);
        fly(actor, {kind: 'close', carrier: opacity, carrierProp: 'opacity', frame, at, from: frame, to: scaled(frame, SCALE.close),
            lead: 'bottom', exit: true, op: 'fade', opFrom: actor.opacity / 255, opTo: 0});
        this._note(actor, 'destroy', 'close');
    }

    // ---- minimize: into the Dock ----

    _onMinimize(actor) {
        const win = actor.meta_window;
        if (!win || !Main.wm._minimizing?.has(actor) || this._off())
            return;        // GNOME declined (Stage's park, show-desktop, animations off): not ours
        if (this._kind(actor) === 'native')
            return;
        const opacity = actor.get_transition('opacity');
        if (!opacity)
            return;
        const origin = this._origin(win);
        const btn = this._originBtn;
        const {frame, at} = this._rest(win);
        fly(actor, origin
            ? {kind: 'minimize', carrier: opacity, carrierProp: 'opacity', frame, at, from: frame, to: origin, lead: 'bottom',
                exit: false, op: 'size', opFrom: 1, opTo: 1, icon: this._kickFor(btn)}
            : {kind: 'close', carrier: opacity, carrierProp: 'opacity', frame, at, from: frame, to: scaled(frame, SCALE.inPlace),
                lead: 'bottom', exit: true, op: 'fade', opFrom: 1, opTo: 0});
        this._note(actor, 'minimize', origin ? 'dock' : 'in-place');
    }

    // ---- restore: out of the Dock ----

    _onUnminimize(actor) {
        const win = actor.meta_window;
        if (win && motionMode() === 'reduced' && !Main.wm._unminimizing?.has(actor)) {
            this._reducedRestore(actor);
            return;
        }
        if (!win || !Main.wm._unminimizing?.has(actor) || this._off())
            return;
        if (this._kind(actor) === 'native')
            return;
        // GNOME's carrier: scale-x (it flies the window from its icon geometry or the screen's corner), or opacity for a
        // monitor-sized window and in reduced motion
        const sx = actor.get_transition('scale-x');
        const carrier = sx ?? actor.get_transition('opacity');
        if (!carrier)
            return;
        const origin = this._origin(win);
        const btn = this._originBtn;
        const {frame, at} = this._rest(win);
        const prop = sx ? 'scale_x' : 'opacity';
        fly(actor, origin
            ? {kind: 'restore', carrier, carrierProp: prop, frame, at, from: origin, to: frame, lead: 'top', exit: false,
                op: 'size', opFrom: 1, opTo: 1, icon: this._kickFor(btn)}
            : {kind: 'open', carrier, carrierProp: prop, frame, at, from: scaled(frame, SCALE.inPlace), to: frame, lead: 'bottom',
                exit: false, op: 'fade', opFrom: 0, opTo: 1});
        this._note(actor, 'unminimize', origin ? 'dock' : 'in-place');
    }

    // Reduced motion: GNOME's restore has already landed (its ease ran on a window that was not mapped yet). Cross-fade the
    // window in place on the 160 ms spring, as its minimize faded it out. Not when another owner skipped GNOME's effect or
    // GNOME would not have animated it.
    _reducedRestore(actor) {
        const win = actor.meta_window;
        const asked = this._restoring?.get(win);
        this._restoring?.delete(win);
        if (!asked || asked.skipped || GLib.get_monotonic_time() - asked.at > 2_000_000)
            return;
        if (!Main.wm._shouldAnimate() || !actor.get_texture() || this._kind(actor) === 'native')
            return;
        if (actor.opacity !== 255 || actor.get_transition('opacity'))
            return;
        actor.opacity = 0;
        animate(actor, {opacity: 255});
        this._note(actor, 'unminimize', 'reduced');
    }
}

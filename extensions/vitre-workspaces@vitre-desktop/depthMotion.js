// SPDX-License-Identifier: GPL-3.0-or-later
// Vitre Workspaces: the glass depth slide for workspace switches.
//
// Everything GNOME draws for a workspace switch lives in WorkspaceAnimation.MonitorGroup (one per monitor that switches):
// a container that slides one "card" per workspace (WorkspaceGroup: the wallpaper and clones of that workspace's windows)
// and, above it, the windows that stay (sticky windows, the window being moved). Every way to switch ends there: a key
// (WorkspaceAnimationController.animateSwitch), the three/four-finger swipe (the swipe tracker's handlers), a click in
// the Dock or the top bar. They set MonitorGroup.progress (1.0 = one workspace) and ease it with ease_property().
//
// The look here is a pure function of each card's screen offset u (in GNOME's base distances; 0 = on screen): a card in
// motion steps back (94 %) and dims (38 %), a soft lit edge on the side that faces its neighbour, a faint glass rim,
// over a dark backdrop. Because it depends on u only, a swipe that reverses, a key pressed during a switch, two
// monitors interpolating: none of it has a jump. The top bar, the Dock and every other piece of chrome are above the
// switch layer and stay put.
//
// The motion is the Vitre stretch spring (springMath.js): a key press starts with a small push, a swipe release starts at
// the fingers' speed, a key pressed while a switch is still moving starts from where the picture is, at its speed.
// GNOME holds input for the whole slide; here the switch itself (input, mutter's bookkeeping, the workspace tracker)
// ends once the picture is within 12 px for good, and the picture finishes its last pixels on its own ("tail").
//
// Hooks (prototype, restored by identity in disable(), every body in a try: on any error GNOME's own code runs):
//   WorkspaceAnimationController._prepareWorkspaceSwitch   all workspaces as cards, the dragged window stays, look on
//   WorkspaceAnimationController._finishWorkspaceSwitch    a picture still moving outlives the switch (the tail)
//   MonitorGroup.ease_property ('progress')                the spring
//   MonitorGroup.updateSwipeForMonitor                     samples for the release speed
// Not hooked: animateSwitch. Fullscreen Spaces wraps it on the instance to finish switches made under its own cover at
// once; those never build a MonitorGroup, so this extension never draws over that cover.
//
// Vitre Stage: its strip is chrome too, and it moves its own pile thumbnails on a workspace change (a 250 ms slide). For
// a switch drawn here the piles ride their workspace's card instead: the old ones leave inside the departing card, the
// strip follows the arriving one and docks without a bounce; under the fingers it rides the home card. Parked windows
// are minimized, so the cards do not draw them (as GNOME's own slide).
//
// Windows that stay: sticky windows and the window being moved (Shift+Ctrl+Alt+arrow, or one held by a pointer drag
// when a switch happens) are drawn above the cards, unscaled. GNOME's switch takes all input while it runs; during a
// drag that froze the held window, so while a drag holds the pointer the switch leaves the input to it.
//
// Reduced motion: no travel, an in-place cross-fade (the home card stays, the other fades in over it), 160 ms.
// Animations off: GNOME's behaviour, untouched. Fullscreen Spaces' own switches (under its cover) never reach this.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import {planSpring, planFade, lookAt, estimateReleaseVelocity, SPRING} from './springMath.js';

const LOG = '[vitre-workspaces]';
const STAGE_UUID = 'vitre-stage@vitre-desktop';

// ---- the look's pieces (the numbers that shape the motion are in springMath.js LOOK and SPRING) --------------------------
const STYLE = {
    backdrop: 'background-color: rgb(5, 7, 12);',
    dim: 'background-color: black;',
    rim: 'border: 1px solid rgba(255, 255, 255, 0.16);',
    edgePx: 30,
    edge: {
        left: 'border-left: 2px solid rgba(232, 240, 255, 0.62); background-gradient-direction: horizontal; ' +
            'background-gradient-start: rgba(232, 240, 255, 0.20); background-gradient-end: rgba(232, 240, 255, 0);',
        right: 'border-right: 2px solid rgba(232, 240, 255, 0.62); background-gradient-direction: horizontal; ' +
            'background-gradient-start: rgba(232, 240, 255, 0); background-gradient-end: rgba(232, 240, 255, 0.20);',
        top: 'border-top: 2px solid rgba(232, 240, 255, 0.62); background-gradient-direction: vertical; ' +
            'background-gradient-start: rgba(232, 240, 255, 0.20); background-gradient-end: rgba(232, 240, 255, 0);',
        bottom: 'border-bottom: 2px solid rgba(232, 240, 255, 0.62); background-gradient-direction: vertical; ' +
            'background-gradient-start: rgba(232, 240, 255, 0); background-gradient-end: rgba(232, 240, 255, 0.20);',
    },
    hideBeyond: 1.3,    // cards further out than this many base distances are not drawn
};

const MOVE_FLAGS = 0x100 | 0x400;    // Meta.GrabOp keyboard / unconstrained flags on top of MOVING (1)

// Rig only: the slow-motion factor for films (as the rest of Vitre's motion). Unset in a session.
const ENV_SLOW = Math.max(1, Number(GLib.getenv('VITRE_MOTION_SLOW')) || 1);
const slowNow = () => Math.max(1, Number(globalThis.__vitreMotionSlow) || ENV_SLOW);

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

// writes that only happen when the value changes (a Clutter setter redraws even when handed the same value)
const near = (a, b, eps) => Math.abs(a - b) < eps;
function setTrans(a, x, y) {
    if (!near(a.translation_x, x, 1e-3) || !near(a.translation_y, y, 1e-3))
        a.set_translation(x, y, 0);
}
function setScale(a, s) {
    if (!near(a.scale_x, s, 1e-5) || !near(a.scale_y, s, 1e-5))
        a.set_scale(s, s);
}
function setOpacity(a, o) {
    const v = Math.max(0, Math.min(255, Math.round(o)));
    if (a.opacity !== v)
        a.opacity = v;
}
function setVisible(a, v) {
    if (a.visible !== v)
        a.visible = v;
}

// ---- the spring as a Clutter transition --------------------------------------------------------------------------------
// The timeline runs LINEAR over the plan's duration (x the film factor); the plan decides the value. The interval is
// [0, 1] so the value handed to the interval IS the progress (Clutter's interval interpolates outside 0..1 too).
let SpringTransition = null;
function springTransitionClass() {
    if (SpringTransition)
        return SpringTransition;
    SpringTransition = GObject.registerClass({GTypeName: 'VitreWorkspacesSpringTransition'},
    class VitreWorkspacesSpringTransition extends Clutter.PropertyTransition {
        vfunc_compute_value(animatable, interval, progress) {
            const run = this._vitreRun;
            let value = progress;
            if (run) {
                try {
                    const t = Math.min(run.plan.T, Math.max(0, progress) * run.plan.T);
                    run.t = t;
                    value = run.att.clampProgress(run.plan.at(t));
                    if (!run.logicFired && t >= run.plan.Tlogic && run.plan.Tlogic < run.plan.T) {
                        run.logicFired = true;
                        run.owner?._scheduleLogic(run);
                    }
                } catch (e) {
                    warnOnce('compute', `spring failed (${e.message}); finishing on a straight line`);
                    value = run.plan.from + (run.plan.to - run.plan.from) * progress;
                }
            }
            super.vfunc_compute_value(animatable, interval, value);
        }
    });
    return SpringTransition;
}

export class DepthMotion {
    constructor() {
        this._atts = new Map();         // MonitorGroup -> attachment (the look, the run, the samples)
        this._tails = new Set();        // attachments whose switch has ended while the picture still settles
        this._holders = [];             // {holder, ws}: Stage pile thumbnails riding a departing card
        this._restores = [];
        this._signals = [];
        this._drag = null;              // the window a pointer or keyboard grab is moving
        this._dragModal = null;         // a switch whose input grab was handed back to that drag
        this._activation = null;        // {prev, cur} of the last workspace activation, for the Stage strip
        this._strip = null;             // the Stage strip coupling
        this._installed = false;
        this.stats = {switches: 0, keys: 0, releases: 0, carries: 0, tails: 0, logicEarly: 0, fades: 0, errors: 0,
            stripTakeovers: 0, dragHolds: 0};
        this.last = null;               // the last plan started (rig)
    }

    // ---- install / uninstall ------------------------------------------------------------------------------------------

    install() {
        const Controller = WorkspaceAnimation.WorkspaceAnimationController;
        const MonitorGroup = WorkspaceAnimation.MonitorGroup;
        const missing = [];
        for (const [proto, name] of [[Controller?.prototype, '_prepareWorkspaceSwitch'], [Controller?.prototype, '_finishWorkspaceSwitch'],
            [MonitorGroup?.prototype, 'ease_property'], [MonitorGroup?.prototype, 'updateSwipeForMonitor']]) {
            if (typeof proto?.[name] !== 'function')
                missing.push(name);
        }
        if (typeof MonitorGroup?.prototype?.getWorkspaceProgress !== 'function')
            missing.push('getWorkspaceProgress');
        if (!Main.wm?._workspaceAnimation)
            missing.push('Main.wm._workspaceAnimation');
        if (missing.length)
            throw new Error(`unsupported GNOME Shell (${missing.join(', ')} missing)`);
        springTransitionClass();
        const self = this;

        this._override(Controller.prototype, '_prepareWorkspaceSwitch', original => function (workspaceIndices) {
            let pre = null;
            try {
                pre = self._beforePrepare(this, workspaceIndices);
            } catch (e) {
                self._fail('prepare', e);
            }
            const had = this._switchData;
            const result = original.call(this, pre && pre.indices !== undefined ? pre.indices : workspaceIndices);
            try {
                if (!had && this._switchData)
                    self._afterPrepare(this, this._switchData, pre);
                else
                    self._dropTails(pre?.tails ?? [], 'kept-switch');
            } catch (e) {
                self._fail('attach', e);
                self._detachAll(this._switchData);
            }
            return result;
        });

        this._override(Controller.prototype, '_finishWorkspaceSwitch', original => function (switchData) {
            try {
                self._beforeFinish(this, switchData);
            } catch (e) {
                self._fail('finish', e);
            }
            return original.call(this, switchData);
        });

        this._override(MonitorGroup.prototype, 'ease_property', original => function (propName, target, params) {
            if (propName === 'progress' && self._atts.has(this)) {
                try {
                    if (self._ease(this, target, params))
                        return undefined;
                } catch (e) {
                    self._fail('ease', e);
                }
            }
            return original.call(this, propName, target, params);
        });

        this._override(MonitorGroup.prototype, 'updateSwipeForMonitor', original => function (progress, monitorGroup) {
            const att = self._atts.get(this);
            if (att)
                att.excess = 0;             // under the fingers GNOME's progress is the picture
            const result = original.call(this, progress, monitorGroup);
            try {
                self._sample(this);
            } catch (e) {
                self._fail('sample', e);
            }
            return result;
        });

        this._connect(global.display, 'grab-op-begin', (_d, win, op) => {
            if (win && (op & ~MOVE_FLAGS) === 1)
                this._drag = win;
        });
        this._connect(global.display, 'grab-op-end', () => {
            this._drag = null;
            // the drag ended while its switch still runs: the switch takes its input grab back, as GNOME holds it
            const dm = this._dragModal;
            this._dragModal = null;
            const ctl = dm?.controller;
            if (ctl && ctl._switchData === dm.switchData && !ctl._grab)
                ctl._grab = Main.pushModal(global.stage, {actionMode: Shell.ActionMode.NORMAL});
        });
        this._connect(Main.overview, 'showing', () => this._dropTails([...this._tails], 'overview'));
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._guard('active', () => this._onActivated()));
        this._connect(St.Settings.get(), 'notify::enable-animations', () => {
            if (motionMode() === 'off')
                this._dropTails([...this._tails], 'animations-off');
        });
        this._activeWs = global.workspace_manager.get_active_workspace();
        this._installed = true;
    }

    uninstall() {
        this._dropTails([...this._tails], 'disable');
        this._stripEnd();
        for (const att of [...this._atts.values()])
            this._detach(att);
        for (const [obj, id] of this._signals.splice(0)) {
            try {
                obj.disconnect(id);
            } catch (_e) { /* gone */ }
        }
        for (const restore of this._restores.splice(0).reverse()) {
            try {
                restore();
            } catch (e) {
                console.warn(`${LOG} restore failed: ${e.message}`);
            }
        }
        this._drag = null;
        this._dragModal = null;
        this._activation = null;
        this._installed = false;
    }

    // proto[name] = make(original); undone by identity (an own property is put back, an inherited one deleted)
    _override(proto, name, make) {
        const hadOwn = Object.hasOwn(proto, name);
        const original = proto[name];
        const installed = make(original);
        installed.__vitreWorkspaces = true;
        proto[name] = installed;
        this._restores.push(() => {
            if (proto[name] !== installed) {
                console.warn(`${LOG} ${name} was wrapped after this extension; its chain is left as it is`);
                return;
            }
            if (hadOwn)
                proto[name] = original;
            else
                delete proto[name];
        });
    }

    _connect(obj, name, fn) {
        this._signals.push([obj, obj.connect(name, (...args) => this._guard(name, () => fn(...args)))]);
    }

    _guard(key, fn) {
        try {
            return fn();
        } catch (e) {
            this._fail(key, e);
            return undefined;
        }
    }

    _fail(key, e) {
        this.stats.errors++;
        warnOnce(key, `${key}: ${e?.message ?? e}; GNOME's own motion is used here`);
        if (GLib.getenv('VITRE_WS_DEBUG'))
            console.warn(`${LOG} ${e?.stack ?? ''}`);
    }

    // ---- prepare / finish ---------------------------------------------------------------------------------------------

    _beforePrepare(controller, indices) {
        const pre = {indices: undefined, tails: [], carries: [], keyboard: Array.isArray(indices)};
        // whatever happens below, a running tail never stays under a new switch
        pre.tails = [...this._tails];
        if (controller._switchData || motionMode() === 'off')
            return pre;
        // every workspace as a card: a key pressed during this switch can carry the picture on from where it is
        if (pre.keyboard)
            pre.indices = null;
        // the window being dragged stays under the pointer (mutter moves it to the new workspace with the switch)
        const drag = this._drag;
        if (drag && !drag.is_on_all_workspaces?.() && drag.get_compositor_private?.() &&
            (!controller.movingWindow || controller.movingWindow === drag)) {
            controller.movingWindow = drag;
            pre.dragHold = true;
            this.stats.dragHolds++;
        }
        for (const tail of pre.tails) {
            const run = tail.run;
            if (!run || run.done || tail.forgotten)
                continue;
            const target = this._groupAt(tail.mg, run.plan.to);
            if (!target?.workspace)
                continue;
            // where the picture is (overshoot included) relative to where it was going, and how fast
            pre.carries.push({monitorIndex: tail.mg.index, ws: target.workspace,
                offset: run.plan.at(run.t) - run.plan.to, vel: run.plan.vel(run.t)});
        }
        return pre;
    }

    _afterPrepare(controller, switchData, pre) {
        this.stats.switches++;
        const mode = motionMode();
        if (mode !== 'off') {
            for (const mg of switchData.monitors) {
                const att = this._attach(controller, mg, mode);
                const carry = pre?.carries?.find(c => c.monitorIndex === mg.index);
                if (!att || !carry)
                    continue;
                const g = mg._workspaceGroups?.find(x => x.workspace === carry.ws);
                if (!g)
                    continue;
                const pos = mg._getWorkspaceGroupProgress(g) + carry.offset;
                att.setProgress(pos);
                att.carry = {pos, vel: carry.vel};
                this.stats.carries++;
            }
        }
        // GNOME's switch takes all input for its length; a window being dragged would then stop under the pointer and
        // jump when the switch lets go. While a drag holds the pointer, the drag keeps it (mutter keeps moving the window).
        if (pre?.dragHold && this._drag && controller._grab) {
            Main.popModal(controller._grab);
            controller._grab = null;
            this._dragModal = {controller, switchData};
        }
        // the new cards now show what the tail showed: let it go, keeping its Stage thumbnails
        this._rehomeHolders(switchData);
        this._dropTails(pre?.tails ?? [], 'adopted');
        // under the fingers the Stage strip rides the home card
        if (!pre?.keyboard && mode !== 'off') {
            const att = this._primaryAtt(switchData);
            if (att)
                this._stripBegin(att, this._groupAt(att.mg, att.mg.progress), {clamp: false, mode: att.mode});
        }
    }

    _beforeFinish(controller, switchData) {
        for (const mg of [...(switchData?.monitors ?? [])]) {
            const att = this._atts.get(mg);
            const run = att?.run;
            if (!att || !run || run.done)
                continue;
            // the switch ends here (its own early completion, a key killing it, the overview): whatever made it end,
            // this run's completion belongs to a switch that is over and must never run later (it would end the next one)
            run.logicDone = true;
            if (run.t >= run.plan.T || att.forgotten || Main.overview.visible)
                continue;
            // the switch ends now; the picture finishes its last pixels and then goes (GNOME would destroy it here)
            switchData.monitors.splice(switchData.monitors.indexOf(mg), 1);
            att.tail = true;
            this._tails.add(att);
            this.stats.tails++;
        }
    }

    _dropTails(list, why) {
        for (const att of list) {
            if (!this._tails.delete(att))
                continue;
            att.dropped = why;
            try {
                if (!att.forgotten) {
                    att.mg.remove_transition('progress');
                    att.mg.destroy();
                }
            } catch (e) {
                this._fail('drop', e);
            }
            this._forget(att);
        }
    }

    // ---- the look -------------------------------------------------------------------------------------------------------

    _attach(controller, mg, mode) {
        if (this._atts.has(mg))
            return this._atts.get(mg);
        const monitor = mg._monitor;
        const groups = mg._workspaceGroups;
        if (!monitor || !Array.isArray(groups) || !mg._container)
            return null;
        const vertical = global.workspace_manager.layout_rows === -1;
        const snaps = groups.map(g => mg._getWorkspaceGroupProgress(g)).filter(Number.isFinite);
        const att = {
            mg, controller, vertical, mode,
            extent: vertical ? monitor.height : monitor.width,
            base: mg.baseDistance,
            monitor,
            cards: [],
            run: null, carry: null, samples: [], tail: false, home: null, forgotten: false,
            // GNOME's progress stays inside its snap range (its workspaces adjustment reads it); a spring that settles
            // past the first or last workspace draws the part outside the range itself ("excess")
            lo: Math.min(...snaps), hi: Math.max(...snaps), excess: 0,
            // how a card's screen offset u changes when progress grows: -1, or +1 for right-to-left rows
            sign: !vertical && mg.get_text_direction() === Clutter.TextDirection.RTL ? 1 : -1,
        };
        if (!(att.base > 0) || !snaps.length)
            return null;
        att.clampProgress = v => {
            const c = Math.min(att.hi, Math.max(att.lo, v));
            att.excess = Number.isFinite(v) ? v - c : 0;
            return c;
        };
        att.setProgress = v => {
            const c = att.clampProgress(v);
            if (Math.abs(mg.progress - c) > 1e-9)
                mg.progress = c;
            else
                this._apply(att);
        };
        if (mode === 'depth')
            mg.set_style(STYLE.backdrop);
        for (const group of groups)
            att.cards.push(this._makeCard(group, monitor, vertical, mode));
        this._followSticky(mg);
        att.notifyId = mg.connect('notify::progress', () => this._guard('apply', () => this._apply(att)));
        att.destroyId = mg.connect('destroy', () => this._forget(att));
        this._atts.set(mg, att);
        if (mode === 'reduce')
            this._setHome(att, this._groupAt(mg, mg.progress));
        this._apply(att);
        return att;
    }

    // GNOME places the clones of the windows that stay (sticky windows, the window being dragged) once, when the switch
    // starts; a window still being dragged would freeze until the switch ends. Keep each clone on its window.
    _followSticky(mg) {
        const sticky = mg.get_children().find(c => c !== mg._container && Array.isArray(c._windowRecords));
        const m = mg._monitor;
        for (const rec of sticky?._windowRecords ?? []) {
            const {windowActor, clone} = rec;
            const sync = () => {
                clone.set_position(windowActor.x - m.x, windowActor.y - m.y);
            };
            windowActor.connectObject('notify::x', sync, 'notify::y', sync, clone);
        }
    }

    _makeCard(group, monitor, vertical, mode) {
        const card = {group, pieces: [], monitor, vertical, built: mode !== 'depth'};
        group.set_pivot_point(0.5, 0.5);
        if (mode !== 'depth') {
            // the cross-fade: a card at partial opacity is drawn as one picture (otherwise each window of it is
            // see-through over its own wallpaper)
            group.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);
        }
        return card;
    }

    // the dim, the rim and the lit edges: made the first time the card comes into view (a switch shows two cards; the
    // first switch after a sign-in should not pay for every workspace)
    _buildCard(card) {
        card.built = true;
        const {group, monitor, vertical} = card;
        const W = monitor.width, H = monitor.height, E = STYLE.edgePx;
        const piece = (style, x, y, w, h, name) => {
            const a = new St.Widget({name, style, x, y, width: w, height: h, opacity: 0, reactive: false});
            group.add_child(a);
            card.pieces.push(a);
            return a;
        };
        card.dim = piece(STYLE.dim, 0, 0, W, H, 'vitreWorkspacesDim');
        card.rim = piece(STYLE.rim, 0, 0, W, H, 'vitreWorkspacesRim');
        if (vertical) {
            card.edgeLo = piece(STYLE.edge.top, 0, 0, W, E, 'vitreWorkspacesEdge');
            card.edgeHi = piece(STYLE.edge.bottom, 0, H - E, W, E, 'vitreWorkspacesEdge');
        } else {
            card.edgeLo = piece(STYLE.edge.left, 0, 0, E, H, 'vitreWorkspacesEdge');
            card.edgeHi = piece(STYLE.edge.right, W - E, 0, E, H, 'vitreWorkspacesEdge');
        }
        // pile thumbnails that already ride this card stay under the dim
        for (const h of this._holders) {
            if (!h.dead && h.holder.get_parent() === group)
                group.set_child_below_sibling(h.holder, card.dim);
        }
    }

    // a card's offset from its monitor along the row, in px, as GNOME places it (without the look)
    _offset(att, group) {
        const c = att.mg._container;
        return att.vertical ? group.y + c.y : group.x + c.x;
    }

    // ... and as drawn (with what the spring overshoots past the first or last workspace)
    _uOf(att, group) {
        return (this._offset(att, group) + att.sign * att.excess * att.base) / att.base;
    }

    _apply(att) {
        if (att.forgotten)
            return;
        for (const card of att.cards) {
            const g = card.group;
            const off = this._offset(att, g) + att.sign * att.excess * att.base;
            const u = off / att.base;
            if (att.mode === 'reduce') {
                const presence = 1 - Math.min(1, Math.abs(u));
                const raw = this._offset(att, g);
                setTrans(g, att.vertical ? 0 : -raw, att.vertical ? -raw : 0);
                setScale(g, 1);
                const home = g === att.home;
                setOpacity(g, home ? 255 : presence * 255);
                setVisible(g, home || presence > 0);
                continue;
            }
            const L = lookAt(u, att.extent);
            const t = L.x - this._offset(att, g);
            const inView = Math.abs(u) < STYLE.hideBeyond;
            setTrans(g, att.vertical ? 0 : t, att.vertical ? t : 0);
            setScale(g, L.scale);
            setVisible(g, inView);
            if (inView && !card.built)
                this._buildCard(card);
            if (card.dim) {
                setOpacity(card.dim, L.dim * 255);
                setOpacity(card.rim, L.rim * 255);
                setOpacity(card.edgeLo, L.side < 0 ? L.edge * 255 : 0);
                setOpacity(card.edgeHi, L.side > 0 ? L.edge * 255 : 0);
            }
        }
        if (this._strip?.att === att)
            this._stripApply();
    }

    // the card's screen transform as this module set it: {S, x0, y0} with screen = (x0, y0) + S * local
    _cardTransform(att, group) {
        const c = att.mg._container, m = att.monitor;
        const S = group.scale_x;
        const W = group.width, H = group.height;
        const x = m.x + c.x + group.x + group.translation_x + W / 2 * (1 - S);
        const y = m.y + c.y + group.y + group.translation_y + H / 2 * (1 - S);
        return {S, x0: x, y0: y};
    }

    _setHome(att, group) {
        if (!group || att.home === group)
            return;
        att.home = group;
        try {
            att.mg._container.set_child_below_sibling(group, null);
        } catch (_e) { /* not a child */ }
    }

    // the card whose snap point is nearest to `progress`
    _groupAt(mg, progress) {
        let best = null, bestD = Infinity;
        for (const g of mg._workspaceGroups ?? []) {
            const d = Math.abs(mg._getWorkspaceGroupProgress(g) - progress);
            if (d < bestD) {
                best = g;
                bestD = d;
            }
        }
        return best;
    }

    _primaryAtt(switchData) {
        const mg = switchData?.monitors?.find(m => m.index === Main.layoutManager.primaryIndex);
        return mg ? this._atts.get(mg) ?? null : null;
    }

    _detach(att) {
        // the look comes off; the group stays GNOME's
        try {
            att.mg.disconnect(att.notifyId);
            att.mg.disconnect(att.destroyId);
        } catch (_e) { /* gone */ }
        for (const card of att.cards) {
            for (const p of card.pieces) {
                try {
                    p.destroy();
                } catch (_e) { /* gone */ }
            }
            card.pieces = [];
            card.dim = null;
            if (!att.forgotten) {
                card.group.set_translation(0, 0, 0);
                card.group.set_scale(1, 1);
                card.group.opacity = 255;
                card.group.visible = true;
            }
        }
        if (!att.forgotten)
            att.mg.set_style(null);
        if (this._strip?.att === att)
            this._stripEnd();
        this._atts.delete(att.mg);
        this._tails.delete(att);
    }

    _detachAll(switchData) {
        for (const mg of switchData?.monitors ?? []) {
            const att = this._atts.get(mg);
            if (att)
                this._detach(att);
        }
    }

    _forget(att) {
        if (att.forgotten)
            return;
        att.forgotten = true;
        if (att.run && !att.run.done)
            att.run.cancelled = true;
        if (this._strip?.att === att)
            this._stripEnd();
        this._atts.delete(att.mg);
        this._tails.delete(att);
        this._holders = this._holders.filter(h => !h.dead);
    }

    // ---- the motion ----------------------------------------------------------------------------------------------------

    // returns true when this module runs the motion (false: GNOME's ease runs)
    _ease(mg, target, params) {
        const att = this._atts.get(mg);
        const mode = motionMode();
        if (!att || att.tail || mode === 'off' || !(params?.duration > 0) || !mg.mapped || !Number.isFinite(target))
            return false;
        const sd = att.controller._switchData;
        let from = mg.progress;
        let v0 = 0;
        let kind;
        const dir = Math.sign(target - from);
        if (sd?.gestureActivated) {
            kind = 'release';
            v0 = this._releaseVelocity(att);
            this.stats.releases++;
        } else if (att.carry) {
            kind = 'carry';
            from = att.carry.pos;
            const d = Math.sign(target - from);
            const v = att.carry.vel;
            v0 = v * d >= 0 ? d * Math.max(Math.abs(v), SPRING.kbdPush) : v;
        } else {
            kind = 'key';
            v0 = dir * SPRING.kbdPush;
            this.stats.keys++;
        }
        att.carry = null;
        att.samples = [];
        const plan = att.mode === 'reduce' ? planFade({from, to: target}) : planSpring({from, to: target, v0, unitPx: att.base});
        if (!plan || !(plan.T > 0))
            return false;
        if (att.mode === 'reduce') {
            this.stats.fades++;
            this._setHome(att, this._groupAt(mg, from));
        }
        // the Stage strip: a key switch takes the piles over from Stage's own slide
        if (kind !== 'release' && mg.index === Main.layoutManager.primaryIndex)
            this._stripForKey(att, target);
        this._run(att, plan, kind, params);
        return true;
    }

    _run(att, plan, kind, params) {
        const mg = att.mg;
        const Klass = springTransitionClass();
        mg.remove_transition('progress');
        att.setProgress(plan.from);        // a carried switch goes on from the picture, not from GNOME's start
        const slow = slowNow();
        const transition = new Klass({
            property_name: 'progress',
            interval: new Clutter.Interval({value_type: GObject.TYPE_DOUBLE}),
            remove_on_complete: true,
            duration: Math.max(1, Math.round(plan.T * slow)),
            progress_mode: Clutter.AnimationMode.LINEAR,
        });
        const run = {plan, kind, params, att, owner: this, t: 0, logicFired: false, cancelled: false, done: false, worked: false,
            startUs: GLib.get_monotonic_time(), slow};
        transition._vitreRun = run;
        mg.add_transition('progress', transition);
        transition.set_from(0);
        transition.set_to(1);
        global.compositor.disable_unredirect();
        global.begin_work();
        run.worked = true;
        transition.connect('stopped', (_t, finished) => this._guard('stopped', () => this._runStopped(run, finished)));
        att.run = run;
        this.last = {kind, mode: att.mode, from: plan.from, to: plan.to, v0: plan.v0, T: plan.T, Tlogic: plan.Tlogic,
            period: plan.periodMs ?? null, monitor: mg.index, slow, at: Math.round(GLib.get_monotonic_time() / 1000)};
    }

    _scheduleLogic(run) {
        GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            if (!run.cancelled)
                this._fireLogic(run, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _fireLogic(run, early) {
        if (run.logicDone)
            return;
        run.logicDone = true;
        if (early)
            this.stats.logicEarly++;
        try {
            run.params?.onComplete?.();
        } catch (e) {
            console.error(`${LOG} the switch's own completion threw: ${e.message}`);
        }
    }

    _runStopped(run, finished) {
        if (run.done)
            return;
        run.done = true;
        if (run.worked) {
            global.end_work();
            global.compositor.enable_unredirect();
            run.worked = false;
        }
        const att = run.att;
        if (att.run === run)
            att.run = null;
        if (!finished) {
            run.cancelled = true;
            // a swipe took the picture over: from here GNOME's progress is the picture
            if (att.excess !== 0 && !att.forgotten) {
                att.excess = 0;
                this._apply(att);
            }
            return;
        }
        run.logicFired = true;
        this._fireLogic(run, false);
        if (att.tail)
            this._dropTails([att], 'landed');
    }

    // ---- release speed -------------------------------------------------------------------------------------------------

    _sample(mg) {
        const att = this._atts.get(mg);
        if (!att)
            return;
        const time = this._eventTime();
        const p = mg.progress;
        const s = att.samples;
        const last = s[s.length - 1];
        if (last && time - last.time > 100)
            s.length = 0;
        s.push({time, delta: s.length ? p - att.lastP : 0});
        att.lastP = p;
        while (s.length > 64)
            s.shift();
    }

    _eventTime() {
        const t = Clutter.get_current_event_time();
        if (t > 0)
            return t;
        const h = Main.wm._workspaceAnimation?._swipeTracker?._history?._data;
        if (Array.isArray(h) && h.length && Number.isFinite(h[h.length - 1].time))
            return h[h.length - 1].time;
        return GLib.get_monotonic_time() / 1000;
    }

    _releaseVelocity(att) {
        const s = att.samples;
        if (!s.length)
            return 0;
        const stamp = Main.wm._workspaceAnimation?._swipeTracker?._history?._releaseStamp;
        const now = Clutter.get_current_event_time();
        const rel = Number.isFinite(stamp) && stamp >= s[s.length - 1].time ? stamp : now > 0 ? now : NaN;
        const v = estimateReleaseVelocity(s, rel, 0);
        return Number.isFinite(v) ? v : 0;
    }

    // ---- Vitre Stage's strip -----------------------------------------------------------------------------------------

    _stageMgr() {
        try {
            const mgr = Main.extensionManager.lookup(STAGE_UUID)?.stateObj?._manager;
            return mgr && mgr._strip && !mgr._stripGone && !mgr._disabled ? mgr : null;
        } catch (_e) {
            return null;
        }
    }

    _onActivated() {
        const cur = global.workspace_manager.get_active_workspace();
        const prev = this._activeWs ?? null;
        this._activeWs = cur;
        if (prev === cur)
            return;
        this._activation = {prev, cur};
        GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            if (this._activation?.cur === cur)
                this._activation = null;
            return GLib.SOURCE_REMOVE;
        });
        // a swipe landing: Stage cross-fades its strip; the old piles leave with the home card instead of fading in place
        const sd = Main.wm._workspaceAnimation?._switchData;
        const att = sd?.gestureActivated ? this._primaryAtt(sd) : null;
        if (att && this._stageMgr()) {
            const g = att.mg._workspaceGroups?.find(x => x.workspace === prev);
            if (g)
                this._stripTakeGhost(att, g);
            if (this._strip?.att === att)
                this._strip.follow = null;          // Stage's own fade brings the new piles in
        }
    }

    _stripForKey(att, target) {
        const mgr = this._stageMgr();
        const act = this._activation;
        if (!mgr || !act || (!mgr._stripTravel && !mgr._stripGhost))
            return;
        const departing = att.mg._workspaceGroups?.find(x => x.workspace === act.prev);
        const arriving = this._groupAt(att.mg, target);
        if (!arriving || arriving.workspace !== act.cur)
            return;
        try {
            mgr._stripTravel?.stop();       // Stage's own slide: its stopped handler resets the strip
        } catch (_e) { /* already stopped */ }
        if (departing)
            this._stripTakeGhost(att, departing);
        this._stripBegin(att, arriving, {clamp: true, mode: att.mode});
        this.stats.stripTakeovers++;
    }

    _stripTakeGhost(att, group) {
        const mgr = this._stageMgr();
        const ghost = mgr?._stripGhost;      // Stage made it in this same turn (it nulls the field when it drops one)
        if (!ghost || att.forgotten || ghost.get_n_children() === 0)
            return;
        const card = att.cards.find(c => c.group === group);
        const holder = new Clutter.Actor({name: 'vitreWorkspacesStripItems', reactive: false,
            x: ghost.x - att.monitor.x, y: ghost.y - att.monitor.y});
        for (const item of ghost.get_children()) {
            ghost.remove_child(item);
            holder.add_child(item);
        }
        if (card?.dim)
            group.insert_child_below(holder, card.dim);
        else
            group.add_child(holder);
        const h = {holder, ws: group.workspace, dead: false};
        holder.connect('destroy', () => {
            h.dead = true;
            this._holders = this._holders.filter(x => x !== h);
        });
        this._holders.push(h);
    }

    // a tail is replaced by new cards: its riding pile thumbnails move to the new card of the same workspace
    _rehomeHolders(switchData) {
        const keep = [];
        for (const h of this._holders) {
            if (h.dead)
                continue;
            let moved = false;
            for (const mg of switchData?.monitors ?? []) {
                const att = this._atts.get(mg);
                const g = mg._workspaceGroups?.find(x => x.workspace === h.ws);
                if (!att || !g)
                    continue;
                h.holder.get_parent()?.remove_child(h.holder);
                const card = att.cards.find(c => c.group === g);
                if (card?.dim)
                    g.insert_child_below(h.holder, card.dim);
                else
                    g.add_child(h.holder);
                moved = true;
                break;
            }
            if (moved)
                keep.push(h);
        }
        this._holders = keep;
    }

    _stripBegin(att, follow, {clamp, mode}) {
        const mgr = this._stageMgr();
        if (!mgr || !follow)
            return;
        this._stripEnd();
        const strip = mgr._strip;
        const u0 = this._uOf(att, follow);
        this._strip = {mgr, strip, att, follow, clamp, mode, side0: Math.sign(u0), crossed: Math.abs(u0) < 1e-4,
            ownsOpacity: strip.opacity === 255, transformed: false};
        this._stripApply();
    }

    // the coupling's strip is still Stage's live strip (Stage nulls or flags it when it goes)
    _stripLive(s) {
        return Boolean(s) && this._stageMgr() === s.mgr && s.mgr._strip === s.strip;
    }

    _stripApply() {
        const s = this._strip;
        if (!this._stripLive(s)) {
            this._strip = null;
            return;
        }
        const strip = s.strip;
        if (s.mgr._stripTravel) {
            // Stage runs a strip motion of its own now (a later switch, its fade): leave the strip to it
            s.follow = null;
        }
        const g = s.follow;
        if (!g || s.att.forgotten) {
            if (s.transformed && !s.mgr._stripTravel)
                strip.set_child_transform(null);
            s.transformed = false;
            return;
        }
        const att = s.att;
        const u = this._uOf(att, g);
        if (s.mode === 'reduce') {
            if (s.ownsOpacity)
                setOpacity(strip, (1 - Math.min(1, Math.abs(u))) * 255);
            return;
        }
        if (s.clamp && !s.crossed && (Math.sign(u) !== s.side0 || Math.abs(u) < 1e-4))
            s.crossed = true;               // docked: the strip does not follow the card's settle past its place
        if (s.clamp && s.crossed) {
            if (s.transformed)
                strip.set_child_transform(null);
            s.transformed = false;
            if (s.ownsOpacity)
                setOpacity(strip, 255);
            return;
        }
        const {S, x0, y0} = this._cardTransform(att, g);
        const sx = strip.x + strip.translation_x, sy = strip.y + strip.translation_y;
        const mx = att.monitor.x, my = att.monitor.y;
        const dx = x0 + S * (sx - mx) - sx;
        const dy = y0 + S * (sy - my) - sy;
        const m = new Graphene.Matrix();
        m.init_scale(S, S, 1);
        m.translate(new Graphene.Point3D({x: dx, y: dy, z: 0}));
        strip.set_child_transform(m);
        s.transformed = true;
        if (s.ownsOpacity)
            setOpacity(strip, (1 - lookAt(u, att.extent).dim) * 255);
    }

    _stripEnd() {
        const s = this._strip;
        this._strip = null;
        if (!this._stripLive(s))
            return;
        const strip = s.strip;
        if (s.mgr._stripTravel)
            return;                         // Stage's own motion owns the strip again
        if (s.transformed)
            strip.set_child_transform(null);
        if (s.ownsOpacity)
            strip.opacity = 255;
    }

    // ---- rig -----------------------------------------------------------------------------------------------------------

    snapshot() {
        const atts = [...this._atts.values()].map(att => ({
            monitor: att.mg.index, mode: att.mode, tail: att.tail, progress: att.mg.progress, excess: att.excess,
            run: att.run ? {kind: att.run.kind, t: att.run.t, T: att.run.plan.T, Tlogic: att.run.plan.Tlogic,
                from: att.run.plan.from, to: att.run.plan.to, v0: att.run.plan.v0, logic: Boolean(att.run.logicDone)} : null,
            cards: att.cards.map(c => {
                return {ws: c.group.workspace?.index?.() ?? -1, u: this._uOf(att, c.group), s: c.group.scale_x,
                    tx: c.group.translation_x, ty: c.group.translation_y, op: c.group.opacity, vis: c.group.visible,
                    dim: c.dim?.opacity ?? null, lo: c.edgeLo?.opacity ?? null, hi: c.edgeHi?.opacity ?? null};
            }),
        }));
        return {installed: this._installed, tails: this._tails.size, holders: this._holders.length, strip: Boolean(this._strip),
            drag: this._drag?.title ?? null, stats: {...this.stats}, last: this.last, atts};
    }
}

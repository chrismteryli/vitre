/* The menu-bar HUD: a wide clear-glass capsule that drops below the top bar, anchored
 * top-centre under the Control Center icon, with the matching glyph and a level bar; the
 * top-bar icon is swapped for the glyph in a highlighted pill while it is up.
 *
 * Motion is the frame-measured the reference design.x beta recording (plans/A14-measurements.md 1a):
 *   enter : whole capsule opacity follows the measured presence table (50 % at +165 ms, 90 %
 *           at +335 ms, 98 % at +500 ms), content visible first, glass (blur, tint, rim)
 *           about 35 ms later, scale about the top-centre from 0.92 high / ~0.95 wide to 1.0,
 *           no overshoot, the top edge never moves
 *   dwell : 0.9 s after the last value change; a new value updates the fill and extends the
 *           dwell (no re-enter); a value that arrives during the exit turns the exit around
 *   exit  : 195 ms S-shaped fade (50 % at +83 ms) with the scale played back
 * The time source is a Clutter.Timeline (NOT slowed by St's slow-down factor, which Just
 * Perfection sets to 0.8): the reference's durations are used as measured. Animations off or reduced
 * motion: the capsule appears and disappears in one frame.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GlassLayer, MARGIN} from './glass.js';
import {deriveGeometry} from './geometry.js';
import {levelFraction} from './osd.js';
import * as C from './curves.js';
import {DripController, motionAllowed as dripMotionAllowed} from './liquidDrip.js';
import {DripStyle} from './dripStyle.js';
import {HudDripAdapter} from './hudDrip.js';

const HIDDEN = 'hidden';
const ENTERING = 'entering';
const SHOWN = 'shown';
const EXITING = 'exiting';
const CARRY_MS = 100;   // a reversal blends from the scale it had to the table over this long
// The old top-bar icons hand over to the pill while the capsule is below this presence (not measured:
// the recording does not resolve the swap; a short hand-off avoids two glyphs ghosting over each other).
export const INDICATOR_HANDOFF = 0.3;

const lerp = (a, b, w) => a + (b - a) * w;

export class MenubarHud {
    constructor() {
        this._state = HIDDEN;
        this._actors = null;
        this._timeline = null;
        this._phase = null;
        this._phaseT0 = 0;
        this._phaseT = 0;
        this._carry = null;
        this._dwellId = 0;
        this._unredirect = false;
        this._swap = null;
        this._geo = null;
        this._content = null;
        this._env = 0;
        this._scale = {sx: 1, sy: 1};
        this._qsMenu = null;
        // A17: liquid drip (drip-style liquid | classic, read from the liquid-menus schema; liquid if it is absent)
        this._dripStyle = new DripStyle();
        this._dripAdapter = new HudDripAdapter(this);
        this._drip = new DripController('hud', this._dripAdapter, {prewarm: 5, prewarmIf: () => this._dripStyle?.liquid});
        this._drip.callbacks.onClosed = () => this._hideNow();
    }

    // the drip controls the capsule while it is not closed
    get _liquid() {
        return this._drip.phase !== 'closed';
    }

    get state() {
        if (this._liquid) {
            return {opening: ENTERING, open: SHOWN, closing: EXITING}[this._drip.phase] ?? HIDDEN;
        }
        return this._state;
    }

    get drip() {
        return this._drip;
    }

    get dripStyle() {
        return this._dripStyle;
    }

    // True while the Control Center is open: its sliders already show the new value live.
    blocked() {
        return Boolean(Main.panel?.statusArea?.quickSettings?.menu?.isOpen);
    }

    _motionAllowed() {
        const settings = St.Settings.get();
        return settings.enable_animations && settings.reducedMotion !== St.ReducedMotion.REDUCE;
    }

    // ---- actors ---------------------------------------------------------------------------

    _ensureActors() {
        if (this._actors)
            return;
        const root = new Clutter.Actor({name: 'menubar-hud', reactive: false, visible: false, opacity: 0});
        root.set_pivot_point(0.5, 0);
        const glass = new GlassLayer({radius: 0});
        root.add_child(glass.actor);
        const glyph = new St.Icon({style_class: 'mbhud-glyph', icon_name: 'audio-volume-high-symbolic'});
        const track = new St.Widget({style_class: 'mbhud-track'});
        const fill = new St.Widget({style_class: 'mbhud-fill'});
        root.add_child(glyph);
        root.add_child(track);
        root.add_child(fill);

        const pill = new St.Widget({style_class: 'mbhud-pill', layout_manager: new Clutter.BinLayout(),
            reactive: false, visible: false, opacity: 0});
        const pillGlyph = new St.Icon({style_class: 'mbhud-pill-glyph', icon_name: 'audio-volume-high-symbolic',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});
        pill.add_child(pillGlyph);

        Main.uiGroup.add_child(root);
        Main.uiGroup.add_child(pill);
        this._actors = {root, glass, glyph, track, fill, pill, pillGlyph};
        // The shell tears the stage down on sign-out / restart while a motion or the dwell may still be running (the capsule
        // is a uiGroup child): stop both when the capsule is destroyed, so the next frame never writes to disposed actors
        // ('already disposed' x5 in the log at shutdown, also in the code before A17).
        root.connectObject('destroy', () => {
            this._stopTimeline();
            this._clearDwell();
        }, this);

        const menu = Main.panel?.statusArea?.quickSettings?.menu;
        if (menu) {
            this._qsMenu = menu;
            menu.connectObject('open-state-changed', (_m, open) => {
                if (open)
                    this.dismiss(true);
            }, this);
        }
    }

    // Place everything for a fresh appearance (geometry derived from the bar, see geometry.js).
    _layout() {
        const {root, glass, glyph, track, fill, pill} = this._actors;
        const monitor = Main.layoutManager.primaryMonitor;
        const qs = Main.panel.statusArea.quickSettings;
        let itemCenterX = NaN;
        if (qs?.mapped) {
            const [x] = qs.get_transformed_position();
            const [w] = qs.get_transformed_size();
            if (Number.isFinite(x) && Number.isFinite(w))
                itemCenterX = x + w / 2;
        }
        const g = deriveGeometry({panelH: Main.panel.height, monitor, itemCenterX});
        this._geo = g;
        root.set_position(g.x, g.y);
        root.set_size(g.w, g.h);
        glass.actor.set_position(-MARGIN, -MARGIN);
        glass.actor.set_size(g.w + 2 * MARGIN, g.h + 2 * MARGIN);
        glass.radius = g.radius;
        glass.sync(g.w, g.h, g.x - MARGIN, g.y - MARGIN);

        glyph.icon_size = g.glyph;
        glyph.set_position(g.inset, Math.round((g.h - g.glyph) / 2));
        const trackX = g.inset + g.glyph + g.gapGlyph;
        const trackW = g.w - g.inset - trackX;
        const trackY = Math.round((g.h - g.track) / 2);
        this._trackW = trackW;
        for (const bar of [track, fill]) {
            bar.set_position(trackX, trackY);
            bar.set_height(g.track);
            bar.set_style(`border-radius: ${g.track / 2}px;`);
        }
        track.set_width(trackW);

        if (g.pillX !== null) {
            pill.set_position(g.pillX, g.pillY);
            pill.set_size(g.pillW, g.pillH);
            pill.set_style(`border-radius: ${g.pillH / 2}px;`);
        }
    }

    // ---- content --------------------------------------------------------------------------

    _setContent(content, animate) {
        const {glyph, fill, pillGlyph} = this._actors;
        this._content = content;
        if (glyph.icon_name !== content.iconName)
            glyph.icon_name = content.iconName;
        if (pillGlyph.icon_name !== content.iconName)
            pillGlyph.icon_name = content.iconName;
        const width = Math.round(levelFraction(content.level, content.maxLevel) * this._trackW);
        fill.remove_all_transitions();
        if (animate && fill.visible && this._motionAllowed()) {
            fill.ease({width, duration: C.LEVEL_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            fill.width = width;
        }
        fill.visible = true;
    }

    // ---- public ---------------------------------------------------------------------------

    show(content) {
        this._ensureActors();
        const instant = !this._motionAllowed();
        // liquid drip: the capsule is already drip-controlled (or about to be): a new value only updates it
        if (this._liquid && !instant && this._dripStyle.liquid) {
            this._setContent(content, true);
            this._armDwell();
            if (this._drip.phase === 'closing')
                this._drip.open();      // a value during the exit turns the exit around, from where it is
            return;
        }
        if (this._liquid) {
            this._drip.reset();
            // The drip was in charge of the capsule (the style was switched to classic, or animations went off, while it was up): it
            // stays up, settled. Without this the capsule kept the 'entering' state of the drip with the table's presence at 0
            // for the rest of the dwell, and its exit then started from the wrong presence.
            if (this._state === ENTERING && this._actors.root.visible) {
                this._applyFinal();
                this._state = SHOWN;
            }
        }
        if (this._state === HIDDEN) {
            this._layout();
            this._setContent(content, false);
            this._holdUnredirect();
            this._beginSwap();
            this._actors.root.show();
            this._armDwell();
            if (!instant && this._dripStyle.liquid) {
                this._actors.root.opacity = 255;
                this._state = ENTERING;
                this._drip.open();
                return;
            }
            if (instant) {
                this._stopTimeline();
                this._applyFinal();
                this._state = SHOWN;
            } else {
                this._run('enter', 0, null);
            }
            return;
        }
        this._setContent(content, true);
        this._armDwell();
        if (this._state === EXITING) {
            // turn the exit around at the current presence: no flash
            const carry = {...this._scale};
            if (instant) {
                this._stopTimeline();
                this._applyFinal();
                this._state = SHOWN;
            } else {
                this._run('enter', C.enterTimeForPresence(this._env), carry);
            }
        }
    }

    // Begin leaving now (dwell expired or the Control Center opened). immediate = no animation.
    dismiss(immediate = false) {
        this._clearDwell();
        if (this._liquid) {
            if (immediate || !this._motionAllowed() || !this._dripStyle.liquid) {
                this._drip.reset();
                this._hideNow();
                return;
            }
            this._drip.close();
            return;
        }
        if (this._state === HIDDEN)
            return;
        if (immediate || !this._motionAllowed()) {
            this._stopTimeline();
            this._hideNow();
            return;
        }
        if (this._state === EXITING)
            return;
        const carry = this._state === ENTERING ? {...this._scale} : null;
        this._run('exit', this._state === ENTERING ? C.exitTimeForPresence(this._env) : 0, carry);
    }

    destroy() {
        this._clearDwell();
        this._drip.destroy();
        this._dripStyle.destroy();
        this._stopTimeline();
        this._qsMenu?.disconnectObject(this);
        this._qsMenu = null;
        this._endSwap();
        this._releaseUnredirect();
        if (this._actors) {
            this._actors.fill.remove_all_transitions();
            this._actors.glass.destroy();
            this._actors.root.destroy();
            this._actors.pill.destroy();
            this._actors = null;
        }
        this._state = HIDDEN;
    }

    // What the rig samples every frame.
    snapshot() {
        if (!this._actors)
            return {state: this._state, built: false};
        const {root, glass, fill, pill} = this._actors;
        const ext = actor => {
            const e = actor.get_transformed_extents();
            return {x: e.get_x(), y: e.get_y(), w: e.get_width(), h: e.get_height()};
        };
        const ind = this._swap?.indicators;
        return {
            state: this._state, phase: this._phase, phaseT: Math.round(this._phaseT * 100) / 100,
            env: this._env, sx: this._scale.sx, sy: this._scale.sy,
            root: {vis: root.visible, op: root.opacity, po: root.get_paint_opacity(), ...ext(root)},
            glassOp: glass.actor.opacity, fillW: fill.width, fillVis: fill.visible,
            pill: {vis: pill.visible, op: pill.opacity, ...ext(pill)},
            indicatorsOp: ind ? ind.opacity : null,
            content: this._content, drip: this._drip.snapshot(),
        };
    }

    // ---- motion ---------------------------------------------------------------------------

    _stopTimeline() {
        if (!this._timeline)
            return;
        this._timeline.stop();
        this._timeline.disconnectObject(this);
        this._timeline = null;
    }

    _run(phase, t0, carry) {
        this._stopTimeline();
        this._phase = phase;
        this._phaseT0 = t0;
        this._carry = carry;
        this._state = phase === 'enter' ? ENTERING : EXITING;
        const total = phase === 'enter' ? C.ENTER_MS : C.EXIT_MS;
        this._apply(phase, t0);
        const timeline = new Clutter.Timeline({duration: Math.max(1, total - t0) + 50, actor: this._actors.root});
        this._timeline = timeline;
        timeline.connectObject('new-frame', () => {
            const s = t0 + timeline.get_elapsed_time();
            this._apply(phase, Math.min(s, total));
            if (s < total)
                return;
            timeline.stop();
            timeline.disconnectObject(this);
            if (this._timeline === timeline)
                this._timeline = null;
            if (phase === 'enter') {
                this._applyFinal();
                this._state = SHOWN;
            } else {
                this._hideNow();
            }
        }, this);
        timeline.start();
    }

    // One frame of the motion at phase time s (ms).
    _apply(phase, s) {
        const enter = phase === 'enter';
        const env = enter ? C.enterPresence(s) : C.exitPresence(s);
        let sc = enter ? C.enterScale(s) : C.exitScale(s);
        if (this._carry) {
            const w = Math.max(0, 1 - (s - this._phaseT0) / CARRY_MS);
            sc = {sx: lerp(sc.sx, this._carry.sx, w), sy: lerp(sc.sy, this._carry.sy, w)};
        }
        const gate = enter ? C.glassGate(s) : 1;
        this._phaseT = s;
        this._paint(env, sc, gate);
    }

    _applyFinal() {
        this._phase = null;
        this._carry = null;
        this._paint(1, {sx: 1, sy: 1}, 1);
    }

    _paint(env, sc, gate) {
        const {root, glass, pill} = this._actors;
        this._env = env;
        this._scale = sc;
        root.opacity = env > 0 ? Math.max(1, Math.round(255 * env)) : 0;
        root.set_scale(sc.sx, sc.sy);
        glass.actor.opacity = Math.round(255 * gate);
        if (this._swap) {
            pill.opacity = this._swap.on ? Math.round(255 * env) : 0;
            if (this._swap.indicators)
                this._swap.indicators.opacity = Math.round(this._swap.indicatorsOp * (1 - C.clamp01(env / INDICATOR_HANDOFF)));
        }
    }

    _hideNow() {
        this._clearDwell();
        this._phase = null;
        this._carry = null;
        this._state = HIDDEN;
        this._env = 0;
        if (!this._actors)
            return;
        this._actors.root.hide();
        this._actors.root.opacity = 0;
        this._endSwap();
        this._releaseUnredirect();
    }

    // ---- dwell ----------------------------------------------------------------------------

    _armDwell() {
        this._clearDwell();
        this._dwellId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, C.DWELL_MS, () => {
            this._dwellId = 0;
            this.dismiss(false);
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._dwellId, '[menubar-hud] dwell');
    }

    _clearDwell() {
        if (!this._dwellId)
            return;
        GLib.source_remove(this._dwellId);
        this._dwellId = 0;
    }

    // ---- top-bar icon swap ----------------------------------------------------------------

    _beginSwap() {
        const {pill} = this._actors;
        const qs = Main.panel?.statusArea?.quickSettings;
        const barUp = Boolean(qs?.mapped && Main.layoutManager.panelBox.visible && this._geo.pillX !== null);
        const indicators = barUp ? (qs._indicators ?? null) : null;
        this._swap = {on: barUp, indicators, indicatorsOp: indicators ? indicators.opacity : 255};
        pill.opacity = 0;
        pill.visible = barUp;
    }

    _endSwap() {
        const swap = this._swap;
        this._swap = null;
        if (swap?.indicators && swap.indicators.opacity !== swap.indicatorsOp)
            swap.indicators.opacity = swap.indicatorsOp;
        if (this._actors) {
            this._actors.pill.visible = false;
            this._actors.pill.opacity = 0;
        }
    }

    // ---- compositor -----------------------------------------------------------------------

    // Like GNOME's own OSD: keep the HUD above a fullscreen window that would be unredirected.
    _holdUnredirect() {
        if (this._unredirect)
            return;
        global.compositor.disable_unredirect();
        this._unredirect = true;
    }

    _releaseUnredirect() {
        if (!this._unredirect)
            return;
        global.compositor.enable_unredirect();
        this._unredirect = false;
    }
}

/* The Vitre end-session dialog (plan I5): Log Out / Restart / Power Off.
 *
 * GNOME builds ONE EndSessionDialog at startup (Main.endSessionDialog) and gnome-session talks to it over D-Bus. This
 * decorates that instance and never replaces or re-implements any of its methods: no method override at all, only
 *   - a style class on the card (CSS: ink glass, Control Center's glass pills for the buttons),
 *   - the Vitre mark above the title and a countdown track under the text,
 *   - a listener on the dialog's `notify::state` (OPENING / CLOSING / CLOSED) that runs the liquid drip: a thin glass bar
 *     at the top centre pulls a drop that falls to the card's top and blooms into the card (the A17 drip: dripMotion.js,
 *     the same constants and curves as every top-bar pop-out), and the reverse when it closes.
 * The glass of the card is a GlassSheet (the A17 field) parked in the UI group just under the modal group (a BinLayout parent gives the field a zero width); the card's CSS
 * then paints no glass of its own (class vitre-es-glass). If the sheet cannot be built the card keeps its solid ink fill.
 * Buttons, keys (Escape = Cancel, the stock initial focus on Cancel), the countdown, the D-Bus signals and the 100 ms
 * stock fade are all untouched: the stock timer decides when the session ends, this only draws.
 */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {DripClock, clamp01} from './dripMotion.js';
import {END_OPTS, cardMoved, dropContext, dropFrame, retargetContext} from './vitreMotion.js';
import {FrameClock, GlassSheet, SESSION_SLOW, boxAround, fault, motionAllowed, stageRect, wallMs} from './sessionDrip.js';
import {markerPresent} from './lockStyle.js';

const MARK_SIZE = 52;
const GEOMETRY_TIMEOUT_MS = 700;
const WATCHDOG_MS = 4000;
const PILL_W = 84;
const PILL_H = 8;
const PILL_GAP = 8;             // below the panel
const PREWARM_MS = 2500;

// Ink glass for the card over the live desktop: navy tint, a little saturation, the house blur
export const ES_FINISH = {
    tint: 0.46, rimSide: 0.16, rimTop: 0.80, rimBottom: 0.70, rimWidth: 1.9,
    tintColor: [0.031, 0.071, 0.149], saturation: 1.4,
};
export const ES_BLUR = 24;
export const ES_BRIGHTNESS = 0.92;

class Countdown {
    constructor(fill) {
        this.fill = fill;
        this._timer = 0;
        this._total = 0;
        this._t0 = 0;
    }

    start(totalSeconds) {
        this.stop();
        this._total = totalSeconds;
        if (!(totalSeconds > 0)) {
            this.fill.get_parent().visible = false;
            return;
        }
        this.fill.get_parent().visible = true;
        this.fill.set_pivot_point(0, 0.5);
        this.fill.scale_x = 1;
        this._t0 = wallMs();
        // Stepped from the wall clock, not eased: an ease would redraw the whole card (it is an offscreen actor) at every
        // frame, 120 times a second, for up to a minute, and Clutter only animates mapped actors anyway. 5 steps a
        // second move the 4 px bar by under 2 px each: smooth, and nearly free. (1 step a second without motion.)
        const period = motionAllowed() ? 200 : 1000;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, period, () => {
            const left = Math.max(0, 1 - (wallMs() - this._t0) / (this._total * 1000));
            this.fill.scale_x = left;
            if (left > 0)
                return GLib.SOURCE_CONTINUE;
            this._timer = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
    }
}

export class EsDrip {
    constructor(skin) {
        this.skin = skin;
        this.phase = 'closed';      // closed | waiting | opening | open | closing
        this.clock = new FrameClock(ms => this._onFrame(ms));
        this.dclock = null;
        this.ctx = null;
        this.sheet = null;
        this.log = null;
        this.lastFrame = null;
        this.stats = {frames: 0, aborts: [], opens: 0, closes: 0};
        this._waitSince = 0;
        this._watchdogId = 0;
        this._failed = false;
        this._openCalls = 0;
    }

    get busy() {
        return this.phase === 'waiting' || this.phase === 'opening' || this.phase === 'closing';
    }

    // ---- API -------------------------------------------------------------------------------------------------

    open() {
        const skin = this.skin;
        this.stats.opens++;
        if (this._failed || !motionAllowed()) {
            this._settleWithoutMotion();
            return;
        }
        if (this.phase === 'closing') {
            // reversal: continue from where the retract is
            this.dclock.open(this._now());
            this.phase = 'opening';
            skin.card.remove_all_transitions();
            return;
        }
        if (this.busy || this.phase === 'open')
            return;
        this.phase = 'waiting';
        this._waitSince = wallMs();
        skin.card.opacity = 0;          // nothing of the card is seen before the glass covers it
        this.clock.start();
        this._armWatchdog();
    }

    close(scale = 1) {
        this.stats.closes++;
        if (this.phase === 'waiting') {
            this._abort('closed-while-waiting');
            return;
        }
        if (this.phase === 'closed')
            return;
        if (!motionAllowed() || !this.ctx) {
            this._abort('no-motion');
            return;
        }
        if (this.phase === 'open') {
            // from rest: rebuild from the current card (a list may have changed its height)
            const geom = this._geometry(true);
            if (geom)
                this.ctx = dropContext(geom, this.skin.style.motion, END_OPTS);
            this.dclock = new DripClock(this.ctx.totalMs);
            this.dclock.tau = this.dclock.totalMs;
            if (!this.clock.running)
                this.clock.start();
            this._armWatchdog();
        }
        this.dclock.close(this._now(), scale, clamp01(this.skin.card.opacity / 255));
        this.phase = 'closing';
    }

    // ---- frame -----------------------------------------------------------------------------------------------

    _now() {
        return this.clock.now();
    }

    _onFrame(ms) {
        if (this.phase === 'closed' || this.phase === 'open')
            return;
        try {
            this._frame(ms);
        } catch (e) {
            this._fail(e);
        }
    }

    _frame(ms) {
        fault('es-frame');
        if (this.phase === 'waiting') {
            const geom = this._geometry(false);
            if (!geom) {
                if (wallMs() - this._waitSince > GEOMETRY_TIMEOUT_MS && !this.clock.manual)
                    this._abort('geometry-timeout');
                return;
            }
            this.ctx = dropContext(geom, this.skin.style.motion, END_OPTS);
            this._ensureSheet();
            this.dclock = new DripClock(this.ctx.totalMs);
            this.dclock.open(ms);
            this.phase = 'opening';
            this.stats.geometryWaitMs = Math.round(wallMs() - this._waitSince);
        }
        const u = this.dclock.update(ms);
        this._apply(u.tau, ms);
        if (u.finished === 'open')
            this._finishOpen();
        else if (u.finished === 'close')
            this._finishClose();
    }

    _apply(tau, ms) {
        const skin = this.skin;
        const fr = dropFrame(this.ctx, Math.min(tau, this.ctx.totalMs));
        this.lastFrame = fr;
        this.stats.frames++;
        this.sheet.setShapes(fr.shapes, fr.k);
        this._tint(fr);
        this.sheet.setOpacity(this.measure === 'coverage' ? 1 : fr.fieldAlpha);
        let content = fr.contentAlpha;
        if (this.phase === 'closing')
            content = Math.min(content, this.dclock.contentCeiling(ms));
        skin.card.opacity = Math.round(255 * clamp01(content));
        if (this.log)
            this.log.push({tau: Math.round(tau * 10) / 10, phase: this.phase, k: fr.k, fieldAlpha: fr.fieldAlpha, content,
                shapes: fr.shapes.map(s => [s.x, s.y, s.w, s.h, s.r].map(v => Math.round(v * 100) / 100))});
    }

    // clear white glass while the bead flies, ink glass once the card has bloomed
    _tint(fr) {
        if (fr.tint === undefined)
            return;
        const b = fr.tintBlend ?? 1;
        const [r, g, bl] = ES_FINISH.tintColor;
        this.sheet.field.setTint(fr.tint);
        this.sheet.setTintColor(1 + (r - 1) * b, 1 + (g - 1) * b, 1 + (bl - 1) * b);
    }

    _geometry(_rest) {
        const skin = this.skin;
        const rect = stageRect(skin.card);
        if (!rect)
            return null;
        let radius = 36;
        try {
            const r = skin.card.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
            if (Number.isFinite(r) && r > 0)
                radius = r;
        } catch (_e) {
            // default
        }
        const panelH = Main.panel?.height || 32;
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const bar = {x: cx - PILL_W / 2, y: panelH + PILL_GAP, w: PILL_W, h: PILL_H};
        return {
            source: {cx, cy: bar.y + bar.h / 2, r: bar.h / 2, bar},
            landing: {x: cx - 1, y: cy - 1, w: 2, h: 2},
            card: {x: rect.x, y: rect.y, w: rect.w, h: rect.h, r: radius},
        };
    }

    _ensureSheet() {
        if (this.sheet && !this.sheet.dead)
            return;
        const box = boxAround([this.ctx.bar, this.ctx.card], 24);
        this.sheet = this.skin.takeSheet(box);
        this.skin.card.add_style_class_name('vitre-es-glass');
    }

    _settleWithoutMotion() {
        // animations off / reduced motion / a failure: the card simply is (solid ink fill, no glass sheet)
        this._teardown();
        this.skin.card.opacity = 255;
        this.phase = 'closed';
    }

    _finishOpen() {
        // at rest: keep the sheet (parked in place) on the final shape, stop the clock
        this._stopClock();
        this.skin.card.opacity = 255;
        this.phase = 'open';
        if (this.sheet) {
            const fr = dropFrame(this.ctx, this.ctx.totalMs);
            this.sheet.setShapes(fr.shapes, fr.k);
            this._tint(fr);
            this.sheet.setOpacity(1);
            // the card may have grown while the drip ran (see refit): fit the glass to the card as it is NOW
            this.refit();
        }
    }

    _finishClose() {
        this._teardown();
        this.phase = 'closed';
        // the stock fade has hidden the dialog by now (it takes 100 ms, the retract at least 72 ms): the card is whole again
        // for the next open. If the retract ended first, the CLOSED notification does this.
        if (this.skin.dialog.state === ModalDialog.State.CLOSED)
            this.skin.card.opacity = 255;
    }

    _abort(reason) {
        this.stats.aborts.push(reason);
        this._teardown();
        this.skin.card.opacity = 255;
        this.phase = 'closed';
    }

    _fail(error) {
        if (!this._failed) {
            this._failed = true;
            console.error(`Vitre Session: end-session drip failed, plain card kept: ${error.message}\n${error.stack ?? ''}`);
        }
        this._abort('error');
    }

    _armWatchdog() {
        if (this.clock.manual)
            return;
        if (this._watchdogId)
            GLib.Source.remove(this._watchdogId);
        this._watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCHDOG_MS * SESSION_SLOW, () => {
            this._watchdogId = 0;
            if (this.busy)
                this._abort('watchdog');
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopClock() {
        this.clock.stop();
        if (this._watchdogId) {
            GLib.Source.remove(this._watchdogId);
            this._watchdogId = 0;
        }
    }

    _teardown() {
        this._stopClock();
        if (this.sheet) {
            this.skin.releaseSheet(this.sheet);
            this.sheet = null;
        }
        try {
            this.skin.card.remove_style_class_name('vitre-es-glass');
        } catch (_e) {
            // destroyed
        }
        this.ctx = null;
    }

    // The glass must follow the card, in the drip as well as at rest: the lists of busy applications and other users load
    // asynchronously a few tens of ms after the dialog opened (the normal case: the inhibitor proxies answer while the
    // drip is still running) and the card grows and re-centres then. While the drip runs only the GEOMETRY of the running
    // context is replaced (its timeline stays, so the bead does not jump); at rest the context is rebuilt.
    refit() {
        const running = this.phase === 'opening';
        if (!(running || this.phase === 'open') || !this.sheet || this.sheet.dead || !this.ctx)
            return;
        const geom = this._geometry(true);
        if (!geom)
            return;
        const next = dropContext(geom, this.skin.style.motion, END_OPTS);
        if (!cardMoved(this.ctx.card, next.card, 0.25))
            return;
        this.stats.refits = (this.stats.refits ?? 0) + 1;
        if (running)
            retargetContext(this.ctx, next);
        else
            this.ctx = next;
        this.sheet.setBox(boxAround([this.ctx.bar, this.ctx.card], 24));
        if (!running) {
            const fr = dropFrame(this.ctx, this.ctx.totalMs);
            this.sheet.setShapes(fr.shapes, fr.k);
        }
        // (while opening, the next frame of the running clock draws the new shapes)
    }

    // the dialog is fading out after a confirmation: the glass follows the stock fade (dialogLayout opacity)
    followOpacity(alpha) {
        if (this.phase === 'open' && this.sheet)
            this.sheet.setOpacity(alpha);
    }

    destroy() {
        this._teardown();
        this.phase = 'closed';
    }
}

export class EndSkin {
    constructor(dialog, style) {
        this.dialog = dialog;
        this.style = style;
        this.card = dialog.dialogLayout._dialog;
        this.dead = false;
        this.failed = false;
        this.mark = null;
        this.track = null;
        this.fill = null;
        this.countdown = null;
        this.drip = new EsDrip(this);
        this._spare = null;
        this._prewarmId = 0;
    }

    build() {
        const d = this.dialog;
        const card = this.card;
        card.add_style_class_name('vitre-es');
        fault('es-build');
        const file = Gio.File.new_for_path(GLib.build_filenamev([this.style.dir, 'assets', 'vitre-mark.svg']));
        this.mark = new St.Icon({
            style_class: 'vitre-es-mark', gicon: new Gio.FileIcon({file}), icon_size: MARK_SIZE,
            x_align: Clutter.ActorAlign.CENTER, reactive: false,
        });
        card.insert_child_at_index(this.mark, 0);
        this.track = new St.Widget({style_class: 'vitre-es-track', layout_manager: new Clutter.BinLayout(), reactive: false, visible: false});
        this.fill = new St.Widget({style_class: 'vitre-es-fill', x_expand: true, y_expand: true, reactive: false,
            pivot_point: new Graphene.Point({x: 0, y: 0.5})});
        this.track.add_child(this.fill);
        card.insert_child_below(this.track, d.buttonLayout);
        this.countdown = new Countdown(this.fill);
        d.connectObject('notify::state', () => this._onState(), this);
        d.dialogLayout.connectObject('notify::opacity', () => this.drip.followOpacity(d.dialogLayout.opacity / 255), this);
        card.connectObject('notify::allocation', () => {
            try {
                this.drip.refit();
            } catch (_e) {
                // the glass keeps its last shape
            }
        }, this);
        // a dialog that is already open (the extension was enabled while it was up): just the plain skin
        this._prewarmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREWARM_MS, () => {
            this._prewarmId = 0;
            try {
                this._prewarm();
            } catch (_e) {
                // not worth failing for
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onState() {
        if (this.dead || this.failed)
            return;
        try {
            const d = this.dialog;
            fault('es-state');
            switch (d.state) {
            case ModalDialog.State.OPENING:
                this._onOpening();
                break;
            case ModalDialog.State.CLOSING:
                this.countdown?.stop();
                this.drip.close();
                break;
            case ModalDialog.State.CLOSED:
                this.countdown?.stop();
                if (!this.drip.busy)
                    this.drip._settleWithoutMotion();
                break;
            case ModalDialog.State.FADED_OUT:
                this.countdown?.stop();
                break;
            default:
                break;
            }
        } catch (e) {
            this.failed = true;         // one log line, then this skin stops reacting: the (styled) card stays as a plain card
            console.error(`Vitre Session: end-session hook failed, plain card kept: ${e.message}\n${e.stack ?? ''}`);
            try {
                this.drip._abort('error');
            } catch (_e) {
                // nothing more to do
            }
        }
    }

    _onOpening() {
        const d = this.dialog;
        this.countdown.start(d._totalSecondsToStayOpen ?? 0);
        this.drip.open();
    }

    // ---- the glass sheet pool (one spare, built early) ------------------------------------------------------------

    _makeSheet(box) {
        return new GlassSheet({
            parent: Main.uiGroup, below: Main.layoutManager.modalDialogGroup, box, finish: ES_FINISH,
            blurRadius: ES_BLUR, brightness: ES_BRIGHTNESS, name: 'vitre-es-glass',
        });
    }

    _prewarm() {
        if (this.dead || this._spare)
            return;
        this._spare = this._makeSheet({x: 0, y: 0, w: 8, h: 8});
        this._spare.warm();
    }

    takeSheet(box) {
        let sheet = this._spare;
        this._spare = null;
        if (sheet && !sheet.dead) {
            sheet.use(box);
            return sheet;
        }
        sheet = this._makeSheet(box);
        sheet.use(box);
        return sheet;
    }

    releaseSheet(sheet) {
        if (sheet.dead)
            return;
        sheet.release();
        sheet.setOpacity(0);
        if (!this._spare && !this.dead) {
            sheet.park();
            this._spare = sheet;
        } else {
            sheet.destroy();
        }
    }

    destroy() {
        this.dead = true;
        if (this._prewarmId) {
            GLib.Source.remove(this._prewarmId);
            this._prewarmId = 0;
        }
        try {
            this.drip.destroy();
        } catch (_e) {
            // keep restoring
        }
        this.countdown?.stop();
        this._spare?.destroy();
        this._spare = null;
        const d = this.dialog;
        try {
            d.disconnectObject(this);
            d.dialogLayout.disconnectObject(this);
            this.card.disconnectObject(this);
            this.card.remove_style_class_name('vitre-es');
            this.card.remove_style_class_name('vitre-es-glass');
            this.card.opacity = 255;
            for (const actor of [this.mark, this.track])
                actor?.destroy();
        } catch (_e) {
            // the dialog is gone
        }
        this.mark = this.track = this.fill = null;
    }
}

export class EndStyle {
    constructor({dir, motion}) {
        this.dir = dir;
        this.motion = motion;
        this.skin = null;
    }

    enable() {
        fault('es-enable');
        if (markerPresent('stock-end-session'))
            return;                         // kill switch: ~/.config/vitre-session/stock-end-session
        const dialog = Main.endSessionDialog;
        if (!dialog?.dialogLayout?._dialog)
            throw new Error('Main.endSessionDialog is not available');
        this.skin = new EndSkin(dialog, this);
        try {
            this.skin.build();
        } catch (e) {
            try {
                this.skin.destroy();
            } catch (_e) {
                // nothing more to do
            }
            this.skin = null;
            throw e;
        }
    }

    disable() {
        this.skin?.destroy();
        this.skin = null;
    }
}

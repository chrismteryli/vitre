/* The Vitre lock screen (plan I3): restyles GNOME's in-session UnlockDialog.
 *
 * SAFETY IS THE FIRST REQUIREMENT. The stock dialog is always built first, by the stock code: the only hook that
 * touches creation (ScreenShield._ensureUnlockDialog) calls the original and decorates AFTER it returned, inside
 * try/catch. Decoration only ADDS (a style class, a scrim, the mark, a ring, a glass sheet during the intro) and
 * adjusts transforms of widgets that stock already animates; it never replaces the password entry, the buttons, the
 * key handling, the user switcher or the login-options menu, never takes input (every added actor is
 * non-reactive and hidden from picking) and never touches the three UnlockDialog background methods that Blur my Shell
 * patches. If anything throws, the skin removes itself and the stock dialog (styled by the default theme) is what the
 * user sees; the intro has a watchdog that puts every actor back to its stock state.
 *
 * What it adds (identity/brand: logo concept A, name Vitre):
 *   - .vitre-lock on the dialog: the stylesheet (house glass: big light clock with the date above it, glass hint pill,
 *     glass capsule password field with a cyan submit disc, a glass unlock card behind avatar + name, glass pills for
 *     Switch User / Login Options);
 *   - a navy scrim over the (blurred) wallpaper that deepens a little when the prompt opens;
 *   - the small Vitre mark at the top;
 *   - the liquid-drip intro when the prompt opens: a bead buds from the mark, snaps free, falls into the password
 *     capsule with a cyan pulse and blooms into the unlock card (vitreMotion.js).
 */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ScreenShield} from 'resource:///org/gnome/shell/ui/screenShield.js';
import {UnlockDialog} from 'resource:///org/gnome/shell/ui/unlockDialog.js';

import {clamp01, lerp} from './dripMotion.js';
import {cardMoved, lockIntroContext, lockIntroFrame, retargetContext} from './vitreMotion.js';
import {FrameClock, GlassSheet, boxAround, fault, motionAllowed, stageRect, wallMs} from './sessionDrip.js';
import {GLASS_FINISH} from './glass.js';

const MARK_SIZE = 56;
const MARK_TOP_GAP = 26;            // below the panel
const GEOMETRY_TIMEOUT_MS = 900;    // the password entry must exist this soon after the prompt opens, else no intro
const WATCHDOG_MS = 3000;           // the intro is forcibly ended (everything back to stock) after this
const NOTIF_GAP = 16;               // prompt page: the card ends this far above the notifications box

// The clear finish of the lock card: white 10 % tint over the (already blurred) lock background, as the CSS card
export const LOCK_FINISH = {...GLASS_FINISH};

export function markerPresent(name) {
    try {
        return GLib.file_test(GLib.build_filenamev([GLib.get_user_config_dir(), 'vitre-session', name]), GLib.FileTest.EXISTS);
    } catch (_e) {
        return false;
    }
}

class LockIntro {
    constructor(skin) {
        this.skin = skin;
        this.state = 'idle';        // idle | waiting | running | done | aborted
        this.clock = new FrameClock(ms => this._onFrame(ms));
        this.sheet = null;
        this.ctx = null;
        this.ring = null;
        this.log = null;
        this.lastFrame = null;
        this._t0 = 0;
        this._waitSince = 0;
        this._watchdogId = 0;
        this._failed = false;
        this.stats = {frames: 0, abortReason: null, geometryWaitMs: null, resyncs: 0, maxResyncPx: 0, firstGeom: null};
        this._radius = undefined;
        this._markGeom = null;
    }

    get active() {
        return this.state === 'waiting' || this.state === 'running';
    }

    begin() {
        if (this.active)
            return false;
        const skin = this.skin;
        const d = skin.dialog;
        if (!motionAllowed() || skin.failed)
            return false;
        const ap = d._authPrompt;
        if (!ap)
            return false;
        fault('lock-intro-begin');
        this.state = 'waiting';
        this._radius = undefined;
        this.lastFrame = null;
        this._waitSince = wallMs();
        this.stats = {frames: 0, abortReason: null, geometryWaitMs: null, resyncs: 0, maxResyncPx: 0, firstGeom: null};
        // the card's own CSS glass is replaced by the field's until the end; avatar + name arrive with the bloom
        d._promptBox.add_style_class_name('vitre-intro');
        if (ap._userWell)
            ap._userWell.opacity = 0;
        skin.mark?.remove_all_transitions();
        skin.mark?.set({scale_x: 1, scale_y: 1, opacity: 255});
        this.clock.start();
        if (!this.clock.manual) {       // (a manual clock is the rig's: it paces itself)
            this._watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCHDOG_MS, () => {
                this._watchdogId = 0;
                this.abort('watchdog');
                return GLib.SOURCE_REMOVE;
            });
        }
        return true;
    }

    // The rectangles the intro aims at: where the card, the capsule and the mark WILL BE once the stock crossfade (300 ms,
    // _showPrompt) has finished, not where they are right now. The card and the capsule sit in the stack, which stock's
    // adjustment (and our _onProgress) is still moving when the first frame comes: read at that moment they were 110-125 px
    // too high, the bead landed and the glass card bloomed in the wrong place and the real card appeared lower at the
    // hand-over. The resting translation is known (the placement _onProgress applies at progress 1), so the rects are
    // shifted by the distance the stack still has to travel; _resync() corrects any remaining drift frame by frame.
    _geometry() {
        const skin = this.skin;
        const d = skin.dialog;
        const ap = d._authPrompt;
        if (!ap || !ap._entryArea)
            return null;
        const card = stageRect(d._promptBox);
        const capsule = stageRect(ap._entryArea);
        const mark = stageRect(skin.mark);
        if (!card || !capsule || !mark)
            return null;
        if (Math.abs(d._promptBox.scale_x - 1) > 0.002 || Math.abs(d._promptBox.translation_y) > 0.5)
            return null;
        const rest = skin.restingStackShift();
        const now = d._stack.translation_y;
        if (!Number.isFinite(rest) || !Number.isFinite(now))
            return null;
        const dy = rest - now;
        card.y += dy;
        capsule.y += dy;
        if (this._radius === undefined) {
            this._radius = 36;
            try {
                const r = d._promptBox.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
                if (Number.isFinite(r) && r > 0)
                    this._radius = r;
            } catch (_e) {
                // keep the default
            }
        }
        return {
            mark: {cx: mark.x + mark.w / 2, cy: mark.y + mark.h / 2, r: mark.w / 2 * 0.94},
            capsule, card: {...card, r: this._radius}, settleDy: dy,
        };
    }

    // Every frame: is the live (resting) geometry still the one the running context was built from? The mark is left
    // out on purpose (it springs +2.5 % at the snap, and the bead's start is long past). A move takes the new card /
    // capsule into the running context (timeline kept), the glass box and the ring with it.
    _resync() {
        const geom = this._geometry();
        if (!geom)
            return;
        geom.mark = this._markGeom;
        const next = lockIntroContext(geom, this.skin.motion);
        const c = this.ctx;
        if (!cardMoved(next.card, c.card, 0.5) && !cardMoved(next.landing, c.landing, 0.5))
            return;
        const px = Math.max(Math.abs(next.card.x - c.card.x), Math.abs(next.card.y - c.card.y),
            Math.abs(next.card.w - c.card.w), Math.abs(next.card.h - c.card.h),
            Math.abs(next.landing.x - c.landing.x), Math.abs(next.landing.y - c.landing.y));
        retargetContext(c, next);
        this.stats.resyncs++;
        this.stats.maxResyncPx = Math.max(this.stats.maxResyncPx, Math.round(px * 10) / 10);
        this._fitLayers(geom);
    }

    _onFrame(ms) {
        if (!this.active)
            return;
        try {
            this._frame(ms);
        } catch (e) {
            this._fail(e);
        }
    }

    _frame(ms) {
        const skin = this.skin;
        const d = skin.dialog;
        if (!d._authPrompt || d._activePage !== d._promptBox) {
            this.abort('prompt-gone');
            return;
        }
        if (this.state === 'waiting') {
            const geom = this._geometry();
            if (!geom) {
                if (wallMs() - this._waitSince > GEOMETRY_TIMEOUT_MS && !this.clock.manual)
                    this.abort('geometry-timeout');
                return;
            }
            this.stats.geometryWaitMs = Math.round(wallMs() - this._waitSince);
            this.stats.firstGeom = {card: {...geom.card}, capsule: {...geom.capsule}, settleDy: Math.round(geom.settleDy * 10) / 10};
            this._markGeom = geom.mark;
            this.ctx = lockIntroContext(geom, skin.motion);
            this._buildLayers(geom);
            this._t0 = ms;
            this.state = 'running';
        } else {
            this._resync();
        }
        fault('lock-intro-frame');
        const t = ms - this._t0;
        const fr = lockIntroFrame(this.ctx, t);
        this.lastFrame = fr;
        this.stats.frames++;
        this.sheet.setShapes(fr.shapes, fr.k);
        this.sheet.setOpacity(this.measure === 'coverage' ? 1 : fr.fieldAlpha);
        const ap = d._authPrompt;
        if (ap._userWell)
            ap._userWell.opacity = Math.round(255 * fr.contentAlpha);
        if (!fr.cardHidden)
            d._promptBox.remove_style_class_name('vitre-intro');
        this._applyRing(fr);
        skin.mark?.set({scale_x: fr.markScale, scale_y: fr.markScale});
        if (this.log)
            this.log.push({t: Math.round(t * 10) / 10, phase: fr.phase, k: fr.k, fieldAlpha: fr.fieldAlpha, content: fr.contentAlpha,
                cardHidden: fr.cardHidden, shapes: fr.shapes.map(s => [s.x, s.y, s.w, s.h, s.r].map(v => Math.round(v * 100) / 100))});
        if (fr.done)
            this.finish();
    }

    _boxFor(geom) {
        const markRect = {x: geom.mark.cx - geom.mark.r, y: geom.mark.cy - geom.mark.r, w: geom.mark.r * 2, h: geom.mark.r * 2};
        return boxAround([geom.card, markRect, geom.capsule], 36);
    }

    _buildLayers(geom) {
        const d = this.skin.dialog;
        this.sheet = this.skin.takeSheet(this._boxFor(geom));
        this.ring = new St.Widget({style_class: 'vitre-lock-ring', reactive: false, opacity: 0, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        Shell.util_set_hidden_from_pick(this.ring, true);
        d.insert_child_below(this.ring, this.skin.layer);
        this._placeRing(geom.capsule);
    }

    _placeRing(cap) {
        const [px, py] = this.skin.dialog.get_transformed_position();
        this.ring.set_position(cap.x - (px || 0), cap.y - (py || 0));
        this.ring.set_size(cap.w, cap.h);
    }

    // the geometry moved under the running intro: the glass box must still cover it, the ring follows the capsule
    _fitLayers(geom) {
        if (this.sheet && !this.sheet.dead) {
            const box = this._boxFor(geom);
            const b = this.sheet.box;
            if (box.x !== b.x || box.y !== b.y || box.w !== b.w || box.h !== b.h)
                this.sheet.setBox(box);
        }
        if (this.ring)
            this._placeRing(geom.capsule);
    }

    _applyRing(fr) {
        if (!this.ring)
            return;
        this.ring.set({opacity: Math.round(255 * clamp01(fr.ring.alpha)), scale_x: fr.ring.scale, scale_y: fr.ring.scale});
    }

    // everything back to the settled state: the CSS card, avatar and name fully visible
    _restore() {
        const d = this.skin.dialog;
        try {
            d._promptBox?.remove_style_class_name('vitre-intro');
            const uw = d._authPrompt?._userWell;
            if (uw)
                uw.opacity = 255;
            this.skin.mark?.set({scale_x: 1, scale_y: 1});
        } catch (_e) {
            // the dialog is going away
        }
        if (this.sheet) {
            this.skin.releaseSheet(this.sheet);
            this.sheet = null;
        }
        if (this.ring) {
            try {
                this.ring.destroy();
            } catch (_e) {
                // gone with the dialog
            }
            this.ring = null;
        }
        if (this._watchdogId) {
            GLib.Source.remove(this._watchdogId);
            this._watchdogId = 0;
        }
        this.clock.stop();
    }

    finish() {
        if (!this.active)
            return;
        this._restore();
        this.state = 'done';
    }

    abort(reason) {
        if (!this.active)
            return;
        this.stats.abortReason = reason;
        this._restore();
        this.state = 'aborted';
    }

    _fail(error) {
        if (!this._failed) {
            this._failed = true;
            console.error(`Vitre Session: lock intro failed, stock behaviour restored: ${error.message}\n${error.stack ?? ''}`);
        }
        this.skin.failed = true;
        this.abort('error');
    }

    destroy() {
        if (this.active)
            this.abort('destroy');
        this.clock.stop();
    }
}

export class LockSkin {
    constructor(dialog, style) {
        this.dialog = dialog;
        this.style = style;
        this.motion = style.motion;
        this.failed = false;
        this.scrim = null;
        this.layer = null;
        this.mark = null;
        this.intro = new LockIntro(this);
        this._saved = null;
        this._built = false;
        this._spare = null;
        this._prewarmId = 0;
    }

    // ---- the glass sheet pool: one spare, built shortly after the dialog (shader compiled, buffers allocated) ------
    _makeSheet(box) {
        const d = this.dialog;
        return new GlassSheet({
            parent: d, above: this.scrim, box, finish: LOCK_FINISH, blurRadius: 16,
            sources: [d._backgroundGroup, this.scrim], name: 'vitre-lock-glass',
        });
    }

    _prewarm() {
        if (this.failed || this._spare || !this._built || !this.scrim)
            return;
        this._spare = this._makeSheet({x: 0, y: 0, w: 8, h: 8});
        this._spare.warm();
    }

    takeSheet(box) {
        let sheet = this._spare;
        this._spare = null;
        if (!sheet || sheet.dead)
            sheet = this._makeSheet(box);
        sheet.use(box);
        return sheet;
    }

    releaseSheet(sheet) {
        if (sheet.dead)
            return;
        sheet.release();
        sheet.setOpacity(0);
        if (!this._spare && !this.failed) {
            sheet.park();
            this._spare = sheet;
        } else {
            sheet.destroy();
        }
    }

    build() {
        const d = this.dialog;
        this._saved = {
            px: d._promptBox.x_align, py: d._promptBox.y_align,
        };
        d.add_style_class_name('vitre-lock');
        fault('lock-build');
        // scrim over the wallpaper layers
        this.scrim = new St.Widget({style_class: 'vitre-lock-scrim', reactive: false});
        this.scrim.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));
        Shell.util_set_hidden_from_pick(this.scrim, true);
        d.insert_child_above(this.scrim, d._backgroundGroup);
        // the mark layer: above everything else, primary monitor only
        this.layer = new St.Widget({name: 'vitreLockLayer', reactive: false, layout_manager: new Clutter.BinLayout()});
        this.layer.add_constraint(new Layout.MonitorConstraint({primary: true}));
        Shell.util_set_hidden_from_pick(this.layer, true);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this.style.dir, 'assets', 'vitre-mark.svg']));
        this.mark = new St.Icon({
            style_class: 'vitre-lock-mark', gicon: new Gio.FileIcon({file}), icon_size: MARK_SIZE,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true,
            reactive: false, pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.mark.set_style(`margin-top: ${Math.round((Main.panel?.height || 32) + MARK_TOP_GAP)}px;`);
        this.layer.add_child(this.mark);
        d.add_child(this.layer);
        // clock page: the date above the time (stock order is time, date, hint)
        d._clock.add_style_class_name('vitre-clock');
        d._clock.set_child_at_index(d._clock._date, 0);
        // the unlock card is the prompt box itself: hug its content, centred (stock stretches it over the whole stack)
        d._promptBox.add_style_class_name('vitre-card');
        d._promptBox.x_align = Clutter.ActorAlign.CENTER;
        d._promptBox.y_align = Clutter.ActorAlign.START;
        // follow the clock <-> prompt transition (stock animates the same adjustment)
        d._adjustment.connectObject('notify::value', () => this._onProgress(), this);
        // notifications arriving or leaving move the box the card keeps clear of
        d._notificationsBox?.connectObject('notify::allocation', () => this._onProgress(), this);
        this._onProgress();
        // the mark arrives with the dialog
        if (motionAllowed()) {
            this.mark.set({opacity: 0, scale_x: 0.86, scale_y: 0.86});
            this.mark.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 520, delay: 160, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
        fault('lock-build-late');
        this._built = true;
        this._prewarmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            this._prewarmId = 0;
            try {
                this._prewarm();
            } catch (_e) {
                // not worth failing for: the intro builds its own sheet
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _stackShift(p) {
        const d = this.dialog;
        const mon = Main.layoutManager.primaryMonitor;
        const H = mon?.height ?? 1200;
        const box = d._stack.get_allocation_box();
        const y0 = box.y1;
        if (!Number.isFinite(y0))
            return 0;
        const cardH = d._promptBox.height > 0 ? d._promptBox.height : 340;
        let cardTop = Math.round(H / 2 - 24 - cardH / 2);
        // Lock-screen notifications sit under the stack, and stock pushes the stack up to clear them; centring the card
        // regardless put its bottom over the first rows (8 sources at 2880x1800 / 1.5). Keep the card above the box.
        const nb = d._notificationsBox;
        if (nb?.visible) {
            const nbox = nb.get_allocation_box();
            if (Number.isFinite(nbox.y1) && nbox.get_height() > 0)
                cardTop = Math.min(cardTop, Math.floor(nbox.y1 - NOTIF_GAP - cardH));
        }
        const promptShift = cardTop - y0;
        // The clock page rests at the stack's own (stock) placement: translation 0. (It used to be pulled to DATE_TOP of the
        // screen from the first progress update on, which jumped the opaque clock 175 px up the moment a key opened the
        // prompt, and made the page rest in two different places: stock after a lock, higher after Escape.)
        return motionAllowed() ? lerp(0, promptShift, p) : (p < 0.5 ? 0 : promptShift);
    }

    // where the stack comes to rest when the stock crossfade ends (the placement _onProgress applies at progress 1)
    restingStackShift() {
        if (!Number.isFinite(this.dialog._stack.get_allocation_box().y1))
            return NaN;                     // not allocated yet: no geometry, the intro keeps waiting
        return this._stackShift(1);
    }

    // runs after stock's own handler of the same signal: calmer transforms, the stack placement, the scrim
    _onProgress() {
        if (this.failed)
            return;
        try {
            const d = this.dialog;
            if (this._built)
                fault('lock-progress');
            const p = clamp01(d._adjustment.value);
            d._stack.translation_y = this._stackShift(p);
            if (motionAllowed()) {
                d._promptBox.set({scale_x: 1, scale_y: 1, translation_y: 0});
                d._clock.set({scale_x: 1 - 0.06 * p, scale_y: 1 - 0.06 * p, translation_y: -22 * p});
            }
            this.scrim?.set_opacity(Math.round(190 + 65 * p));
            if (p < 0.001 && this.intro.active)
                this.intro.abort('back-to-clock');
        } catch (e) {
            this.failed = true;
            console.error(`Vitre Session: lock layout hook failed, stock layout restored: ${e.message}`);
            this.revert();
        }
    }

    // the prompt opened (stock _showPrompt returned, page is now the prompt)
    onPromptShown() {
        if (this.failed || !this._built)
            return;
        try {
            const d = this.dialog;
            this._onProgress();
            d._promptBox.set({scale_x: 1, scale_y: 1, translation_y: 0});
            this.intro.begin();
        } catch (e) {
            this.failed = true;
            console.error(`Vitre Session: lock intro could not start, stock behaviour restored: ${e.message}`);
            this.intro.abort('error');
        }
    }

    // put every transform and alignment back to what stock expects; the added actors stay (harmless) or go
    revert() {
        const d = this.dialog;
        try {
            this.intro.abort('revert');
            d._adjustment.disconnectObject(this);
            d._notificationsBox?.disconnectObject(this);
            d._stack.translation_y = 0;
            if (this._saved) {
                d._promptBox.x_align = this._saved.px;
                d._promptBox.y_align = this._saved.py;
            }
            d._promptBox.remove_style_class_name('vitre-intro');
            d._promptBox.remove_style_class_name('vitre-card');
            d.remove_style_class_name('vitre-lock');
            d._clock.remove_style_class_name('vitre-clock');
            if (d._clock._date.get_parent() === d._clock)
                d._clock.set_child_at_index(d._clock._date, 1);
            // what we added stays out of sight (it is destroyed with the dialog or by destroy())
            this.scrim?.hide();
            this.layer?.hide();
            d._setTransitionProgress(d._adjustment.value);
        } catch (_e) {
            // the dialog is already gone
        }
    }

    destroy({dialogGone = false} = {}) {
        if (this._prewarmId) {
            GLib.Source.remove(this._prewarmId);
            this._prewarmId = 0;
        }
        this.intro.destroy();
        this._spare?.destroy();
        this._spare = null;
        if (!dialogGone) {
            this.revert();
            for (const actor of [this.scrim, this.layer]) {
                try {
                    actor?.destroy();
                } catch (_e) {
                    // already gone
                }
            }
        }
        this.scrim = this.layer = this.mark = null;
    }
}

export class LockStyle {
    constructor({dir, motion, log = null}) {
        this.dir = dir;
        this.motion = motion;
        this._log = log;
        this._im = null;
        this._skins = new Map();
        this.enabled = false;
        this._originals = null;
    }

    enable() {
        fault('lock-enable');
        this._im = new InjectionManager();
        this.enabled = true;
        this._originals = {
            ensure: ScreenShield.prototype._ensureUnlockDialog,
            showPrompt: UnlockDialog.prototype._showPrompt,
            ensureOwn: Object.prototype.hasOwnProperty.call(ScreenShield.prototype, '_ensureUnlockDialog'),
            showPromptOwn: Object.prototype.hasOwnProperty.call(UnlockDialog.prototype, '_showPrompt'),
        };
        const style = this;
        this._im.overrideMethod(ScreenShield.prototype, '_ensureUnlockDialog', original => function (...args) {
            const had = Boolean(this._dialog);
            const result = original.apply(this, args);      // stock first, always
            if (!had && this._dialog)
                style.decorate(this._dialog);
            return result;
        });
        this._im.overrideMethod(UnlockDialog.prototype, '_showPrompt', original => function (...args) {
            const wasClock = this._activePage !== this._promptBox;
            const result = original.apply(this, args);
            if (wasClock && this._activePage === this._promptBox)
                style._skins.get(this)?.onPromptShown();
            return result;
        });
        // a dialog that already exists (the extension was enabled while locked)
        const live = Main.screenShield?._dialog;
        if (live)
            this.decorate(live);
    }

    decorate(dialog) {
        if (!this.enabled || this._skins.has(dialog))
            return null;
        if (markerPresent('stock-lock'))
            return null;                    // kill switch: ~/.config/vitre-session/stock-lock
        let skin = null;
        try {
            skin = new LockSkin(dialog, this);
            this._skins.set(dialog, skin);
            skin.build();
            dialog.connect('destroy', () => {
                const s = this._skins.get(dialog);
                this._skins.delete(dialog);
                s?.destroy({dialogGone: true});
            });
            return skin;
        } catch (e) {
            console.error(`Vitre Session: lock screen skin failed, stock dialog kept: ${e.message}\n${e.stack ?? ''}`);
            this._skins.delete(dialog);
            try {
                skin?.destroy();
            } catch (_e) {
                // nothing more to do
            }
            return null;
        }
    }

    skinFor(dialog) {
        return this._skins.get(dialog) ?? null;
    }

    disable() {
        this.enabled = false;
        for (const skin of this._skins.values()) {
            try {
                skin.destroy();
            } catch (_e) {
                // keep restoring the rest
            }
        }
        this._skins.clear();
        this._im?.clear();
        // InjectionManager puts an own property back even when the method was inherited: not the case here, but check
        const o = this._originals;
        if (o) {
            if (!o.ensureOwn)
                delete ScreenShield.prototype._ensureUnlockDialog;
            if (!o.showPromptOwn)
                delete UnlockDialog.prototype._showPrompt;
        }
        this._im = null;
    }

    // restored exactly? (rig)
    restored() {
        const o = this._originals;
        return Boolean(o) && ScreenShield.prototype._ensureUnlockDialog === o.ensure && UnlockDialog.prototype._showPrompt === o.showPrompt;
    }
}

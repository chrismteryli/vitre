// the reference design-style notification banners for GNOME Shell 51.
//
// GNOME keeps doing everything that decides WHEN a banner shows (queue,
// urgency, timeouts, hover-to-expand, actions, the notification list). This
// extension only changes WHERE and HOW it moves:
//   - top-right under the menu bar instead of top-centre
//   - the banner's glass pours out of the clock's pill in the top bar and drains
//     back into it, instead of dropping from the top with a scale bounce
//   - a two-finger swipe to the right dismisses the banner (it stays in the
//     notification list); a short swipe springs back
// Motion (Motion Lab 2, notifications; liquid.js): the banner follows the lab's glass Shape (liquidShape.js: six edge
// springs, the bottom edge leading out of the pill on 'pour', the top trailing on pour x viscosity); its content fades in on
// the fade role once the glass is 55 % of the way. A new message on a banner that is up jostles the glass (bead kicks on the
// edges) and swaps the content on a fade. The auto-hide drains the glass back into the pill on the pour exit spring (the top
// edge leads, never bouncing) while the content goes on a short {r: 0.1, z: 1} fade. A swipe moves the banner with the
// finger (a pull to the left meets a rubber band); let go past 90 px or faster than 500 px/s it flies off on 'track' with
// the finger's speed, else it goes back on 'track' with the release speed. Everything retargets with its speed: a banner
// updated while it drains pours back out from where it is. Reduced motion: no travel, a 160 ms cross-fade. Animations off: cut.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {Spring, Fade, role, feel, rubber, releaseVelocity, REDUCED, EPS_PX, EPS_OPACITY} from './liquid.js';
import {Ticker, motionMode} from './liquidClock.js';
import {Shape, geomOf} from './liquidShape.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const {State, Urgency} = MessageTray;

const DWELL_MS = 5000;             // the reference design banner dwell (~5 s, the reference-fixed)
const SWIPE_FLING_PX = 90;         // let go this far to the right and the banner flies off (lab 2) ...
const SWIPE_FLING_SPEED = 500;     // ... or this fast (px/s, the release velocity over the last 80 ms)
const SWIPE_FLING_MIN_SPEED = 900; // a fling leaves at least this fast (px/s)
const SWIPE_PX_PER_UNIT = 12;      // touchpad smooth-scroll unit -> px
const SWIPE_IDLE_MS = 140;         // end of gesture if the device sends no finish flag
const SWIPE_RUBBER_PX = 24;        // a pull to the left meets a rubber band that never goes further than this (lab 2)
const PILL_H = 21;                 // the clock's highlight pill in the top bar (as vitre-notices' pour)
const PILL_PAD = 6;
const CONTENT_FROM = 0.55;         // the content fades in once the glass is this far along
const CONTENT_OUT = {r: 0.1, z: 1};          // the content leaving (lab 2)
const JOSTLE = {bottom: 160, width: 60};     // a new message's kicks on the glass, px/s x volume (lab 2)

const clamp01 = v => Math.min(1, Math.max(0, v));

// ---- reduced motion and animations off: the v3 cross-fade in place -------------------------------------------------------
// The banner bin's opacity on a Fade (translation_x for the swipe's return), one Ticker. move() retargets (keeping speed)
// and calls onStopped(finished) when both rest, or (false) when a later move or stop() takes over, as ease()'s onStopped.
// Vitre (B14): Clutter.Transition.set_progress_func is ignored in this shell, so nothing here is a Clutter transition.
function motionOf(actor) {
    if (actor._vitreBannerMotion)
        return actor._vitreBannerMotion;
    const m = {
        x: new Spring(actor.translation_x, role('pour'), EPS_PX),
        op: new Fade(actor.opacity / 255, role('fade'), EPS_OPACITY),
        done: null,
        ticker: null,
    };
    m.ticker = new Ticker(dt => {
        if (actor.is_finalized?.())
            return false;
        actor.translation_x = m.x.step(dt);
        actor.opacity = Math.round(255 * m.op.step(dt));
        if (!m.x.rest || !m.op.rest)
            return true;
        const done = m.done;
        m.done = null;
        done?.(true);
        return false;
    }, {actor});
    actor._vitreBannerMotion = m;
    return m;
}

function stopSpring(actor) {
    const m = actor?._vitreBannerMotion;
    if (!m)
        return;
    m.ticker.stop();
    const done = m.done;
    m.done = null;
    done?.(false);
}

// to: {x, opacity (0..1)}; p: the translation's spring; v0: px per second to start with (a swipe's release), else kept
function move(actor, to, {p, fade = role('fade'), v0 = null, onStopped = null}) {
    const m = motionOf(actor);
    const prev = m.done;
    m.done = null;
    prev?.(false);
    actor.remove_transition('translation-x');
    actor.remove_transition('opacity');
    const mode = motionMode();
    if (mode === 'off') {
        m.ticker.stop();
        m.x.snap(to.x);
        m.op.snap(to.opacity);
        actor.translation_x = to.x;
        actor.opacity = Math.round(255 * to.opacity);
        onStopped?.(true);
        return;
    }
    m.x.snap(actor.translation_x);
    if (!m.ticker.running) {
        m.op.snap(actor.opacity / 255);
        m.x.v = 0;
    }
    if (v0 !== null)
        m.x.v = v0;
    if (mode === 'reduced') {
        // no travel: the banner is where it goes at once and cross-fades
        m.x.snap(to.x);
        actor.translation_x = to.x;
        m.op.set(to.opacity, REDUCED);
    } else {
        m.x.set(to.x, p);
        m.op.set(to.opacity, fade);
    }
    m.done = onStopped;
    m.ticker.start();
}

export default class VitreBanners extends Extension {
    enable() {
        const tray = Main.messageTray;
        this._tray = tray;
        this._bannerEpoch = (this._bannerEpoch ?? 0) + 1;
        this._bin = tray._bannerBin;
        this._origShow = tray._updateShowingNotification;
        this._origHide = tray._hideNotification;
        this._origAlign = tray.bannerAlignment;
        this._pm = null;
        const ext = this;

        tray._updateShowingNotification = function () {
            ext._show(this);
        };
        tray._hideNotification = function (animate) {
            ext._hide(this, animate);
        };

        this._align();
        // panel.js resets the alignment from the clock's position on every
        // session-mode change (e.g. unlock); put it back.
        Main.sessionMode.connectObject('updated', () => this._align(), this);

        this._swipe = {active: false, returning: false, x: 0, raw: 0, samples: [], idleId: 0, serial: 0,
            banner: null, notification: null};
        this._bin.connectObject('scroll-event', (_a, event) => this._onScroll(event), this);
    }

    disable() {
        const tray = this._tray;
        const bin = this._bin;
        const resumeDwell = this._swipe.active || this._swipe.returning ||
            tray._notificationState === State.SHOWING;
        this._cancelSwipe();
        this._bannerEpoch++;
        tray._updateShowingNotification = this._origShow;
        tray._hideNotification = this._origHide;
        tray.bannerAlignment = this._origAlign;
        Main.sessionMode.disconnectObject(this);
        bin.disconnectObject(this);
        stopSpring(bin);
        this._pourStop();
        bin.remove_all_transitions();
        bin.translation_x = 0;
        bin.translation_y = 0;
        bin.set_scale(1, 1);
        bin.remove_style_class_name('vitre-banners');

        // Finish our in-flight state before returning ownership to the native tray.
        // Native completion restores its dwell policy without replaying the sound.
        if (tray._banner && tray._notificationState === State.HIDING) {
            tray._notificationState = State.HIDDEN;
            tray._hideNotificationCompleted();
            tray._updateState();
        } else if (tray._banner && resumeDwell) {
            bin.opacity = 255;
            bin.y = 0;
            bin.set_scale(1, 1);
            tray._notificationState = State.SHOWN;
            tray._showNotificationCompleted();
            tray._updateState();
        }
        this._pm = null;
        this._tray = null;
        this._bin = null;
    }

    _cancelSwipe() {
        const s = this._swipe;
        if (!s) return;
        s.serial++;
        if (s.idleId) GLib.source_remove(s.idleId);
        Object.assign(s, {active: false, returning: false, x: 0, raw: 0, samples: [], idleId: 0,
            banner: null, notification: null});
    }

    _matchesBanner(tray, banner, notification) {
        return this._tray === tray && !!banner && tray._banner === banner &&
            tray._notification === notification;
    }

    _align() {
        this._tray.bannerAlignment = Clutter.ActorAlign.END;
        this._bin.add_style_class_name('vitre-banners');
    }

    // Fully off the right edge. A fresh banner has no allocation yet, so use
    // its natural width rather than .width.
    _slideDistance() {
        const banner = this._tray._banner;
        const width = banner ? Math.max(banner.width, banner.get_preferred_width(-1)[1]) : 400;
        return width + 40;
    }

    // ---- the pour (full motion) ---------------------------------------------------------------------------------------

    _pourState() {
        if (this._pm)
            return this._pm;
        const pm = {
            sh: new Shape(EPS_PX),
            cop: new Fade(0, role('fade'), EPS_OPACITY),       // the content
            swap: new Fade(1, role('fade'), EPS_OPACITY),      // a new message's content swap
            dx: new Spring(0, role('track'), EPS_PX),          // the swipe and the fling
            mode: 'idle',           // idle | wait (for the banner's allocation) | in | shown | out | fling
            R: null,                // the banner's rest rectangle (stage px)
            src: null,              // the pill's shape
            waitFrames: 0,
            flingTo: 0,
            done: null,             // (finished) when the pour in, the drain or the fling ends
            dxDone: null,           // a swipe's return has come to rest
            ticker: null,
        };
        pm.ticker = new Ticker(dt => this._pourStep(dt), {actor: this._bin});
        this._pm = pm;
        return pm;
    }

    _setDone(fn) {
        const pm = this._pm;
        const prev = pm.done;
        pm.done = fn;
        prev?.(false);
    }

    _pourStop() {
        const pm = this._pm;
        if (!pm)
            return;
        pm.ticker.stop();
        pm.mode = 'idle';
        pm.dxDone = null;
        const done = pm.done;
        pm.done = null;
        done?.(false);
        const content = this._content();
        if (content)
            content.opacity = 255;
    }

    _content() {
        const banner = this._tray?._banner;
        try {
            return banner?.get_child?.() ?? null;
        } catch (_e) {
            return null;
        }
    }

    // the banner's rest rectangle: its allocation (translation and scale are ours and do not move it)
    _restRect() {
        const bin = this._bin;
        if (!bin?.has_allocation() || !bin.get_parent())
            return null;
        const box = bin.get_allocation_box();
        const [px, py] = bin.get_parent().get_transformed_position();
        const w = box.x2 - box.x1, h = box.y2 - box.y1;
        if (!(w > 1 && h > 1) || !Number.isFinite(px) || !Number.isFinite(py))
            return null;
        return {x: px + box.x1, y: py + box.y1, w, h};
    }

    // the pill the glass pours out of: the clock in the top bar (as the Notification Center's pour); with the bar hidden,
    // a pill just above the banner
    _sourceGeom(R) {
        let P = null;
        const clock = Main.panel?.statusArea?.dateMenu?._clockDisplay;
        if (clock?.mapped) {
            const [x, y] = clock.get_transformed_position();
            const [w, h] = clock.get_transformed_size();
            if ([x, y, w, h].every(Number.isFinite) && w > 0)
                P = {x: x - PILL_PAD, y: y + (h - PILL_H) / 2, w: w + 2 * PILL_PAD, h: PILL_H};
        }
        P ??= {x: R.x + R.w / 2 - 50, y: R.y - PILL_H, w: 100, h: PILL_H};
        const cx = P.x + P.w / 2;
        return {tY: P.y + P.h - 4, bY: P.y + P.h, tCx: cx, bCx: cx, tHw: P.w * 0.3, bHw: P.w * 0.18};
    }

    _pourStep(dt) {
        const pm = this._pm;
        const bin = this._bin;
        if (!pm || !bin || !this._tray)
            return false;
        const R = this._restRect();
        if (pm.mode === 'wait') {
            if (!R) {
                // a banner that never gets an allocation is shown where it is, unmoved
                if (++pm.waitFrames < 60)
                    return true;
                pm.mode = 'idle';
                bin.opacity = 255;
                this._identity();
                const done = pm.done;
                pm.done = null;
                done?.(true);
                return false;
            }
            pm.R = R;
            pm.src = this._sourceGeom(R);
            pm.sh.snapTo(pm.src);
            pm.sh.go(geomOf(R), role('pour'), role('pour', {trail: true}), true);
            pm.mode = 'in';
            bin.opacity = 255;
        } else if (R && pm.R && pm.mode === 'in' && moved(R, pm.R)) {
            // the banner's size changed while it pours (a late relayout): the springs take the new target with their speed
            pm.R = R;
            pm.sh.retarget(geomOf(R));
        }
        pm.sh.step(dt);
        pm.cop.step(dt);
        pm.swap.step(dt);
        pm.dx.step(dt);
        if (pm.mode === 'in' && pm.sh.progress() > CONTENT_FROM)
            pm.cop.set(1, role('fade'));
        const drained = pm.mode === 'out' && (pm.sh.rest || pm.sh.progress() > 0.995);
        const flown = pm.mode === 'fling' && (pm.dx.rest || pm.dx.x >= pm.flingTo - 1);
        if (drained || flown) {
            pm.mode = 'idle';
            bin.opacity = 0;
            this._identity();
            pm.dx.snap(0);
            const done = pm.done;
            pm.done = null;
            done?.(true);
            return false;
        }
        this._pourApply();
        if (pm.dxDone && pm.dx.rest) {
            const d = pm.dxDone;
            pm.dxDone = null;
            d();
        }
        const moving = !pm.sh.rest || !pm.cop.rest || !pm.swap.rest || !pm.dx.rest || this._swipe.active;
        if (moving)
            return true;
        if (pm.mode === 'in' || pm.mode === 'shown') {
            pm.mode = 'shown';
            this._identity();
            const done = pm.done;
            pm.done = null;
            done?.(true);
        }
        return false;
    }

    // the banner on the shape's box: pivot at its top-left, scaled and moved so that its rest rectangle covers the box
    _pourApply() {
        const pm = this._pm;
        const bin = this._bin;
        const R = pm.R;
        if (!R)
            return;
        const b = pm.sh.box();
        bin.set_pivot_point(0, 0);
        bin.translation_x = b.x - R.x + pm.dx.x;
        bin.translation_y = b.y - R.y;
        bin.scale_x = Math.max(0.01, b.w / R.w);
        bin.scale_y = Math.max(0.01, b.h / R.h);
        const content = this._content();
        if (content)
            content.opacity = Math.round(255 * clamp01(pm.cop.x) * clamp01(pm.swap.x));
    }

    // at rest: no transform but the swipe's offset (a later expand or a resize of the banner then shows as GNOME lays it out)
    _identity() {
        const bin = this._bin;
        bin.translation_x = this._pm?.dx.x ?? 0;
        bin.translation_y = 0;
        bin.set_scale(1, 1);
        const content = this._content();
        if (content)
            content.opacity = 255;
    }

    // Same bookkeeping as MessageTray._updateShowingNotification (GNOME 51),
    // different motion.
    _show(tray) {
        const s = this._swipe;
        const swiping = s.active && this._matchesBanner(tray, s.banner, s.notification);
        if (!swiping)
            this._cancelSwipe();
        const epoch = ++this._bannerEpoch;
        const banner = tray._banner;
        const notification = tray._notification;
        tray._notification.acknowledged = true;
        tray._notification.playSound();
        if (tray._notification.urgency === Urgency.CRITICAL ||
            tray._notification.source.policy.forceExpanded)
            tray._expandBanner(true);

        tray._notificationState = State.SHOWING;
        const bin = this._bin;
        const shown = isFinished => {
            if (epoch !== this._bannerEpoch || !this._matchesBanner(tray, banner, notification)) return;
            if (!isFinished && tray._notificationState !== State.SHOWING)
                return;
            tray._notificationState = State.SHOWN;
            // the reference design banners stay about 5 s (GNOME's own is 4 s).
            if (tray._notification?.urgency !== Urgency.CRITICAL && !this._swipe.active)
                tray._updateNotificationTimeout(DWELL_MS);
            tray._updateState();
        };

        if (motionMode() === 'full') {
            stopSpring(bin);
            bin.remove_all_transitions();
            bin.y = 0;
            const pm = this._pourState();
            const vol = feel().volume;
            if (pm.mode === 'in' || pm.mode === 'shown') {
                // a new message on a banner that is up: the glass jostles and the content swaps on a fade
                pm.swap.snap(0).set(1, role('fade'));
                pm.sh.bY.kick(JOSTLE.bottom * vol);
                pm.sh.tHw.kick(JOSTLE.width * vol);
                pm.sh.bHw.kick(JOSTLE.width * vol);
                if (pm.mode === 'shown')
                    pm.mode = 'in';
            } else if ((pm.mode === 'out' || pm.mode === 'fling') && pm.R) {
                // updated while it leaves: it pours back out from where it is, with its speed
                pm.mode = 'in';
                pm.sh.go(geomOf(pm.R), role('pour'), role('pour', {trail: true}), true);
                pm.dx.set(0, role('track'));
            } else {
                pm.mode = 'wait';
                pm.waitFrames = 0;
                pm.R = null;
                pm.cop.snap(0);
                pm.swap.snap(1);
                pm.dx.snap(0);
                bin.opacity = 0;
                bin.translation_x = 0;
                bin.translation_y = 0;
                bin.set_scale(1, 1);
                const content = this._content();
                if (content)
                    content.opacity = 0;
            }
            this._setDone(shown);
            pm.ticker.start();
            return;
        }

        this._pourStop();
        stopSpring(bin);
        bin.remove_all_transitions();
        bin.y = 0;
        bin.translation_y = 0;
        bin.set_scale(1, 1);
        move(bin, {x: 0, opacity: 1}, {p: role('pour'), onStopped: shown});
    }

    // Same bookkeeping as MessageTray._hideNotification (GNOME 51),
    // different motion.
    _hide(tray, animate) {
        this._cancelSwipe();
        const epoch = ++this._bannerEpoch;
        const banner = tray._banner;
        const notification = tray._notification;
        tray._notificationFocusGrabber.ungrabFocus();
        tray._banner.disconnectObject(tray);
        tray._resetNotificationLeftTimeout();

        const bin = this._bin;
        // a swipe that dismissed the banner hands its speed over (px/s); otherwise the slide keeps its own
        const swipeV = this._swipeRelease ?? null;
        this._swipeRelease = null;
        stopSpring(bin);
        bin.remove_all_transitions();
        tray._notificationState = State.HIDING;
        const finish = () => {
            if (epoch !== this._bannerEpoch || !this._matchesBanner(tray, banner, notification)) return;
            tray._notificationState = State.HIDDEN;
            tray._hideNotificationCompleted();
            bin.translation_x = 0;
            bin.translation_y = 0;
            bin.set_scale(1, 1);
            if (this._pm)
                this._pm.dx.snap(0);
            tray._updateState();
        };
        const pm = this._pm;
        if (!animate || (pm && pm.mode !== 'idle' && motionMode() !== 'full')) {
            this._pourStop();
            motionOf(bin).ticker.stop();
            bin.opacity = 0;
            finish();
            return;
        }
        if (pm && pm.mode !== 'idle') {
            if (pm.mode === 'fling') {
                // the fling is under way: it ends the banner when it is off the screen
                this._setDone(() => finish());
                return;
            }
            if (pm.mode === 'wait' || !pm.R) {
                this._pourStop();
                bin.opacity = 0;
                finish();
                return;
            }
            // the auto-hide: the glass drains back into the pill (the top edge leads), the content goes first
            pm.mode = 'out';
            pm.cop.set(0, CONTENT_OUT);
            const pe = role('pour', {exit: true});
            pm.sh.go(pm.src ?? this._sourceGeom(pm.R), pe, {r: pe.r * feel().visc, z: pe.z}, false, true);
            this._setDone(() => finish());
            pm.ticker.start();
            return;
        }
        move(bin, {x: this._slideDistance(), opacity: 0}, {
            p: swipeV !== null ? role('track') : role('pour', {exit: true}),
            fade: role('fade', {exit: true}),
            v0: swipeV,
            onStopped: () => finish(),
        });
    }

    // Two-finger swipe right on the banner dismisses it, like a reference trackpad.
    _onScroll(event) {
        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;
        const tray = this._tray;
        if (!tray || !tray._banner || !tray._notification ||
            ![State.SHOWING, State.SHOWN].includes(tray._notificationState))
            return Clutter.EVENT_PROPAGATE;

        const [dx, dy] = event.get_scroll_delta();
        const s = this._swipe;
        const pm = motionMode() === 'full' ? this._pm : null;
        if (s.active && !this._matchesBanner(tray, s.banner, s.notification)) this._cancelSwipe();
        if (!s.active) {
            if (Math.abs(dx) <= Math.abs(dy) || dx === 0)
                return Clutter.EVENT_PROPAGATE;   // vertical scrolling: leave it to the banner
            this._cancelSwipe();
            s.active = true;
            s.banner = tray._banner;
            s.notification = tray._notification;
            s.x = pm ? pm.dx.x : this._bin.translation_x;
            s.raw = s.x;
            s.samples = [];
            if (pm) {
                pm.dxDone = null;
                pm.dx.snap(s.x);
            } else {
                stopSpring(this._bin);
                this._bin.remove_all_transitions();
                this._bin.opacity = 255;
            }
            // Hold the auto-hide while the finger is on the banner.
            tray._updateNotificationTimeout(0);
        }

        const now = GLib.get_monotonic_time() / 1e6;
        const step = dx * SWIPE_PX_PER_UNIT;
        // Rightward follows the finger; leftward meets a rubber band (liquid.js rubber: it never stops, never goes far).
        s.raw += step;
        s.x = s.raw > 0 ? s.raw : rubber(s.raw, SWIPE_RUBBER_PX);
        s.samples.push({t: now, p: s.x});
        if (s.samples.length > 32)
            s.samples.shift();
        if (pm) {
            pm.dx.snap(s.x);
            this._pourApply();
            pm.ticker.start();
        } else {
            this._bin.translation_x = s.x;
            this._bin.opacity = Math.round(255 * Math.max(0.25, 1 - Math.max(0, s.x) / this._slideDistance()));
        }

        if (s.idleId)
            GLib.source_remove(s.idleId);
        const serial = s.serial;
        if (event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE) {
            s.idleId = 0;
            this._endSwipe(serial);
        } else {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SWIPE_IDLE_MS, () => {
                if (s.serial !== serial || s.idleId !== id) return GLib.SOURCE_REMOVE;
                s.idleId = 0;
                this._endSwipe(serial);
                return GLib.SOURCE_REMOVE;
            });
            s.idleId = id;
        }
        return Clutter.EVENT_STOP;
    }

    _endSwipe(serial) {
        const s = this._swipe;
        if (!s.active || s.serial !== serial) return;
        const tray = this._tray;
        const banner = s.banner;
        const notification = s.notification;
        if (!this._matchesBanner(tray, banner, notification) ||
            ![State.SHOWING, State.SHOWN].includes(tray._notificationState)) {
            this._cancelSwipe();
            return;
        }
        s.active = false;
        // the release velocity: least squares over the last 80 ms of the finger (liquid.js); an idle end (no finish flag)
        // reads the samples as they were
        const v = releaseVelocity(s.samples);
        const dismiss = s.x > SWIPE_FLING_PX || v > SWIPE_FLING_SPEED;
        const resume = () => {
            if (s.serial !== serial || !this._matchesBanner(tray, banner, notification)) return;
            s.returning = false;
            if (tray._notificationState === State.SHOWN &&
                tray._notification?.urgency !== Urgency.CRITICAL)
                tray._updateNotificationTimeout(2000);
        };
        const pm = motionMode() === 'full' ? this._pm : null;
        if (pm) {
            if (dismiss && tray._banner) {
                // flung: it keeps the finger's speed off the screen; the glass goes with it, the content fades
                pm.mode = 'fling';
                pm.flingTo = this._slideDistance();
                pm.dx.set(pm.flingTo, role('track'));
                pm.dx.v = Math.max(v, SWIPE_FLING_MIN_SPEED);
                pm.cop.set(0, CONTENT_OUT);
                pm.ticker.start();
                tray._expireNotification();
                return;
            }
            // a short swipe goes back on the track spring with the release velocity
            s.returning = true;
            pm.dx.set(0, role('track'));
            pm.dx.v = v;
            pm.dxDone = resume;
            pm.ticker.start();
            return;
        }
        if (dismiss && tray._banner) {
            // GNOME then calls our _hide, which slides on from here, at the finger's speed.
            this._swipeRelease = Math.max(0, v);
            tray._expireNotification();
            return;
        }
        s.returning = true;
        // a short swipe springs back on the track role, from the finger's speed
        move(this._bin, {x: 0, opacity: 1}, {p: role('track'), v0: v, onStopped: resume});
    }
}

// did a rectangle move or change size by more than half a pixel
function moved(a, b) {
    return Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 || Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5;
}

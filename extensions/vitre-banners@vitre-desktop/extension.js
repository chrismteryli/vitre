// the reference design-style notification banners for GNOME Shell 51.
//
// GNOME keeps doing everything that decides WHEN a banner shows (queue,
// urgency, timeouts, hover-to-expand, actions, the notification list). This
// extension only changes WHERE and HOW it moves:
//   - top-right under the menu bar instead of top-centre
//   - slides in from the right edge on a spring instead of dropping from the
//     top with a scale bounce; slides back out to the right
//   - a two-finger swipe to the right dismisses the banner (it stays in the
//     notification list); a short swipe springs back
// Motion constants are estimates: the reference publishes none.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const {State, Urgency} = MessageTray;

const SLIDE_IN_RESPONSE = 420;     // spring, no bounce
const DWELL_MS = 5000;             // the reference design banner dwell (~5 s, the reference-fixed)
const FADE_IN_MS = 140;
const SLIDE_OUT_MS = 260;
const SWIPE_DISMISS_FRACTION = 0.3;
const SWIPE_FLICK_SPEED = 1.2;     // px per ms that dismisses regardless of distance
const SWIPE_PX_PER_UNIT = 12;      // touchpad smooth-scroll unit -> px
const SWIPE_IDLE_MS = 140;         // end of gesture if the device sends no finish flag

function springDisplacement(t, response) {
    const omega0 = 2 * Math.PI / response;
    return Math.exp(-omega0 * t) * (1 + omega0 * t);
}

// Critically damped spring, normalised to land exactly at the end.
// Vitre (B14): Clutter.Transition.set_progress_func is called but its return value is ignored in this shell, so a
// transition with one never moves: the banner used to sit 426 px past the right edge of the screen for ever (no banner
// was ever seen). The spring is driven by a clock actor instead, as Stage's interrupted flights are.
function stopSpring(actor) {
    const clock = actor?._vitreSpringClock;
    if (clock) {
        actor._vitreSpringClock = null;
        clock.remove_all_transitions();
        clock.destroy();
    }
}

function springTo(actor, props, response, onStopped) {
    const from = {};
    for (const key of Object.keys(props))
        from[key] = actor[key];
    stopSpring(actor);
    const end = 1 - springDisplacement(response / 1000, response / 1000);
    const clock = new Clutter.Actor({x: 0, width: 1, height: 1, opacity: 0});
    actor._vitreSpringClock?.destroy();
    actor._vitreSpringClock = clock;
    actor.add_child(clock);
    const step = u => {
        if (actor.is_finalized?.() || actor._vitreSpringClock !== clock)
            return;
        const s = u >= 1 ? 1 : (1 - springDisplacement(u * response / 1000, response / 1000)) / end;
        for (const key of Object.keys(props))
            actor[key] = from[key] + (props[key] - from[key]) * s;
    };
    clock.connect('notify::x', () => step(clock.x));
    clock.ease({x: 1, duration: response, mode: Clutter.AnimationMode.LINEAR, onStopped: finished => {
        step(1);
        if (actor._vitreSpringClock === clock) {
            actor._vitreSpringClock = null;
            clock.destroy();
        }
        onStopped?.(finished);
    }});
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

        this._swipe = {active: false, returning: false, x: 0, lastTime: 0, lastX: 0,
            speed: 0, idleId: 0, serial: 0, banner: null, notification: null};
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
        bin.remove_all_transitions();
        bin.translation_x = 0;
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
        this._tray = null;
        this._bin = null;
    }

    _cancelSwipe() {
        const s = this._swipe;
        if (!s) return;
        s.serial++;
        if (s.idleId) GLib.source_remove(s.idleId);
        Object.assign(s, {active: false, returning: false, x: 0, lastTime: 0,
            lastX: 0, speed: 0, idleId: 0, banner: null, notification: null});
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

    // Same bookkeeping as MessageTray._updateShowingNotification (GNOME 51),
    // different motion.
    _show(tray) {
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
        const updating = bin.opacity > 0 && bin.translation_x === 0 && bin.y === 0;
        stopSpring(bin);
        bin.remove_all_transitions();
        bin.y = 0;
        bin.set_scale(1, 1);
        if (!updating && bin.translation_x === 0)
            bin.translation_x = this._slideDistance();

        bin.ease({opacity: 255, duration: FADE_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        springTo(bin, {translation_x: 0}, SLIDE_IN_RESPONSE, isFinished => {
            if (epoch !== this._bannerEpoch || !this._matchesBanner(tray, banner, notification)) return;
            if (!isFinished && tray._notificationState !== State.SHOWING)
                return;
            tray._notificationState = State.SHOWN;
            // the reference design banners stay about 5 s (GNOME's own is 4 s).
            if (tray._notification?.urgency !== Urgency.CRITICAL)
                tray._updateNotificationTimeout(DWELL_MS);
            tray._updateState();
        });
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
        stopSpring(bin);
        bin.remove_all_transitions();
        tray._notificationState = State.HIDING;
        const duration = animate ? SLIDE_OUT_MS : 0;
        bin.ease({opacity: 0, duration, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        bin.ease({
            translation_x: this._slideDistance(),
            duration,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => {
                if (epoch !== this._bannerEpoch || !this._matchesBanner(tray, banner, notification)) return;
                tray._notificationState = State.HIDDEN;
                tray._hideNotificationCompleted();
                bin.translation_x = 0;
                tray._updateState();
            },
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
        if (s.active && !this._matchesBanner(tray, s.banner, s.notification)) this._cancelSwipe();
        if (!s.active) {
            if (Math.abs(dx) <= Math.abs(dy) || dx === 0)
                return Clutter.EVENT_PROPAGATE;   // vertical scrolling: leave it to the banner
            this._cancelSwipe();
            s.active = true;
            s.banner = tray._banner;
            s.notification = tray._notification;
            s.x = this._bin.translation_x;
            s.speed = 0;
            stopSpring(this._bin);
            this._bin.remove_all_transitions();
            this._bin.opacity = 255;
            // Hold the auto-hide while the finger is on the banner.
            tray._updateNotificationTimeout(0);
        }

        const now = GLib.get_monotonic_time() / 1000;
        const step = dx * SWIPE_PX_PER_UNIT;
        // Rightward follows the finger; leftward meets resistance.
        s.x = s.x + step > 0 ? s.x + step : (s.x + step) * 0.25;
        if (s.lastTime)
            s.speed = (s.x - s.lastX) / Math.max(1, now - s.lastTime);
        s.lastTime = now;
        s.lastX = s.x;
        this._bin.translation_x = s.x;
        this._bin.opacity = Math.round(255 * Math.max(0.25, 1 - Math.max(0, s.x) / this._slideDistance()));

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
        s.lastTime = 0;
        const width = this._slideDistance() - 40;
        const dismiss = s.x > width * SWIPE_DISMISS_FRACTION || s.speed > SWIPE_FLICK_SPEED;
        if (dismiss && tray._banner) {
            // GNOME then calls our _hide, which slides on from here.
            tray._expireNotification();
            return;
        }
        s.returning = true;
        this._bin.ease({opacity: 255, duration: FADE_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        springTo(this._bin, {translation_x: 0}, SLIDE_IN_RESPONSE, () => {
            if (s.serial !== serial || !this._matchesBanner(tray, banner, notification)) return;
            s.returning = false;
            if (tray._notificationState === State.SHOWN &&
                tray._notification?.urgency !== Urgency.CRITICAL)
                tray._updateNotificationTimeout(2000);
        });
    }
}

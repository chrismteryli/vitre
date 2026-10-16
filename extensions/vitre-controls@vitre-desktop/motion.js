/* Control Center open/close motion.
 *
 * drip-style `liquid` (default, plan A17): the pill drips into the modules (liquidDrip.js / dripMotion.js,
 * Vitre's own design, not measured from the reference); `classic`: the measured motion below, unchanged.
 *
 * reference motion, measured from the reference's frame-stepped recordings (plan A9 section 1.3):
 *   open                        : instant, whole grid in one frame, no slide/scale/fade
 *   close (click away/Esc/icon) : opacity-only fade, 50 ms, linear, no movement
 *   close (another menu opens)  : instant, in the same frame as the other menu starts
 * GNOME's ease() multiplies durations by St's slow-down factor (Just Perfection sets
 * 0.8); the reference's timings are not scaled, so the duration is divided by it.
 */
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

import {motionAllowed} from './liquidDrip.js';
import {DRIP} from './dripMotion.js';

export const CLOSE_FADE_MS = 50;

export function easeDuration(ms) {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return 0;
    return ms / Math.max(0.05, settings.slow_down_factor);
}

export function installMenuMotion(pointer, journal, isActive, drip = null) {
    if (!pointer._muteInput || !pointer._muteKeys || typeof pointer.remove_transition !== 'function')
        throw new Error('Unsupported native popup animation controls.');
    const saved = {opacity: pointer.opacity, translation_x: pointer.translation_x,
        translation_y: pointer.translation_y, scale_x: pointer.scale_x, scale_y: pointer.scale_y};
    let generation = 0;
    let disposed = false;
    const cancel = () => {
        generation++;
        pointer.remove_all_transitions();
        return generation;
    };
    journal.method(pointer, 'open', original => function (animate, onComplete) {
        if (disposed || !isActive()) {
            cancel();
            return original.call(this, animate, onComplete);
        }
        cancel();
        const liquid = drip && drip.style.liquid && animate !== PopupAnimation.NONE && motionAllowed();
        if (!liquid && drip?.controller.phase !== 'closed')
            drip.controller.reset();
        // NONE: show(), opacity 255, no scale/translation, 0 ms ease.
        original.call(this, PopupAnimation.NONE, onComplete);
        this.scale_x = 1;
        this.scale_y = 1;
        this.translation_x = 0;
        this.translation_y = 0;
        this.opacity = 255;
        this._muteKeys.enabled = false;
        if (liquid) {
            // liquid drip: the surface shows nothing until the drip hands each piece over; input is muted meanwhile
            this._muteInput.enabled = true;
            drip.controller.callbacks.onOpened = () => {
                this._muteInput.enabled = false;
            };
            drip.controller.open(animate & PopupAnimation.SLIDE ? 1 : DRIP.switchOpenSpeed);      // FADE alone: another pop-out is closing
            return;
        }
        this._muteInput.enabled = false;
        // an instant open in the liquid style is still a settled surface: its close drips
        if (drip && drip.style.liquid && drip.controller.phase === 'closed')
            drip.controller.markOpen();
    });
    journal.method(pointer, 'close', original => function (animate, onComplete) {
        if (disposed || !isActive() || !this.visible) {
            if (!disposed)
                cancel();
            return original.call(this, animate, onComplete);
        }
        const current = cancel();
        if (drip && drip.controller.phase !== 'closed') {
            if (animate !== PopupAnimation.NONE && drip.style.liquid && motionAllowed()) {
                // liquid: retract into the pill (0.7x when another top-bar pop-out is taking over, i.e. FADE only)
                const switching = !(animate & PopupAnimation.SLIDE);
                this._muteInput.enabled = true;
                this._muteKeys.enabled = true;
                drip.controller.callbacks.onClosed = () => {
                    if (disposed)
                        return;
                    original.call(this, PopupAnimation.NONE, onComplete);
                };
                drip.controller.close(switching ? DRIP.switchCloseScale : 1);
                return;
            }
            // instant close, animations off, or the style was switched to `classic` meanwhile: the measured path below
            drip.controller.reset();
        }
        const userClose = Boolean(animate & PopupAnimation.SLIDE); // FULL; FADE alone = another menu took over
        const duration = easeDuration(CLOSE_FADE_MS);
        if (!userClose || duration <= 0 || St.Settings.get().reducedMotion === St.ReducedMotion.REDUCE) {
            return original.call(this, PopupAnimation.NONE, onComplete);
        }
        this._muteInput.enabled = true;
        this._muteKeys.enabled = true;
        this.ease({
            opacity: 0, duration, mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => {
                if (current !== generation || disposed)
                    return;
                original.call(this, PopupAnimation.NONE, onComplete);
            },
        });
    });
    journal.add(() => {
        disposed = true;
        drip?.controller.reset();
        pointer.remove_all_transitions();
        for (const [key, value] of Object.entries(saved))
            pointer[key] = value;
    });
}

/* Notification Center open/close motion.
 *
 * drip-style `liquid` (default, plan A17): the clock pill drips into the cards and widgets (liquidDrip.js /
 * dripMotion.js, Vitre's own design, not measured from the reference); `classic`: the slide below, unchanged.
 *
 * reference slide (plan A9 section 1.3):
 *
 * OPEN  (measured, the reference design reference 26 recording, 60 fps): the whole column translates from fully
 *       off-screen at the right edge to its place, no fade, no scale, no overshoot. Progress
 *       follows curve() from helpers.js (a critically damped spring with initial velocity,
 *       fitted to the table, max error 0.005), ~340 ms.
 * CLOSE (UNVERIFIED, the reference close was not recorded cleanly): the same curve played outward,
 *       i.e. slide back out to the right, fast start, decelerating, ~340 ms, no fade.
 * Interruptible: a reversal continues from the current position (no jump) by entering the
 * other curve at the time that gives the same displacement.
 * Switching from another top-bar menu: the old menu closes instantly (no animation); this
 * menu opening slides in as usual.
 * Reduced motion / animations off: instant.
 * The time source is a Clutter.Timeline (NOT slowed by St's slow-down factor, which Just
 * Perfection sets to 0.8): the reference's durations are used as measured.
 */
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

import {CURVE, NCGEO, curve, curveInverse} from './helpers.js';
import {motionAllowed as dripMotionAllowed} from './liquidDrip.js';
import {DRIP} from './dripMotion.js';

export function installPopupMotion(pointer, journal, isActive, drip = null) {
    if (!pointer._muteInput || !pointer._muteKeys || typeof pointer.remove_transition !== 'function')
        throw new Error('Unsupported native popup animation controls.');
    const saved = Object.fromEntries(['translation_x', 'translation_y',
        'scale_x', 'scale_y', 'opacity'].map(key => [key, pointer[key]]));
    let disposed = false;
    let phase = 'idle';          // 'idle' | 'opening' | 'closing'
    let timeline = null;
    let distance = 0;

    const stop = () => {
        if (timeline) {
            timeline.stop();
            timeline.disconnectObject(pointer);
            timeline = null;
        }
        pointer.remove_all_transitions();
    };
    const motionAllowed = () => {
        const settings = St.Settings.get();
        return settings.enable_animations && settings.reducedMotion !== St.ReducedMotion.REDUCE;
    };
    // Distance from the column's resting left edge to the monitor's right edge. A menu that was never
    // shown has no allocation yet (its transformed position is NaN), so this is computed from sizes:
    // the column sits 13 px from the monitor edge and the scroll view adds a few px of room around it.
    const measureDistance = () => {
        const [x] = pointer.get_transformed_position();
        const area = pointer._workArea;
        const monitorRight = area ? area.x + area.width : global.stage.width;
        const restLeft = x - pointer.translation_x;
        if (Number.isFinite(restLeft) && pointer.has_allocation?.())
            return Math.max(1, monitorRight - restLeft);
        const [, natural] = pointer.get_preferred_width(-1);
        return Math.max(1, natural + NCGEO.rightMargin - NCGEO.clipPad);
    };
    // Play curve() starting at time `s0` (ms), writing translation_x = (1 - value) * distance for
    // opening or value * distance for closing.
    const run = (dir, s0, onDone) => {
        const tl = new Clutter.Timeline({duration: Math.max(1, CURVE.DURATION - s0) + 1000, actor: pointer});
        timeline = tl;
        tl.connectObject('new-frame', () => {
            const s = s0 + tl.get_elapsed_time();
            const v = curve(s);
            pointer.translation_x = dir === 'open' ? (1 - v) * distance : v * distance;
            if (s >= CURVE.DURATION) {
                tl.stop();
                tl.disconnectObject(pointer);
                if (timeline === tl)
                    timeline = null;
                onDone();
            }
        }, pointer);
        tl.start();
    };

    journal.method(pointer, 'open', original => function (flags, onComplete) {
        if (disposed || !isActive()) {
            stop();
            return original.call(this, flags, onComplete);
        }
        const liquid = drip && drip.style.liquid && flags !== PopupAnimation.NONE && dripMotionAllowed();
        if (!liquid && drip && drip.controller.phase !== 'closed')
            drip.controller.reset();
        if (liquid) {
            // liquid drip: no slide; the column stands at its place and shows nothing until the drip hands pieces over
            stop();
            phase = 'idle';
            original.call(this, PopupAnimation.NONE);
            this.scale_x = 1;
            this.scale_y = 1;
            this.translation_x = 0;
            this.translation_y = 0;
            this.opacity = 255;
            this._muteInput.enabled = true;
            drip.controller.callbacks.onOpened = () => {
                this._muteInput.enabled = false;
            };
            drip.controller.open(flags & PopupAnimation.SLIDE ? 1 : DRIP.switchOpenSpeed);      // FADE alone: another pop-out is closing
            onComplete?.();
            return;
        }
        const reversing = phase === 'closing';
        const wasVisible = this.visible;
        const goingOut = reversing ? this.translation_x : 0;
        stop();
        distance = measureDistance();
        // Native NONE: shows the actor, opacity 255, input-controller setup.
        original.call(this, PopupAnimation.NONE);
        this.scale_x = 1;
        this.scale_y = 1;
        this.translation_y = 0;
        this.opacity = 255;
        if (!motionAllowed() || flags === PopupAnimation.NONE) {
            phase = 'idle';
            this.translation_x = 0;
            this._muteInput.enabled = false;
            if (drip && drip.style.liquid && drip.controller.phase === 'closed')
                drip.controller.markOpen();
            onComplete?.();
            return;
        }
        // visible fraction now: 0 for a fresh open, (1 - r) when reversing a close
        const fraction = reversing && wasVisible ? 1 - Math.min(1, goingOut / distance) : 0;
        phase = 'opening';
        this.translation_x = (1 - fraction) * distance;
        this._muteInput.enabled = true;
        run('open', curveInverse(fraction), () => {
            if (disposed || phase !== 'opening')
                return;
            phase = 'idle';
            this.translation_x = 0;
            this._muteInput.enabled = false;
            onComplete?.();
        });
    });

    journal.method(pointer, 'close', original => function (flags, onComplete) {
        if (disposed || !isActive()) {
            stop();
            return original.call(this, flags, onComplete);
        }
        if (!this.visible)
            return;
        if (drip && drip.controller.phase !== 'closed') {
            if (flags !== PopupAnimation.NONE && drip.style.liquid && dripMotionAllowed()) {
                // liquid: retract into the pill (0.7x when another top-bar pop-out is taking over, i.e. FADE only)
                const switching = !(flags & PopupAnimation.SLIDE);
                stop();
                this._muteInput.enabled = true;
                this._muteKeys.enabled = true;
                drip.controller.callbacks.onClosed = () => {
                    if (disposed)
                        return;
                    phase = 'idle';
                    original.call(this, PopupAnimation.NONE, onComplete);
                    this.translation_x = 0;
                };
                drip.controller.close(switching ? DRIP.switchCloseScale : 1);
                return;
            }
            drip.controller.reset();
        }
        // Another top-bar menu took over (fade-only close) or no animation requested: instant.
        const switching = flags !== PopupAnimation.NONE && !(flags & PopupAnimation.SLIDE);
        if (!motionAllowed() || flags === PopupAnimation.NONE || switching) {
            stop();
            phase = 'idle';
            this.translation_x = 0;
            return original.call(this, PopupAnimation.NONE, onComplete);
        }
        const reversing = phase === 'opening';
        const out = reversing ? this.translation_x : 0;
        stop();
        if (!reversing)
            distance = measureDistance();
        const fraction = reversing ? Math.min(1, out / distance) : 0;
        phase = 'closing';
        this._muteInput.enabled = true;
        this._muteKeys.enabled = true;
        run('close', curveInverse(fraction), () => {
            if (disposed || phase !== 'closing')
                return;
            phase = 'idle';
            // Native close owns hide, reset and the menu-closed callback.
            original.call(this, PopupAnimation.NONE, onComplete);
            this.translation_x = 0;
        });
    });

    journal.add(() => {
        disposed = true;
        drip?.controller.reset();
        stop();
        for (const [key, value] of Object.entries(saved))
            pointer[key] = value;
    });
}

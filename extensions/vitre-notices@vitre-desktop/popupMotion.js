/* Notification Center open/close motion.
 *
 * drip-style `liquid` (default): the clock pill's glass pours into the cards and widgets (liquidDrip.js / dripMotion.js,
 * liquid.js springs); with another top-bar pop-out open the glass flows over sideways. `classic`: the slide below.
 *
 * Classic slide (liquid v3: on a liquid.js spring, no curve and no duration):
 * OPEN  the whole column moves in from fully off-screen at the right edge to its place on the 'pour' spring, no fade, no
 *       scale (the measured slide had no overshoot; the pour role's small one is the liquid feel).
 * CLOSE the same spring retargeted outward with the exit parameters (response x 0.8, damping >= 0.94: never bouncing).
 * Interruptible: one spring carries the column, so a reversal turns around from where it is, with its speed.
 * Switching from another top-bar menu: the old menu closes instantly (no animation); this menu opening slides in as usual.
 * Animations off: instant. Reduced motion: no travel, the column cross-fades in place (160 ms spring).
 * Springs are stepped by liquidClock.js's Ticker (wall clock per frame, NOT slowed by St's slow-down factor).
 */
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

import {NCGEO} from './helpers.js';
import {motionAllowed as dripMotionAllowed} from './liquidDrip.js';
import {DRIP} from './dripMotion.js';
import {Spring, Fade, role, REDUCED, EPS_PX, EPS_OPACITY} from './liquid.js';
import {Ticker, motionMode} from './liquidClock.js';

export function installPopupMotion(pointer, journal, isActive, drip = null) {
    if (!pointer._muteInput || !pointer._muteKeys || typeof pointer.remove_transition !== 'function')
        throw new Error('Unsupported native popup animation controls.');
    const saved = Object.fromEntries(['translation_x', 'translation_y',
        'scale_x', 'scale_y', 'opacity'].map(key => [key, pointer[key]]));
    let disposed = false;
    let phase = 'idle';          // 'idle' | 'opening' | 'closing'
    let onDone = null;
    const x = new Spring(0, role('pour'), EPS_PX);       // translation_x of the column
    const op = new Fade(1, REDUCED, EPS_OPACITY);        // reduced motion: the column's opacity
    let reduced = false;
    const ticker = new Ticker(dt => {
        if (reduced) {
            pointer.opacity = Math.round(255 * op.step(dt));
            if (!op.rest)
                return true;
        } else {
            pointer.translation_x = x.step(dt);
            if (!x.rest)
                return true;
        }
        const done = onDone;
        onDone = null;
        done?.();
        return false;
    }, {actor: pointer});

    const stop = () => {
        ticker.stop();
        onDone = null;
        pointer.remove_all_transitions();
    };
    // Distance from the column's resting left edge to the monitor's right edge. A menu that was never
    // shown has no allocation yet (its transformed position is NaN), so this is computed from sizes:
    // the column sits 13 px from the monitor edge and the scroll view adds a few px of room around it.
    const measureDistance = () => {
        const [px] = pointer.get_transformed_position();
        const area = pointer._workArea;
        const monitorRight = area ? area.x + area.width : global.stage.width;
        const restLeft = px - pointer.translation_x;
        if (Number.isFinite(restLeft) && pointer.has_allocation?.())
            return Math.max(1, monitorRight - restLeft);
        const [, natural] = pointer.get_preferred_width(-1);
        return Math.max(1, natural + NCGEO.rightMargin - NCGEO.clipPad);
    };
    // move to `target` (translation_x, px; reduced motion: opacity 0..1) and call done when the spring rests
    const run = (target, params, done) => {
        onDone = done;
        if (reduced)
            op.set(target, REDUCED);
        else
            x.set(target, params);
        ticker.start();
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
            // liquid: no slide; the column stands at its place and shows nothing until the pour hands pieces over
            stop();
            phase = 'idle';
            original.call(this, PopupAnimation.NONE);
            this.scale_x = 1;
            this.scale_y = 1;
            this.translation_x = 0;
            this.translation_y = 0;
            this.opacity = 255;
            this._muteInput.enabled = true;
            drip.controller.callbacks.onInteractive = () => {
                this._muteInput.enabled = false;
            };
            drip.controller.callbacks.onOpened = () => {
                this._muteInput.enabled = false;
            };
            drip.controller.open(flags & PopupAnimation.SLIDE ? 1 : DRIP.switchOpenSpeed);      // FADE alone: another pop-out is closing
            onComplete?.();
            return;
        }
        const reversing = phase === 'closing';
        const wasVisible = this.visible;
        stop();
        // Native NONE: shows the actor, opacity 255, input-controller setup.
        original.call(this, PopupAnimation.NONE);
        this.scale_x = 1;
        this.scale_y = 1;
        this.translation_y = 0;
        const mode = motionMode();
        if (mode === 'off' || flags === PopupAnimation.NONE) {
            phase = 'idle';
            this.translation_x = 0;
            this.opacity = 255;
            x.snap(0);
            op.snap(1);
            this._muteInput.enabled = false;
            if (drip && drip.style.liquid && drip.controller.phase === 'closed')
                drip.controller.markOpen();
            onComplete?.();
            return;
        }
        reduced = mode === 'reduced';
        if (reduced) {
            x.snap(0);
            this.translation_x = 0;
            if (!(reversing && wasVisible))
                op.snap(0);
            this.opacity = Math.round(255 * op.x);
        } else {
            this.opacity = 255;
            op.snap(1);
            if (!(reversing && wasVisible))
                x.snap(measureDistance());      // a fresh open starts fully off-screen; a reversal goes on from where it is
            this.translation_x = x.x;
        }
        phase = 'opening';
        this._muteInput.enabled = true;
        run(reduced ? 1 : 0, role('pour'), () => {
            if (disposed || phase !== 'opening')
                return;
            phase = 'idle';
            this.translation_x = 0;
            this.opacity = 255;
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
                // liquid: back into the pill; FADE only = another top-bar pop-out takes this glass body sideways
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
        const mode = motionMode();
        if (mode === 'off' || flags === PopupAnimation.NONE || switching) {
            stop();
            phase = 'idle';
            this.translation_x = 0;
            x.snap(0);
            return original.call(this, PopupAnimation.NONE, onComplete);
        }
        const reversing = phase === 'opening';
        ticker.stop();
        onDone = null;
        reduced = mode === 'reduced';
        if (!reversing) {
            x.snap(this.translation_x);
            op.snap(this.opacity / 255);
        }
        phase = 'closing';
        this._muteInput.enabled = true;
        this._muteKeys.enabled = true;
        run(reduced ? 0 : measureDistance(), role('pour', {exit: true}), () => {
            if (disposed || phase !== 'closing')
                return;
            phase = 'idle';
            // Native close owns hide, reset and the menu-closed callback.
            original.call(this, PopupAnimation.NONE, onComplete);
            this.translation_x = 0;
            this.opacity = 255;
            x.snap(0);
            op.snap(1);
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

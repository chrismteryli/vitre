/* Control Center open/close motion.
 *
 * drip-style `liquid` (default): the button's glass pours into the modules (liquidDrip.js / dripMotion.js, liquid.js
 * springs); with another top-bar pop-out open the glass flows over sideways. `classic`: the measured choreography below,
 * its motion on liquid.js springs (liquid v3):
 *   open                        : instant, whole grid in one frame, no slide/scale/fade
 *   close (click away/Esc/icon) : opacity only, on the fade role's exit spring (reduced motion: the 160 ms cross-fade)
 *   close (another menu opens)  : instant, in the same frame as the other menu starts
 */
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

import {motionAllowed} from './liquidDrip.js';
import {role} from './liquid.js';
import {animate, stopAnimate, motionMode} from './liquidClock.js';
import {DRIP} from './dripMotion.js';

export function installMenuMotion(pointer, journal, isActive, drip = null) {
    if (!pointer._muteInput || !pointer._muteKeys || typeof pointer.remove_transition !== 'function')
        throw new Error('Unsupported native popup animation controls.');
    const saved = {opacity: pointer.opacity, translation_x: pointer.translation_x,
        translation_y: pointer.translation_y, scale_x: pointer.scale_x, scale_y: pointer.scale_y};
    let generation = 0;
    let disposed = false;
    const cancel = () => {
        generation++;
        stopAnimate(pointer);
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
            drip.controller.callbacks.onInteractive = () => {
                this._muteInput.enabled = false;
            };
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
                // liquid: back into the pill; FADE only = another top-bar pop-out takes this glass body sideways
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
        if (!userClose || motionMode() === 'off')
            return original.call(this, PopupAnimation.NONE, onComplete);
        this._muteInput.enabled = true;
        this._muteKeys.enabled = true;
        animate(this, {opacity: 0}, {
            fade: role('fade', {exit: true}),
            onDone: finished => {
                if (!finished || current !== generation || disposed)
                    return;
                original.call(this, PopupAnimation.NONE, onComplete);
            },
        });
    });
    journal.add(() => {
        disposed = true;
        stopAnimate(pointer);
        drip?.controller.reset();
        pointer.remove_all_transitions();
        for (const [key, value] of Object.entries(saved))
            pointer[key] = value;
    });
}

/* Vitre Corner: the time, the battery and the Control Center when the top bar is hidden.
 *
 * the owner (2026-10-22): "when i move my cursor to the top right, i want it to show time, battery and a small button to
 * open the quick menu". The main case is a full-screen window (a video): GNOME hides the top bar over it, and with it the
 * clock, the battery and the Control Center button.
 *
 *   corner.js    which corners are live (full-screen monitors; the primary one when a setting hides the top bar), the two
 *                triggers (resting in the very corner for 150 ms, or a push against it), the 400 ms grace, Esc and clicks
 *   capsule.js   the glass capsule: the top bar's clock string, the battery, the round button; the Vitre stretch in and out
 *   battery.js   UPower's DisplayDevice, with GNOME's own icon and percentage rules
 *   controls.js  the Control Center opened from the button over the full-screen window, and put back exactly afterwards
 *   glass.js, glassField.js, dripField.js, dripMotion.js, liquidDrip.js, dripStyle.js: the shared Vitre glass and stretch
 *                modules, byte-identical copies (liquidDrip.js is vitre-menus' copy)
 *
 *   hotCorner.js the hot corner's motion (Motion Lab 2): GNOME's corner ripples played as a bead, a ring and a flash
 *
 * Nothing of GNOME is replaced for the capsule: no method is hooked (hotCorner.js wraps Ripples.playAnimation for the hot
 * corners' own ripples only). While the Control Center is open from the button its menu's
 * sourceActor (and vitre-controls' record of its source) point at the button; both are put back when it has closed.
 * disable() removes every actor, barrier, signal handler, timer, accelerator grab and compositor hold it made. */
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CornerWatch} from './corner.js';
import {HotCornerMotion} from './hotCorner.js';

export default class VitreCornerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        try {
            this._corner = new CornerWatch({settings: this._settings, path: this.path});
        } catch (e) {
            console.error(`Vitre Corner: not started: ${e?.message ?? e}`);
            this._teardown();
        }
        // the hot corner's motion (Motion Lab 2): on its own, so a failure leaves GNOME's ripples and the capsule as they are
        try {
            this._hot = new HotCornerMotion();
            this._hot.enable();
        } catch (e) {
            console.error(`Vitre Corner: hot corner motion not started: ${e?.message ?? e}`);
            this._hot?.destroy();
            this._hot = null;
        }
    }

    disable() {
        this._hot?.destroy();
        this._hot = null;
        this._teardown();
    }

    _teardown() {
        try {
            this._corner?.destroy();
        } catch (e) {
            console.error(`Vitre Corner: cleanup: ${e?.message ?? e}`);
        }
        this._corner = null;
        this._settings = null;
    }

    // rig: the state the harness samples (null while disabled)
    snapshot() {
        return this._corner?.snapshot() ?? null;
    }

    get corner() {
        return this._corner ?? null;
    }
}

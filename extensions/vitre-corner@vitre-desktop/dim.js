/* While the Control Center is open from the capsule over a full-screen window, that window is dimmed.
 *
 * Why: the Control Center is clear glass with white text (vitre-controls); its glass is a blurred copy of what is behind
 * it. Over the dark desktop that reads well; over a bright full-screen frame (a daylight scene, a white page) the tiles
 * measured 1.5:1 to 2:1 against white text in the rig: unreadable. Dimming the window under it to DIM of its brightness
 * puts the Control Center on a dark backdrop again (the glass copies the dimmed window), and reads as the window stepping
 * back while the panel is up. It follows the menu on a Fade spring (liquid.js fade role: never past its target; GNOME's own
 * Quick Settings dim uses the same effect and the same 127-based colour) and is removed completely when the menu has
 * closed: the window is left exactly as it was. Reduced motion: the 160 ms cross-fade. */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';

import {motionAllowed} from './liquidDrip.js';
import {Fade, role, REDUCED} from './liquid.js';
import {Ticker, motionMode} from './liquidClock.js';

const EFFECT = 'vitre-corner-dim';
export const DIM = 0.45;            // the window's brightness while the Control Center is open over it (1 = unchanged)

const level = v => {
    const c = Math.round(127 * v);
    return new Cogl.Color({red: c, green: c, blue: c, alpha: 255});
};

// The full-screen window on that monitor: the topmost one that is full screen or covers the monitor, on the active workspace.
export function fullscreenActorOn(monitorIndex) {
    const ws = global.workspace_manager.get_active_workspace();
    const actors = global.get_window_actors().filter(a => {
        const w = a.meta_window;
        if (!w || w.minimized || !a.visible || w.get_monitor() !== monitorIndex)
            return false;
        if (!w.is_on_all_workspaces() && w.get_workspace() !== ws)
            return false;
        return w.is_fullscreen() || w.is_monitor_sized?.();
    });
    return actors.at(-1) ?? null;
}

export class WindowDim {
    constructor() {
        this._actor = null;
        this._effect = null;
        this._v = new Fade(1, role('fade'), 1e-3);
        this._done = null;
        this._ticker = new Ticker(dt => {
            const v = this._v.step(dt);
            if (this._effect)
                this._effect.brightness = level(v);
            if (!this._v.rest && this._effect)
                return true;
            const done = this._done;
            this._done = null;
            done?.();
            return false;
        });
    }

    get dimmed() {
        return Boolean(this._effect);
    }

    dim(monitorIndex) {
        const actor = fullscreenActorOn(monitorIndex);
        if (!actor)
            return;
        if (this._actor && this._actor !== actor)
            this._remove();
        if (!this._effect) {
            this._actor = actor;
            this._effect = new Clutter.BrightnessContrastEffect();
            this._effect.brightness = level(1);
            this._v.snap(1);
            actor.add_effect_with_name(EFFECT, this._effect);
            actor.connectObject('destroy', () => {
                this._actor = null;
                this._effect = null;
            }, this);
        }
        this._ease(DIM, false, null);
    }

    undim(instant = false) {
        if (!this._effect)
            return;
        if (instant || !motionAllowed()) {
            this._remove();
            return;
        }
        const effect = this._effect;
        this._ease(1, true, () => {
            if (this._effect === effect)
                this._remove();
        });
    }

    _ease(value, leaving, done) {
        const actor = this._actor;
        actor.remove_transition(`@effects.${EFFECT}.brightness`);
        this._done = null;
        if (!motionAllowed()) {
            this._ticker.stop();
            this._v.snap(value);
            this._effect.brightness = level(value);
            done?.();
            return;
        }
        this._v.set(value, motionMode() === 'reduced' ? REDUCED : role('fade', {exit: leaving}));
        this._done = done;
        this._ticker.start();
    }

    _remove() {
        this._ticker.stop();
        this._done = null;
        const actor = this._actor;
        const effect = this._effect;
        this._actor = null;
        this._effect = null;
        if (!actor)
            return;
        try {
            actor.disconnectObject(this);
            actor.remove_transition(`@effects.${EFFECT}.brightness`);
            if (effect && actor.get_effect(EFFECT) === effect)
                actor.remove_effect(effect);
        } catch (_e) {
            // the window went away with its actor
        }
    }

    destroy() {
        this._remove();
    }
}

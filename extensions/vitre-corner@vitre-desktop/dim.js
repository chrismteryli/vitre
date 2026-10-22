/* While the Control Center is open from the capsule over a full-screen window, that window is dimmed.
 *
 * Why: the Control Center is clear glass with white text (vitre-controls); its glass is a blurred copy of what is behind
 * it. Over the dark desktop that reads well; over a bright full-screen frame (a daylight scene, a white page) the tiles
 * measured 1.5:1 to 2:1 against white text in the rig: unreadable. Dimming the window under it to DIM of its brightness
 * puts the Control Center on a dark backdrop again (the glass copies the dimmed window), and reads as the window stepping
 * back while the panel is up. It eases in and out with the menu (GNOME's own Quick Settings dim uses the same effect
 * and the same 127-based colour) and is removed completely when the menu has closed: the window is left exactly as it was. */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';

import {motionAllowed} from './liquidDrip.js';

const EFFECT = 'vitre-corner-dim';
export const DIM = 0.45;            // the window's brightness while the Control Center is open over it (1 = unchanged)
const IN_MS = 200;
const OUT_MS = 160;

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
            actor.add_effect_with_name(EFFECT, this._effect);
            actor.connectObject('destroy', () => {
                this._actor = null;
                this._effect = null;
            }, this);
        }
        this._ease(DIM, IN_MS, null);
    }

    undim(instant = false) {
        if (!this._effect)
            return;
        if (instant || !motionAllowed()) {
            this._remove();
            return;
        }
        const effect = this._effect;
        this._ease(1, OUT_MS, () => {
            if (this._effect === effect)
                this._remove();
        });
    }

    _ease(value, ms, done) {
        const actor = this._actor;
        actor.remove_transition(`@effects.${EFFECT}.brightness`);
        if (!motionAllowed()) {
            this._effect.brightness = level(value);
            done?.();
            return;
        }
        actor.ease_property(`@effects.${EFFECT}.brightness`, level(value), {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: ms,
            onStopped: finished => {
                if (finished)
                    done?.();
            },
        });
    }

    _remove() {
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

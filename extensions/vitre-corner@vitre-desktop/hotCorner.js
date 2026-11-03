/* The hot corner (Motion Lab 2, hot corner). GNOME plays three expanding ripples (ui/ripples.js) when the top-left corner
 * opens the overview (layout.js HotCorner). For the hot corners' own Ripples (the locate-pointer ripples are left alone)
 * playAnimation is replaced by the lab's: a bead of light swells in the corner on the bead spring, a ring goes out on the
 * pour spring, the screen takes a 0.35 navy flash on the fade role, and 0.22 s later the bead and the flash are released on
 * their exit springs (bead exit, fade exit). GNOME's own ripple actors are used, so the look is GNOME's: the first ripple is
 * the bead, the second the ring (the third stays hidden); the flash is one full-stage actor of ours, never reactive.
 * Animations off: GNOME's own ripples. Reduced motion: the bead and the flash cross-fade in place on the 160 ms spring, no
 * ring and no swelling. Hot corners are off on the owner's desktop (enable-hot-corners false): this plays only when they
 * are on. */
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Ripples from 'resource:///org/gnome/shell/ui/ripples.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Spring, Fade, role, REDUCED, EPS_OPACITY} from './liquid.js';
import {Ticker, motionMode} from './liquidClock.js';

export const HOT = {
    flash: 0.35,            // the flash's opacity (lab 2)
    flashColor: '#081226',
    hold: 0.22,             // s before the bead and the flash are released
    ringFrom: 0.2,          // the ring's scale: 0.2 + 1.4 x the pour spring
    ringGrow: 1.4,
    ringAlpha: 0.9,
};

export class HotCornerMotion {
    constructor() {
        this._im = null;
        this._states = new Set();
    }

    enable() {
        this._im = new InjectionManager();
        const self = this;
        this._im.overrideMethod(Ripples.Ripples.prototype, 'playAnimation', original => function (x, y) {
            if (motionMode() === 'off' || !self._isHotCorner(this))
                return original.call(this, x, y);
            try {
                self._play(this, x, y);
            } catch (e) {
                console.error(`Vitre Corner: hot corner motion failed, GNOME's ripples: ${e?.message ?? e}`);
                self._reset(this);
                original.call(this, x, y);
            }
            return undefined;
        });
    }

    _isHotCorner(ripples) {
        return (Main.layoutManager.hotCorners ?? []).some(c => c?._ripples === ripples);
    }

    _stateOf(r) {
        if (r._vitreHot)
            return r._vitreHot;
        const flash = new St.Widget({name: 'vitre-hot-flash', reactive: false, opacity: 0, visible: false,
            style: `background-color: ${HOT.flashColor};`});
        flash.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));
        Shell.util_set_hidden_from_pick(flash, true);
        const st = {
            r, flash,
            bl: new Spring(0, role('bead'), 1e-3),          // the bead's scale
            rg: new Spring(0, role('pour'), 1e-3),          // the ring, 0 .. 1
            fl: new Fade(0, role('fade'), EPS_OPACITY),     // the flash, 0 .. HOT.flash
            hold: -1,                                       // s until the release
            reduced: false,
            ticker: null,
        };
        st.ticker = new Ticker(dt => this._step(st, dt));
        r._vitreHot = st;
        this._states.add(st);
        return st;
    }

    _play(r, x, y) {
        if (r._stage === undefined)
            throw new Error('Ripples not added');
        const st = this._stateOf(r);
        st.reduced = motionMode() === 'reduced';
        r._x = x;
        r._y = y;
        if (!st.flash.get_parent())
            r._stage.add_child(st.flash);
        // the flash under the bead and the ring, all of them on top
        r._stage.set_child_above_sibling(st.flash, null);
        r._stage.set_child_above_sibling(r._ripple1, st.flash);
        r._stage.set_child_above_sibling(r._ripple2, r._ripple1);
        for (const ripple of [r._ripple1, r._ripple2, r._ripple3]) {
            ripple.remove_all_transitions();
            ripple.x = x;
            ripple.y = y;
            ripple.set_translation(-r._px * ripple.width, -r._py * ripple.height, 0);
        }
        r._ripple3.visible = false;
        st.flash.visible = true;
        if (st.reduced) {
            st.bl.snap(1);
            st.rg.snap(0);
            st.fl.set(HOT.flash, REDUCED);
            st.fade = new Fade(st.fade?.x ?? 0, REDUCED, EPS_OPACITY).set(1, REDUCED);
        } else {
            st.bl.set(1, role('bead'));
            st.rg.snap(0).set(1, role('pour'));
            st.fl.set(HOT.flash, role('fade'));
            st.fade = null;
        }
        st.hold = HOT.hold;
        this._apply(st);
        st.ticker.start();
    }

    _step(st, dt) {
        if (st.hold >= 0) {
            st.hold -= dt;
            if (st.hold < 0) {
                // released: the bead goes back into the corner, the flash out
                if (st.reduced) {
                    st.fade.set(0, REDUCED);
                    st.fl.set(0, REDUCED);
                } else {
                    st.bl.set(0, role('bead', {exit: true}));
                    st.fl.set(0, role('fade', {exit: true}));
                }
            }
        }
        st.bl.step(dt);
        st.rg.step(dt);
        st.fl.step(dt);
        st.fade?.step(dt);
        this._apply(st);
        const moving = st.hold >= 0 || !st.bl.rest || !st.rg.rest || !st.fl.rest || (st.fade && !st.fade.rest);
        if (!moving)
            this._hide(st);
        return moving;
    }

    _apply(st) {
        const r = st.r;
        const bead = r._ripple1;
        const ring = r._ripple2;
        const b = Math.max(0, st.bl.x);
        const alpha = st.reduced ? Math.min(1, Math.max(0, st.fade?.x ?? 0)) : (b > 0.001 ? 1 : 0);
        bead.visible = alpha > 0;
        bead.opacity = Math.round(255 * alpha);
        bead.set_scale(b, b);
        const g = st.rg.x;
        const ringAlpha = !st.reduced && g > 0 && g < 1.1 ? (1 - Math.min(1, g)) * HOT.ringAlpha : 0;
        ring.visible = ringAlpha > 0;
        ring.opacity = Math.round(255 * ringAlpha);
        const s = HOT.ringFrom + g * HOT.ringGrow;
        ring.set_scale(s, s);
        st.flash.opacity = Math.round(255 * Math.min(1, Math.max(0, st.fl.x)));
    }

    _hide(st) {
        for (const ripple of [st.r._ripple1, st.r._ripple2])
            ripple.visible = false;
        st.flash.visible = false;
        st.flash.opacity = 0;
    }

    _reset(r) {
        const st = r._vitreHot;
        if (!st)
            return;
        st.ticker.stop();
        this._hide(st);
    }

    destroy() {
        this._im?.clear();
        this._im = null;
        for (const st of this._states) {
            st.ticker.stop();
            try {
                this._hide(st);
                st.flash.destroy();
            } catch (_e) {
                // gone with the shell
            }
            delete st.r._vitreHot;
        }
        this._states.clear();
    }
}

/*
* Dhruva GNOME Extension
* Copyright (C) 2026 NarkAgni
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Vitre (Motion Lab 2, drag and drop): the Dock while something is carried over it, on liquid.js springs.
//   push      icons make room around the pointer: offset = sign(icon - pointer) x 14 x exp(-|icon - pointer| / 70) (logical
//             px), each icon on the bead spring (ExternalDrop: an app carried in from the overview or the app grid).
//   swell     a drop target swells to 1.22 on the bead spring (a Dock icon held with Ctrl over another icon or a folder,
//             the one it would merge into) and goes back on the same spring.
//   swallow   a drop on that target is swallowed: the dropped icon flies into it on the pour exit spring (to 0.15) and the
//             target takes a bead kick of -3 (a squash that keeps its area) once it has.
//   home      a Dock icon let go anywhere else in the Dock glides home into its slot (glide spring) instead of appearing
//             there; its own button shows again when it has landed.
// Only the icon inside a button is scaled (the magnifier owns the button's own scale and position). Full motion only:
// reduced motion and animations off keep Dhruva's instant behaviour.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { isActorAlive } from '../core/Utils.js';
import { Spring, role, feel, squash, EPS_PX } from '../liquid/liquid.js';
import { Ticker, motionMode } from '../liquid/liquidClock.js';

export const DROP = {
    push: 14,               // logical px at the pointer (lab 2)
    falloff: 70,            // logical px
    swell: 1.22,
    swallowTo: 0.15,        // the dropped icon's scale as it goes in
    swallowAfter: 0.22,     // s from the drop to the target's kick
    kick: -3,
    squash: 0.06,
};

const full = () => motionMode() === 'full';
const scaleFactor = () => Math.max(1, St.ThemeContext.get_for_stage(global.stage).scale_factor);

// the lab's push for an icon whose centre is `centre` (same units as `pointer`); units per logical px = k
export function pushOffset(centre, pointer, k = scaleFactor()) {
    const d = centre - pointer;
    return Math.sign(d) * DROP.push * k * Math.exp(-Math.abs(d) / (DROP.falloff * k));
}

// the icon inside a Dock button (app: iconWrapper's bin; a folder or a module: the button's child)
export function iconOf(btn) {
    if (!isActorAlive(btn)) return null;
    const inner = btn._iconWrapper?.get_first_child?.();
    if (inner && isActorAlive(inner)) return inner;
    const child = btn.get_child?.();
    return child && isActorAlive(child) ? child : null;
}

// one icon's swell and kick: scale = swell x squash, one Ticker
function iconState(icon) {
    if (icon._vitreDrop) return icon._vitreDrop;
    const st = {
        sw: new Spring(1, role('bead'), 1e-3),
        sq: new Spring(0, role('bead'), 1e-3),
        ticker: null,
    };
    st.ticker = new Ticker(dt => {
        if (!isActorAlive(icon)) return false;
        st.sw.step(dt);
        st.sq.step(dt);
        const q = squash(st.sq.x * DROP.squash, Math.max(0.5, feel().volume));
        icon.set_pivot_point(0.5, 0.5);
        icon.set_scale(st.sw.x * q.across, st.sw.x * q.along);
        return !st.sw.rest || !st.sq.rest;
    });
    icon._vitreDrop = st;
    icon.connect('destroy', () => st.ticker.stop());
    return st;
}

export function swell(btn, on) {
    const icon = iconOf(btn);
    if (!icon) return;
    if (!full()) {
        if (icon._vitreDrop) icon._vitreDrop.ticker.stop();
        icon.set_scale(1, 1);
        return;
    }
    const st = iconState(icon);
    st.sw.set(on ? DROP.swell : 1, role('bead'));
    st.ticker.start();
}

export function kick(btn, v = DROP.kick) {
    const icon = iconOf(btn);
    if (!icon || !full()) return;
    const st = iconState(icon);
    st.sq.p = role('bead');
    st.sq.kick(v);
    st.ticker.start();
}

// a stage rectangle of an actor as it is drawn
export function rectOf(actor) {
    if (!isActorAlive(actor)) return null;
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null;
}

// a picture of the carried icon: a fresh icon of the app (it outlives the button, which a merge or a re-render can destroy),
// else a clone of the button's icon
function pictureOf(btn) {
    const app = btn?._delegate?.app;
    if (app && !app.is_module && typeof app.create_icon_texture === 'function') {
        try {
            const icon = app.create_icon_texture(Math.round((btn._dims?.iconSize ?? 48)));
            if (icon) return icon;
        } catch (_e) {
            // a clone instead
        }
    }
    const icon = iconOf(btn);
    return icon ? new Clutter.Clone({ source: icon }) : null;
}

// the picture at `from` (stage rect) in the UI group; springs move its centre and its scale (1 = from's size)
function flyer(actor, from) {
    actor.reactive = false;
    Shell.util_set_hidden_from_pick(actor, true);
    actor.set_size(from.w, from.h);
    actor.set_pivot_point(0.5, 0.5);
    Main.uiGroup.add_child(actor);
    const s = {
        actor, w: from.w,
        x: new Spring(from.x + from.w / 2, role('glide'), EPS_PX),
        y: new Spring(from.y + from.h / 2, role('glide'), EPS_PX),
        k: new Spring(1, role('bead'), 1e-3),
    };
    s.apply = () => {
        actor.set_position(s.x.x - from.w / 2, s.y.x - from.h / 2);
        actor.set_scale(Math.max(0, s.k.x), Math.max(0, s.k.x));
    };
    s.apply();
    return s;
}

// the dropped icon goes into the target (pour exit) and the target gives (a kick) once it has; the target is looked up again
// when the kick lands (the Dock may have rebuilt it: a merge makes a folder in its place)
export function swallow(dragged, from, target, findTarget = () => target) {
    const to = rectOf(iconOf(target) ?? target);
    if (!full() || !from || !to) return false;
    const pic = pictureOf(dragged);
    if (!pic) return false;
    const f = flyer(pic, from);
    const pe = role('pour', { exit: true });
    f.x.set(to.x + to.w / 2, pe);
    f.y.set(to.y + to.h / 2, pe);
    f.k.set(DROP.swallowTo * to.w / Math.max(1, from.w), pe);
    let t = 0;
    const ticker = new Ticker(dt => {
        t += dt;
        f.x.step(dt);
        f.y.step(dt);
        f.k.step(dt);
        if (t >= DROP.swallowAfter) {
            pic.destroy();
            const now = findTarget();
            if (isActorAlive(now)) kick(now);
            return false;
        }
        f.apply();
        return true;
    });
    ticker.start();
    return true;
}

// a Dock icon let go in the Dock glides into its slot; the button (looked up every frame: the Dock may rebuild it) is hidden
// until the picture has landed
export function glideHome(dragged, from, findButton) {
    const btn0 = findButton();
    const to = rectOf(iconOf(btn0));
    if (!full() || !from || !to) return false;
    const pic = pictureOf(btn0 ?? dragged);
    if (!pic) return false;
    const f = flyer(pic, from);
    f.x.set(to.x + to.w / 2, role('glide'));
    f.y.set(to.y + to.h / 2, role('glide'));
    f.k.set(to.w / Math.max(1, from.w), role('bead'));
    let t = 0;
    let last = btn0;
    const land = () => {
        pic.destroy();
        if (isActorAlive(last)) last.opacity = 255;
    };
    if (isActorAlive(btn0)) btn0.opacity = 0;
    const ticker = new Ticker(dt => {
        t += dt;
        const btn = findButton();
        if (btn !== last && isActorAlive(last)) last.opacity = 255;
        last = btn;
        if (!isActorAlive(btn) || t > 3) {
            land();
            return false;
        }
        btn.opacity = 0;
        // the slot can still move (the magnifier settles, the Dock re-lays out): the springs take it with their speed
        const now = rectOf(iconOf(btn));
        if (now) {
            f.x.set(now.x + now.w / 2);
            f.y.set(now.y + now.h / 2);
            f.k.set(now.w / Math.max(1, from.w));
        }
        f.x.step(dt);
        f.y.step(dt);
        f.k.step(dt);
        f.apply();
        if (f.x.rest && f.y.rest && f.k.rest) {
            land();
            return false;
        }
        return true;
    });
    ticker.start();
    return true;
}

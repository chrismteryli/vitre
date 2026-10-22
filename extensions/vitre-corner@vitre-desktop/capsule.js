/* The corner capsule: a compact clear-glass capsule in the top-right corner of a monitor whose top bar is hidden, with the
 * time (the top bar's own clock string), the battery and a round button that opens the Control Center.
 *
 * Look: the Vitre glass of the HUD (glass.js: the desktop behind it blurred, cut to a capsule, the lit rim), with the
 * backdrop dimmed to BRIGHTNESS: a full-screen frame can be white right under the capsule, and white text needs the glass
 * under it dark enough for 4.5:1 there (measured in the rig: 0.5 gave 2.6 to 3.5:1 on a white frame, 0.38 gives about
 * 4.7:1). On a dark frame it reads as the same smoked glass as the top bar.
 * Size and place: inside the top bar's own 40 px band, 28 px high like the bar's highlight pills, its far edge 13 px from
 * the screen edge like the Control Center under it (vitre-controls GEO.rightMargin), so the Control Center opens 14 px
 * under the capsule exactly as it opens under the bar. Every position is snapped to the monitor's device-pixel grid
 * (1.5x on the laptop) so the text and the rim stay crisp.
 * Motion: the Vitre stretch (liquidDrip.js and dripMotion.js, the shared modules, unchanged): a glass bead appears on the
 * top edge above the button, the capsule's glass stretches out of it on the spring (400 ms period, damping 0.86) and lands
 * as the capsule; closing plays the same motion back into the corner. Animations off or reduced motion: it appears and
 * disappears in one frame. drip-style 'classic' (the vitre-menus setting): a short fade instead of the stretch. */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GlassLayer, GLASS_FINISH, MARGIN} from './glass.js';
import {DripController, motionAllowed, op255} from './liquidDrip.js';
import {DripStyle} from './dripStyle.js';
import {ControlsAnchor, CC_GAP} from './controls.js';
import {WindowDim} from './dim.js';
import {BatteryGlyph} from './batteryGlyph.js';

// logical px
export const GEOM = {
    height: 28,             // the top bar's highlight pills (40 px bar, 6 px transparent borders)
    top: 12,                // the capsule's bottom is the bar's bottom (40): the Control Center opens 14 px under it
    side: 13,               // the Control Center's own margin from the screen edge: both share their far edge
    padStart: 12,           // from the rounded end to the time
    gapTimeBattery: 12,
    batteryIcon: 16,        // the battery's box is as tall as the bar's 16 px status icons ...
    batteryWidth: 24,       // ... and wider: a 22 x 11.5 px body and its nub, drawn on the device grid (batteryGlyph.js)
    gapIconPercent: 3,
    gapBeforeButton: 8,
    button: 22,             // concentric with the capsule's rounded end: 3 px all round
    glyph: 14,
    holdPad: 12,            // the capsule stays while the pointer is this close to it, or anywhere between it and the corner
};
export const BRIGHTNESS = 0.38;      // the glass's backdrop is dimmed to this (1 = the HUD's clear finish); see the header
const FADE_IN_MS = 160;              // drip-style 'classic'
const FADE_OUT_MS = 120;
const CLICK_POLL_MS = 30;          // see _watchClicks
const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;

// The stretch's side: the shared controller (liquidDrip.js) drives the capsule through this, as hudDrip.js does for the HUD.
class CornerDripAdapter {
    constructor(capsule) {
        this._capsule = capsule;
        this.finish = GLASS_FINISH;
        this.brightness = BRIGHTNESS;    // the field's glass matches the capsule's own: the hand-over has no step
        this.handoffMs = 0;
        this.immediate = true;           // the geometry is known at open()
    }

    geometry() {
        const g = this._capsule._geo;
        if (!g || !this._capsule._actors)
            return null;
        return {
            pill: {...g.bead, keep: false},
            pieces: [{id: 'corner', x: g.x, y: g.y, w: g.w, h: g.h, r: g.h / 2, row: 0}],
        };
    }

    maskActor() {
        return this._capsule._actors?.root ?? null;
    }

    maskBox() {
        const g = this._capsule._geo;
        return g ? {x: g.x, y: g.y, w: g.w, h: g.h} : null;
    }

    begin() {
        const a = this._capsule._actors;
        if (!a)
            return;
        a.root.remove_all_transitions();
        a.root.opacity = 255;
        a.glass.actor.opacity = 0;
        a.content.opacity = 0;
    }

    setPiece(_id, {real, content}) {
        const a = this._capsule._actors;
        if (!a)
            return;
        a.glass.actor.opacity = op255(real);
        a.content.opacity = op255(content);
    }

    end() {
        const a = this._capsule._actors;
        if (!a)
            return;
        a.glass.actor.opacity = 255;
        a.content.opacity = 255;
    }
}

export class Capsule {
    constructor({iconPath, battery, onClosed, onMenuChanged, onDismiss}) {
        this._iconPath = iconPath;
        this._battery = battery;
        this._onClosed = onClosed;
        this._onMenuChanged = onMenuChanged;
        this._onDismiss = onDismiss;      // Esc or a click outside: the watcher decides how it goes
        this._actors = null;
        this._geo = null;
        this._corner = null;
        this._up = false;
        this._style = 'instant';
        this._clock = null;
        this._unredirect = false;
        this._escAction = 0;
        this._escName = null;
        this._clickPoll = 0;
        this._pressed = false;
        this._prewarmed = false;
        this._dim = new WindowDim();
        this._dripStyle = new DripStyle();
        this._drip = new DripController('corner', new CornerDripAdapter(this));
        this._drip.callbacks.onClosed = () => this._hideNow();
        this._anchor = new ControlsAnchor({onOpenChanged: open => this._menuChanged(open)});
    }

    // ---- state ------------------------------------------------------------------------------------------------------

    get isUp() {
        return this._up;
    }

    get monitorIndex() {
        return this._corner?.index ?? -1;
    }

    // the Control Center is open (or closing) from the button
    get menuActive() {
        return this._anchor.active;
    }

    get menuOpen() {
        return this._anchor.open;
    }

    // the pointer at (x, y) keeps the capsule: on it, near it, or between it and its corner
    holds(x, y) {
        const h = this._geo?.hold;
        return Boolean(h) && x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h;
    }

    contains(x, y) {
        const g = this._geo;
        return Boolean(g) && x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h;
    }

    // ---- actors -----------------------------------------------------------------------------------------------------

    _ensureActors() {
        if (this._actors)
            return;
        const root = new St.Widget({name: 'vitre-corner', reactive: true, visible: false, opacity: 0});
        const glass = new GlassLayer({radius: GEOM.height / 2, brightness: BRIGHTNESS});
        root.add_child(glass.actor);
        const content = new St.Widget({name: 'vitre-corner-content'});
        root.add_child(content);
        const time = new St.Label({style_class: 'vitre-corner-time', text: ' '});
        time.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const battery = new BatteryGlyph({style_class: 'vitre-corner-battery', width: GEOM.batteryWidth, height: GEOM.batteryIcon});
        const percent = new St.Label({style_class: 'vitre-corner-percent', text: ' '});
        percent.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const glyph = new St.Icon({style_class: 'vitre-corner-glyph', icon_size: GEOM.glyph,
            gicon: Gio.icon_new_for_string(`${this._iconPath}/icons/vitre-corner-controls-symbolic.svg`)});
        const button = new St.Button({style_class: 'vitre-corner-button', child: glyph, can_focus: true,
            track_hover: true, reactive: true, accessible_name: 'Control Center'});
        button.set_size(GEOM.button, GEOM.button);
        button.set_style(`border-radius: ${GEOM.button / 2}px;`);
        // the Control Center opens CC_GAP under the capsule, as it opens under the bar
        button.connectObject('clicked', () => this._anchor.toggle(button, {minTop: this._geo ? this._geo.y + this._geo.h + CC_GAP : null}), this);
        for (const child of [time, battery, percent, button])
            content.add_child(child);
        // above the windows and the top bar, under modal dialogs; the Control Center raises itself above it when it opens
        const dialogs = Main.layoutManager.modalDialogGroup;
        if (dialogs && dialogs.get_parent() === Main.uiGroup)
            Main.uiGroup.insert_child_below(root, dialogs);
        else
            Main.uiGroup.add_child(root);
        // the shell takes uiGroup down at shutdown: never touch these afterwards
        root.connectObject('destroy', () => {
            this._actors = null;
            this._up = false;
        }, this);
        this._actors = {root, glass, content, time, battery, percent, button, glyph};
    }

    // build the actors and the stretch's field ahead of the first use (the first shader compile is a visible hitch)
    prewarm() {
        this._ensureActors();
        if (this._prewarmed)
            return;
        this._prewarmed = true;
        try {
            if (this._dripStyle.liquid)
                this._drip._prewarm(5);
        } catch (_e) {
            // the first stretch builds it instead
        }
    }

    // ---- content and layout -----------------------------------------------------------------------------------------

    _setTime() {
        if (!this._actors)
            return;
        const text = (this._clock?.clock ?? '').trim();
        if (this._actors.time.text !== text) {
            this._actors.time.text = text;
            if (this._up)
                this._layout();
        }
    }

    _startClock() {
        if (this._clock)
            return;
        this._clock = new GnomeDesktop.WallClock();
        this._clock.connectObject('notify::clock', () => this._setTime(), this);
        this._setTime();
    }

    _stopClock() {
        if (!this._clock)
            return;
        this._clock.disconnectObject(this);
        this._clock.run_dispose();
        this._clock = null;
    }

    // the battery changed (or appeared): only drawn while the capsule is up
    batteryChanged() {
        if (this._up && this._actors)
            this._layout();
    }

    _syncBattery() {
        const a = this._actors;
        const info = this._battery?.info ?? null;
        this._batteryInfo = info;
        a.battery.visible = Boolean(info);
        a.percent.visible = Boolean(info);
        if (!info)
            return;
        a.battery.setState(info);
        a.battery._vitreIcon = info.iconName;       // GNOME's icon name for the same state (the rig compares it)
        if (a.percent.text !== info.text)
            a.percent.text = info.text;
        let name = `Battery ${info.text}`;
        if (info.charged)
            name += ', charged';
        else if (info.charging)
            name += ', charging';
        else if (info.power === 'plugged')
            name += ', plugged in, not charging';
        else if (info.low)
            name += ', low';
        // time left only on battery, time to full only while charging
        const minutes = info.charging || !info.power ? Math.round((info.charging ? info.timeToFull : info.timeToEmpty) / 60) : 0;
        if (minutes > 0) {
            const h = Math.floor(minutes / 60);
            const span = `${h ? `${h} h ` : ''}${minutes % 60} min`;
            name += info.charging ? `, full in ${span}` : `, ${span} left`;
        }
        a.percent.accessible_name = name;
    }

    // Lay the capsule out on its corner. Logical px; every position on the monitor's device-pixel grid.
    _layout() {
        const a = this._actors;
        const c = this._corner;
        if (!a || !c)
            return;
        this._syncBattery();
        const s = c.scale > 0 ? c.scale : 1;
        const snap = v => Math.round(v * s) / s;
        const G = GEOM;
        const H = G.height;
        const nat = actor => {
            const [, w] = actor.get_preferred_width(-1);
            const [, h] = actor.get_preferred_height(w);
            return [w, h];
        };
        const items = [];
        let x = G.padStart;
        const [tw, th] = nat(a.time);
        items.push([a.time, x, (H - th) / 2]);
        x += tw;
        if (this._batteryInfo) {
            x += G.gapTimeBattery;
            items.push([a.battery, x, (H - G.batteryIcon) / 2]);
            x += G.batteryWidth + G.gapIconPercent;
            const [pw, ph] = nat(a.percent);
            items.push([a.percent, x, (H - ph) / 2]);
            x += pw;
        }
        x += G.gapBeforeButton;
        const inset = (H - G.button) / 2;
        items.push([a.button, x, inset]);
        const w = snap(x + G.button + inset);
        const rtl = c.rtl;
        for (const [actor, ix, iy] of items) {
            const [aw] = actor === a.button ? [G.button] : nat(actor);
            actor.set_position(snap(rtl ? w - ix - aw : ix), snap(iy));
        }
        const right = c.x + c.width;
        const gx = snap(rtl ? c.x + G.side : right - G.side - w);
        const gy = snap(c.y + G.top);
        a.root.set_position(gx, gy);
        a.root.set_size(w, H);
        a.content.set_position(0, 0);
        a.content.set_size(w, H);
        a.glass.actor.set_position(-MARGIN, -MARGIN);
        a.glass.actor.set_size(w + 2 * MARGIN, H + 2 * MARGIN);
        a.glass.radius = H / 2;
        a.glass.sync(w, H, gx - MARGIN, gy - MARGIN);
        // the stretch leaves from a bead on the top edge, centred over the button (half of it above the screen)
        const bx = rtl ? gx + H / 2 : gx + w - H / 2;
        const pad = G.holdPad;
        this._geo = {
            x: gx, y: gy, w, h: H, scale: s,
            bead: {x: bx - H / 2, y: c.y - H / 2, w: H, h: H},
            hold: rtl
                ? {x: c.x, y: c.y, w: gx + w + pad - c.x, h: gy + H + pad - c.y}
                : {x: gx - pad, y: c.y, w: right - (gx - pad), h: gy + H + pad - c.y},
        };
    }

    // ---- open / close -----------------------------------------------------------------------------------------------

    open(corner) {
        this._ensureActors();
        const a = this._actors;
        if (this._up && this._corner?.index === corner.index) {
            // a new trigger while it is leaving turns it around from where it is
            if (this._drip.phase === 'closing')
                this._drip.open();
            else if (this._style === 'fade' && a.root.get_transition('opacity'))
                this._fade(true);
            return;
        }
        if (this._up)
            this.close(true);
        this._corner = corner;
        this._startClock();
        this._layout();
        this._holdUnredirect();
        this._grabEscape();
        this._watchClicks();
        this._up = true;
        a.root.show();
        this._style = !motionAllowed() ? 'instant' : this._dripStyle.liquid ? 'stretch' : 'fade';
        if (this._style === 'stretch') {
            a.root.opacity = 255;
            this._drip.open();
            return;
        }
        if (this._style === 'fade') {
            a.root.opacity = 0;
            this._fade(true);
            return;
        }
        a.root.remove_all_transitions();
        a.root.opacity = 255;
        a.glass.actor.opacity = 255;
        a.content.opacity = 255;
        // a capsule shown at once is a settled surface for the controller: if motion is back on by the time it leaves, it stretches out
        if (this._dripStyle.liquid)
            this._drip.markOpen();
    }

    // instant: no motion (the top bar is coming back, the monitor changed, the extension is going away)
    close(instant = false) {
        if (!this._up)
            return;
        if (this._anchor.active)
            this._anchor.closeNow();
        if (instant || !motionAllowed() || !this._actors) {
            this._drip.reset();
            this._hideNow();
            return;
        }
        if (this._drip.phase !== 'closed') {
            if (this._drip.phase === 'closing')
                return;
            if (this._dripStyle.liquid) {
                this._drip.close();
                return;
            }
            this._drip.reset();
        }
        this._style = 'fade';
        this._fade(false);
    }

    _fade(show) {
        const root = this._actors.root;
        root.remove_all_transitions();
        root.ease({
            opacity: show ? 255 : 0,
            duration: show ? FADE_IN_MS : FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!show && this._up && this._actors && root.opacity === 0)
                    this._hideNow();
            },
        });
    }

    _hideNow() {
        const wasUp = this._up;
        this._up = false;
        this._ungrabEscape();
        this._unwatchClicks();
        this._releaseUnredirect();
        this._stopClock();
        this._dim.undim(true);
        const a = this._actors;
        if (a) {
            a.root.remove_all_transitions();
            a.root.hide();
            a.root.opacity = 0;
            a.glass.actor.opacity = 255;
            a.content.opacity = 255;
            a.button.remove_style_pseudo_class('checked');
        }
        if (wasUp)
            this._onClosed?.();
    }

    _menuChanged(open) {
        const button = this._actors?.button;
        if (button) {
            if (open)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        // the full-screen window steps back while the Control Center is over it (dim.js)
        try {
            if (open && this._up && this._corner)
                this._dim.dim(this._corner.index);
            else
                this._dim.undim();
        } catch (e) {
            console.error(`Vitre Corner: dim: ${e.message}`);
            this._dim.undim(true);
        }
        this._onMenuChanged?.(open);
    }

    // ---- while it is up ---------------------------------------------------------------------------------------------

    // GNOME's own OSD does the same: a full-screen window that is scanned out directly would hide the capsule
    _holdUnredirect() {
        if (this._unredirect)
            return;
        global.compositor.disable_unredirect();
        this._unredirect = true;
    }

    _releaseUnredirect() {
        if (!this._unredirect)
            return;
        global.compositor.enable_unredirect();
        this._unredirect = false;
    }

    // Esc dismisses the capsule while it is up. Allowed in the normal desktop mode only: with the Control Center open, Esc
    // is the menu's (it closes the menu first, a second Esc the capsule).
    _grabEscape() {
        if (this._escAction)
            return;
        try {
            const action = global.display.grab_accelerator('Escape', Meta.KeyBindingFlags.NONE);
            if (!action || action === Meta.KeyBindingAction.NONE)
                return;
            this._escAction = action;
            this._escName = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(this._escName, Shell.ActionMode.NORMAL);
            global.display.connectObject('accelerator-activated', (_d, activated) => {
                if (activated === this._escAction)
                    this._onDismiss?.('escape');
            }, this);
        } catch (e) {
            this._escAction = 0;
            console.warn(`Vitre Corner: Esc is not available (${e.message})`);
        }
    }

    _ungrabEscape() {
        if (!this._escAction)
            return;
        try {
            global.display.disconnectObject(this);
            global.display.ungrab_accelerator(this._escAction);
            Main.wm.allowKeybinding(this._escName, Shell.ActionMode.NONE);
        } catch (_e) {
            // the display is going away
        }
        this._escAction = 0;
        this._escName = null;
    }

    // A press that starts outside the capsule dismisses it, and the press itself still goes to whatever is under it: this
    // only looks. A full-screen app's window gets its presses from the compositor directly: neither the stage's
    // captured-event nor a Clutter event filter sees them (measured in the rig; mutter's own filter runs first and hands
    // them to the app). So while the capsule is up, and only then, the pointer's button state is read every
    // CLICK_POLL_MS: a click or a touchpad tap holds the button for longer than that.
    _watchClicks() {
        if (this._clickPoll)
            return;
        this._pressed = (global.get_pointer()[2] & BUTTONS) !== 0;     // a press held from before does not count
        this._clickPoll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLICK_POLL_MS, () => {
            try {
                this._checkPress();
            } catch (_e) {
                // never worth more than a missed dismissal
            }
            return this._clickPoll ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._clickPoll, '[vitre-corner] press');
    }

    _checkPress() {
        const [x, y, mods] = global.get_pointer();
        const down = (mods & BUTTONS) !== 0;
        if (!down) {
            this._pressed = false;
            return;
        }
        if (this._pressed)
            return;
        this._pressed = true;
        if (this._up && !this._anchor.active && !this.contains(x, y))
            this._onDismiss?.('click');
    }

    _unwatchClicks() {
        const id = this._clickPoll;
        this._clickPoll = 0;
        if (id)
            GLib.source_remove(id);
    }

    // ---- rig ----------------------------------------------------------------------------------------------------------

    snapshot() {
        const a = this._actors;
        const ext = actor => {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            return {x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100};
        };
        return {
            up: this._up, style: this._style, monitor: this.monitorIndex, phase: this._drip.phase,
            geo: this._geo ? {x: this._geo.x, y: this._geo.y, w: this._geo.w, h: this._geo.h, bead: this._geo.bead, hold: this._geo.hold} : null,
            built: Boolean(a),
            root: a ? {visible: a.root.visible, mapped: a.root.mapped, opacity: a.root.opacity, ...ext(a.root)} : null,
            glassOp: a?.glass.actor.opacity ?? null, contentOp: a?.content.opacity ?? null,
            time: a?.time.text ?? null, percent: a?.percent.visible ? a.percent.text : null,
            battery: a?.battery.visible ? (a.battery._vitreIcon ?? null) : null,
            glyph: a?.battery.visible ? a.battery.state : null,
            batteryName: a?.percent.visible ? a.percent.accessible_name : null,
            button: a ? {...ext(a.button), checked: a.button.has_style_pseudo_class('checked'), hover: a.button.hover} : null,
            menuActive: this._anchor.active, menuOpen: this._anchor.open, bridged: this._anchor.bridged, ccShift: this._anchor.shift,
            esc: Boolean(this._escAction), clicks: Boolean(this._clickPoll), unredirect: this._unredirect, clock: Boolean(this._clock),
            dimmed: this._dim.dimmed,
            drip: this._drip.snapshot(),
        };
    }

    // the stretch's controller, for the rig's film (manual clock, measure modes)
    get drip() {
        return this._drip;
    }

    get pressedButtons() {
        return BUTTONS;
    }

    destroy() {
        this._anchor.destroy();
        this._dim.destroy();
        this._drip.callbacks.onClosed = null;
        this._drip.destroy();
        this._dripStyle.destroy();
        this._ungrabEscape();
        this._unwatchClicks();
        this._releaseUnredirect();
        this._stopClock();
        const a = this._actors;
        this._actors = null;
        this._up = false;
        if (a) {
            a.root.disconnectObject(this);
            a.button.disconnectObject(this);
            a.root.remove_all_transitions();
            a.glass.destroy();
            a.root.destroy();
        }
        this._onClosed = null;
        this._onMenuChanged = null;
        this._onDismiss = null;
    }
}

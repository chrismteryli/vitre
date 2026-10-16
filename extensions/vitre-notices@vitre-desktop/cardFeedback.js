/* Notification Center hover and click feedback (plan A13). Constants live in feedback.js.
 *  - CardFeedback    : every notification card: its hover buttons (close "x", expand) fade in over 120 ms when
 *                      the pointer is over the card; pressing the card scales it and brightens its glass.
 *  - installStackMotion: a notification stack expands and collapses on the Notification Center slide curve
 *                      (fast start, decelerating, no overshoot) instead of GNOME's 200 ms ease-out-quad.
 * ESTIMATES: the reference's own text describes the behaviour; no motion constants were measured. */
import {NotificationMessageGroup} from 'resource:///org/gnome/shell/ui/messageList.js';

import {FB, Tween, PressResponse, bindPress, centrePivot, setScale, pressGrow} from './feedback.js';
import {CURVE, curve} from './helpers.js';

export class CardFeedback {
    // message: the notification card (St.Button); layer: its GlassLayer; holders: the faders around the
    // hover buttons (close, expand); buttons: those two buttons (they get the same press response)
    constructor(message, layer, holders, buttons, journal) {
        this.kind = 'card';
        this._message = message;
        this._layer = layer;
        this._holders = holders;
        this._buttons = buttons.map(button => {
            centrePivot([button]);
            const press = new PressResponse(button, p => {
                const [w, h] = button.get_size();
                setScale([button], 1 + pressGrow(w, h) * p);
                // the hover look of these buttons is rgba(160, 160, 168, 0.7): a pressed one is 8 % more opaque
                if (p > 0)
                    button.set_style(`background-color: rgba(160, 160, 168, ${Math.min(1, 0.7 + FB.pressTintBoost * p).toFixed(3)}) !important;`);
                else
                    button.set_style(null);
            }, 'press:cardbutton');
            bindPress(button, press);
            return {button, press};
        });
        for (const h of holders)
            h.opacity = 0;
        this._fade = new Tween(message, v => {
            for (const h of holders)
                h.opacity = Math.round(255 * v);
        }, 0, 'xfade');
        message.connectObject('notify::hover', () => {
            this._fade.to(message.hover ? 1 : 0, FB.xFadeMs, 'linear');
        }, this);

        centrePivot([message]);
        this._press = new PressResponse(message, p => {
            const [w, h] = message.get_size();
            setScale([message], 1 + pressGrow(w, h) * p);
            layer.setTint(layer.baseTint + FB.pressTintBoost * p);
        }, 'press:card');
        bindPress(message, this._press);
        journal.add(() => {
            for (const {button, press} of this._buttons) {
                press.destroy();
                button.disconnectObject(press);
                button.set_pivot_point(0, 0);
                button.scale_x = 1;
                button.scale_y = 1;
                button.set_style(null);
            }
            this._fade.destroy();
            this._press.destroy();
            message.disconnectObject(this);
            message.disconnectObject(this._press);
            message.set_pivot_point(0, 0);
            message.scale_x = 1;
            message.scale_y = 1;
            layer.setTint(layer.baseTint);
        });
    }

    reset() {
        this._fade.set(0);
        this._press.tween.set(0);
        for (const {press} of this._buttons)
            press.tween.set(0);
    }

    snapshot() {
        const [x, y] = this._message.get_transformed_position();
        const [w, h] = this._message.get_transformed_size();
        return {hover: this._message.hover, fade: this._fade.value, holderOp: this._holders.map(h => h.opacity),
            pressP: this._press.p, scale: this._message.scale_x, tint: this._layer._tint, x, y, w, h,
            buttons: this._buttons.map(({press, button}) => ({p: press.p, scale: button.scale_x}))};
    }
}

/* ---- stack expand / collapse ------------------------------------------------------------------ */
const tweens = new WeakMap();

function drive(group, target) {
    const layout = group.layout_manager;
    let tween = tweens.get(group);
    if (!tween) {
        tween = new Tween(group, v => { layout.expansion = v; }, layout.expansion, 'stack');
        tweens.set(group, tween);
    }
    return new Promise(resolve => {
        tween.to(target, FB.stackMs, p => curve(p * CURVE.DURATION), resolve);
    });
}

export function installStackMotion(journal, isActive) {
    const proto = NotificationMessageGroup.prototype;
    if (typeof proto.expand !== 'function' || typeof proto.collapse !== 'function')
        throw new Error('Unsupported notification group');
    for (const name of ['expand', 'collapse']) {
        journal.method(proto, name, original => function () {
            if (!isActive())
                return original.call(this);
            // GNOME's expand()/collapse() ease '@layout.expansion' in their synchronous part: hand that one
            // call to our tween, leave everything else (header, cover, focus, pseudo-classes) to GNOME.
            const own = Object.getOwnPropertyDescriptor(this, 'ease_property_async');
            this.ease_property_async = (_property, value) => drive(this, value);
            try {
                return original.call(this);
            } finally {
                if (own)
                    Object.defineProperty(this, 'ease_property_async', own);
                else
                    delete this.ease_property_async;
            }
        });
    }
}

/* Every other GNOME dialog in the Vitre glass (B16, 2026-10-15): Run (Alt+F2), password prompts (polkit, keyring, network secrets), "not responding",
 * mount and extension dialogs. Each gets the end-session dialog's look (the ink glass card, glass pills, class vitre-es)
 * and its drip (EsDrip: a glass bar under the top bar pulls a drop that falls and blooms into the card; the reverse on close).
 *
 * The only hook is ModalDialog.prototype.open, which calls the original after attaching the skin; nothing of a dialog's own
 * behaviour (keys, focus, buttons, its D-Bus) is touched. The end-session dialog keeps its own skin (endStyle.js).
 */
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {EsDrip, ES_BLUR, ES_BRIGHTNESS, ES_FINISH} from './endStyle.js';
import {GlassSheet} from './sessionDrip.js';

class DialogSkin {
    constructor(dialog, style) {
        this.dialog = dialog;
        this.style = style;
        this.card = dialog.dialogLayout._dialog;
        this.dead = false;
        this.failed = false;
        this.drip = new EsDrip(this);
        this._spare = null;
    }

    build() {
        const d = this.dialog;
        this.card.add_style_class_name('vitre-es');
        d.connectObject('notify::state', () => this._onState(), 'destroy', () => this.style.forget(this), this);
        d.dialogLayout.connectObject('notify::opacity', () => this.drip.followOpacity(d.dialogLayout.opacity / 255), this);
        this.card.connectObject('notify::allocation', () => {
            try {
                this.drip.refit();
            } catch (_e) {
                // the glass keeps its last shape
            }
        }, this);
    }

    _onState() {
        if (this.dead || this.failed)
            return;
        try {
            switch (this.dialog.state) {
            case ModalDialog.State.OPENING:
                this.drip.open();
                break;
            case ModalDialog.State.CLOSING:
                this.drip.close();
                break;
            case ModalDialog.State.CLOSED:
                if (!this.drip.busy)
                    this.drip._settleWithoutMotion();
                break;
            default:
                break;
            }
        } catch (e) {
            this.failed = true;
            console.error(`Vitre Session: dialog drip failed, plain card kept: ${e.message}`);
            try {
                this.drip._abort('error');
            } catch (_e) {
                // nothing more to do
            }
        }
    }

    _makeSheet(box) {
        return new GlassSheet({
            parent: Main.uiGroup, below: Main.layoutManager.modalDialogGroup, box, finish: ES_FINISH,
            blurRadius: ES_BLUR, brightness: ES_BRIGHTNESS, name: 'vitre-dialog-glass',
        });
    }

    takeSheet(box) {
        let sheet = this._spare;
        this._spare = null;
        if (!sheet || sheet.dead)
            sheet = this._makeSheet(box);
        sheet.use(box);
        return sheet;
    }

    releaseSheet(sheet) {
        if (sheet.dead)
            return;
        sheet.release();
        sheet.setOpacity(0);
        if (!this._spare && !this.dead) {
            sheet.park();
            this._spare = sheet;
        } else {
            sheet.destroy();
        }
    }

    destroy() {
        if (this.dead)
            return;
        this.dead = true;
        try {
            this.drip.destroy();
        } catch (_e) {
            // keep restoring
        }
        this._spare?.destroy();
        this._spare = null;
        try {
            this.dialog.disconnectObject(this);
            this.dialog.dialogLayout.disconnectObject(this);
            this.card.disconnectObject(this);
            this.card.remove_style_class_name('vitre-es');
            this.card.remove_style_class_name('vitre-es-glass');
            this.card.opacity = 255;
        } catch (_e) {
            // the dialog is gone
        }
        delete this.dialog._vitreSkin;
    }
}

export class DialogStyle {
    constructor({dir, motion}) {
        this.dir = dir;
        this.motion = motion;
        this._skins = new Set();
        this._injections = null;
    }

    enable() {
        this._injections = new InjectionManager();
        const self = this;
        this._injections.overrideMethod(ModalDialog.ModalDialog.prototype, 'open', original => function (...args) {
            try {
                self._adopt(this);
            } catch (e) {
                console.warn(`Vitre Session: a dialog kept GNOME's look (${e.message})`);
            }
            return original.apply(this, args);
        });
    }

    disable() {
        this._injections?.clear();
        this._injections = null;
        for (const skin of [...this._skins])
            skin.destroy();
        this._skins.clear();
    }

    forget(skin) {
        skin.destroy();
        this._skins.delete(skin);
    }

    _adopt(dialog) {
        if (dialog._vitreSkin || dialog === Main.endSessionDialog || !dialog.dialogLayout?._dialog)
            return;
        // the lock screen and the greeter keep their own look
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            return;
        const skin = new DialogSkin(dialog, this);
        dialog._vitreSkin = skin;
        try {
            skin.build();
        } catch (e) {
            skin.destroy();
            throw e;
        }
        this._skins.add(skin);
    }
}

void GLib;

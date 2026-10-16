/* Vitre Session (plans I3 + I5): the Vitre glass look for GNOME's lock screen (UnlockDialog) and end-session dialog
 * (Log Out / Restart / Power Off). See lockStyle.js and endStyle.js.
 *
 * It runs in the `user` and the `unlock-dialog` session modes (the lock screen is a session mode of its own: an
 * extension that only declares `user` is switched off the moment the screen locks). Each of the two surfaces is
 * enabled on its own inside try/catch: if one cannot be installed, the other still works and the failing one is
 * simply GNOME's stock dialog. disable() restores every method it replaced and removes everything it added.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {motionFromTokens} from './vitreMotion.js';
import {LockStyle} from './lockStyle.js';
import {EndStyle} from './endStyle.js';
import {DialogStyle} from './dialogStyle.js';

function readTokens(dir) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(GLib.build_filenamev([dir, 'assets', 'tokens.json'])).load_contents(null);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch (_e) {
        return null;        // vitreMotion.js carries the same numbers as fallback
    }
}

export default class VitreSession extends Extension {
    enable() {
        this.enableCount = (this.enableCount ?? 0) + 1;      // rig: the manager must not enable us again on a session-mode change
        const tokens = readTokens(this.path);
        this._motion = motionFromTokens(tokens);
        this._tokens = tokens;
        this.lock = null;
        this.end = null;
        this.dialogs = null;
        const opts = {dir: this.path, motion: this._motion};
        try {
            this.lock = new LockStyle(opts);
            this.lock.enable();
        } catch (e) {
            console.error(`Vitre Session: lock screen skin not installed, stock lock screen stays: ${e.message}\n${e.stack ?? ''}`);
            try {
                this.lock?.disable();
            } catch (_e) {
                // nothing more to do
            }
            this.lock = null;
        }
        try {
            this.end = new EndStyle(opts);
            this.end.enable();
        } catch (e) {
            console.error(`Vitre Session: end-session skin not installed, stock dialog stays: ${e.message}\n${e.stack ?? ''}`);
            try {
                this.end?.disable();
            } catch (_e) {
                // nothing more to do
            }
            this.end = null;
        }
        // B16: every other dialog in the same glass and drip
        try {
            this.dialogs = new DialogStyle(opts);
            this.dialogs.enable();
        } catch (e) {
            console.error(`Vitre Session: dialog skin not installed, stock dialogs stay: ${e.message}`);
            try {
                this.dialogs?.disable();
            } catch (_e) {
                // nothing more to do
            }
            this.dialogs = null;
        }
    }

    disable() {
        for (const part of [this.dialogs, this.lock, this.end]) {
            try {
                part?.disable();
            } catch (e) {
                console.error(`Vitre Session: error while restoring: ${e.message}`);
            }
        }
        this.lock = null;
        this.end = null;
        this.dialogs = null;
        this._motion = null;
        this._tokens = null;
    }
}

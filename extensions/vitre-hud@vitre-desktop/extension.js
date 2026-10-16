/* Menu-bar HUD: volume, brightness and keyboard-backlight changes appear as the reference design's glass
 * capsule under the top bar instead of GNOME's centred bottom OSD (plan A15).
 *
 * Hook: Main.osdWindowManager._showOsdWindow(monitor, icon, label, level, maxLevel) is the one
 * method every OSD path ends in (show / showOne / showAll, the ShowOSD D-Bus call from
 * gsd-media-keys and gsd-power, the shell's own brightness manager, scrolling over the volume
 * indicator). The replacement is an own property of the manager object; disable() removes it, so
 * GNOME's prototype method is back exactly. Extensions that replace show / showOne / showAll
 * on the manager (Just Perfection's "OSD off") sit above this method, so their no-ops still win
 * (read from their source; not run in the rig).
 *
 * Everything that is not a volume / brightness / keyboard-backlight OSD with a level, and every
 * OSD for a monitor other than the primary one (the top bar lives there), goes to GNOME's OSD
 * untouched. While the Control Center is open nothing is shown: its own sliders move live.
 */
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MenubarHud} from './hud.js';
import {classifyOsd, iconNamesOf} from './osd.js';

export default class MenubarHudExtension extends Extension {
    enable() {
        const manager = Main.osdWindowManager;
        if (!manager || typeof manager._showOsdWindow !== 'function')
            throw new Error('Menu-bar HUD requires the GNOME 51 OsdWindowManager._showOsdWindow');
        this._manager = manager;
        this._hud = new MenubarHud();
        const hud = this._hud;
        const original = manager._showOsdWindow;
        this._ownDescriptor = Object.getOwnPropertyDescriptor(manager, '_showOsdWindow') ?? null;
        this._replacement = function (monitorIndex, icon, label, level, maxLevel) {
            if (monitorIndex === Main.layoutManager.primaryIndex) {
                const media = classifyOsd(iconNamesOf(icon), level);
                if (media) {
                    if (hud.blocked())
                        return undefined;
                    hud.show({kind: media.kind, iconName: media.iconName, level, maxLevel});
                    return undefined;
                }
            }
            return original.call(this, monitorIndex, icon, label, level, maxLevel);
        };
        manager._showOsdWindow = this._replacement;
    }

    disable() {
        const manager = this._manager;
        // Do not undo a later replacement made by someone else.
        if (manager && manager._showOsdWindow === this._replacement) {
            if (this._ownDescriptor)
                Object.defineProperty(manager, '_showOsdWindow', this._ownDescriptor);
            else
                delete manager._showOsdWindow;
        }
        this._hud?.destroy();
        this._hud = null;
        this._manager = null;
        this._replacement = null;
        this._ownDescriptor = null;
    }
}

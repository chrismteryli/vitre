// Vitre Tray: tray items that are gone before their icon loads.
//
// What happens (2026-10-31, found with the session journal): an Electron app that loses its single-instance lock still builds its
// tray item before it quits (Claude Desktop does this on every notification click and Dock click: its nativeTheme "updated"
// handler creates the tray in an instance that is already exiting). Chromium writes the icon into a private folder in /tmp,
// registers a StatusNotifierItem, and removes the folder a moment later when the process exits. Ubuntu AppIndicators has by then
// put a button in the top bar (visible at once, showing GNOME's "loading" glyph) and looks the icon up in a folder that no longer
// exists: "Impossible to lookup icon for 'status_icon_0' in /tmp/org.chromium.Chromium.XXXXXX", the glyph stays about a second
// until the bus name goes, and now and then the owner vanishes while its properties are read and the extension's own error
// handler fails with "TypeError: can't access property "forEach", this.get_cached_property_names() is null".
//
// What this does, on top of the system extension, nothing of it edited (every patch is undone by disable()):
//   1. A new tray button stays invisible and takes no room until its icon has loaded (gicon or content). It is NOT hidden: Ubuntu
//      AppIndicators loads an icon only once its actor is mapped, so a hidden button would never get one. If no icon has come
//      after GRACE_MS the button is shown as Ubuntu AppIndicators would have shown it, so an item whose icon cannot be found
//      is still reachable.
//   2. An icon lookup in a folder that is already gone returns "no icon" without the warning.
//   3. refreshAllProperties() on an owner that vanished ends as a cancelled setup, not as a TypeError.
// Nothing else of the system extension is changed.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const TAG = '[vitre-tray]';
const APPINDICATOR_UUID = 'ubuntu-appindicators@ubuntu.com';
const GRACE_MS = 1500;

export default class VitreTray extends Extension {
    enable() {
        this._enabled = true;
        this._inj = new InjectionManager();
        this._holds = new Set();
        this.patched = false;
        this._patch().catch(e => console.error(`${TAG} not patched: ${e.message}`));
    }

    disable() {
        this._enabled = false;
        for (const hold of [...this._holds])
            hold.release();
        this._holds.clear();
        this._inj?.clear();
        this._inj = null;
        this.patched = false;
        console.log(`${TAG} disabled`);
    }

    async _patch() {
        const ext = Main.extensionManager.lookup(APPINDICATOR_UUID);
        if (!ext?.dir) {
            console.log(`${TAG} ${APPINDICATOR_UUID} is not installed: nothing to guard`);
            return;
        }
        const base = ext.dir.get_uri();
        // the same module URLs the system extension itself loads: one module instance, so the prototypes are the live ones
        const [{AppIndicatorProxy, IconActor}, {IndicatorStatusIcon}] = await Promise.all([
            import(`${base}/appIndicator.js`), import(`${base}/indicatorStatusIcon.js`)]);
        if (!this._enabled || !this._inj)
            return;
        const inj = this._inj;
        const holds = this._holds;

        // 1. hold a new button hidden until its icon has loaded
        inj.overrideMethod(IndicatorStatusIcon.prototype, '_init', original => function (...args) {
            original.apply(this, args);
            try {
                holdUntilIcon(this, holds);
            } catch (e) {
                console.error(`${TAG} could not hold a tray button: ${e.message}`);
            }
        });
        inj.overrideMethod(IndicatorStatusIcon.prototype, '_updateStatus', original => function (...args) {
            if (this._vitreHold)
                return undefined;       // applied when the hold ends (the release runs _showIfReady, which runs this)
            return original.apply(this, args);
        });

        // 2. no lookup, no warning, in an icon folder that is already gone
        inj.overrideMethod(IconActor.prototype, '_getIconData', original => function (name, themePath, ...rest) {
            if (name && name[0] !== '/' && themePath && !GLib.file_test(themePath, GLib.FileTest.IS_DIR))
                return {iconInfo: null, file: null, name: null};
            return original.call(this, name, themePath, ...rest);
        });

        // 3. an owner that vanishes while its properties are read: a cancelled setup, not a TypeError
        inj.overrideMethod(AppIndicatorProxy.prototype, 'refreshAllProperties', original => async function (...args) {
            try {
                return await original.apply(this, args);
            } catch (e) {
                if (e instanceof TypeError && /get_cached_property_names|forEach/.test(String(e.message)))
                    throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'the owner vanished');
                throw e;
            }
        });

        this.patched = true;
        console.log(`${TAG} enabled`);
    }
}

// keep `btn` (an IndicatorStatusIcon) invisible and out of the layout until its icon actor has an icon, for at most GRACE_MS.
// The button stays visible to GNOME (and so mapped, which is what makes the extension load its icon); it is transparent, takes no
// input and is zero wide: the container is 0 wide and the theme's horizontal padding is 0 while it is held.
const HELD_STYLE = '-natural-hpadding: 0px; -minimum-hpadding: 0px';

function holdUntilIcon(btn, holds) {
    const icon = btn._icon;
    if (!icon || !btn.container)
        return;
    const settled = () => Boolean(icon.gicon || icon.content);
    if (settled())
        return;
    const savedStyle = btn.get_style();
    btn._vitreHold = true;
    btn.opacity = 0;
    btn.reactive = false;
    btn.set_style(HELD_STYLE);
    btn.container.width = 0;
    let timer = 0;
    const hold = {
        release() {
            if (!btn._vitreHold)
                return;
            btn._vitreHold = false;
            holds.delete(hold);
            if (timer) {
                GLib.source_remove(timer);
                timer = 0;
            }
            try {
                icon.disconnectObject(btn);
                btn.container.width = -1;
                btn.set_style(savedStyle);
                // the theme's padding is read from the style, which does not by itself drop the sizes Clutter has cached for the
                // button: without this a button released by the timer (no icon ever came) keeps the zero-padding width it had
                btn.queue_relayout();
                btn.reactive = true;
                btn._updateOpacity();       // the extension's own opacity rule (icon-opacity setting)
                btn._showIfReady();         // label, status and menu, as they would have been
            } catch (_e) {
                // the button is already gone
            }
        },
    };
    holds.add(hold);
    icon.connectObject(
        'notify::gicon', () => settled() && hold.release(),
        'notify::content', () => settled() && hold.release(),
        btn);
    btn.connect('destroy', () => {
        btn._vitreHold = false;
        holds.delete(hold);
        if (timer) {
            GLib.source_remove(timer);
            timer = 0;
        }
    });
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GRACE_MS, () => {
        timer = 0;
        hold.release();
        return GLib.SOURCE_REMOVE;
    });
}

// Vitre Appearance (roadmap B6): light and dark on a schedule with the matching wallpaper, and the accent colour for
// GTK 3 apps. The accent itself is GNOME's own key (org.gnome.desktop.interface accent-color): libadwaita apps and the
// shell theme (-st-accent-color) follow it live by themselves; stylesheet.css adds it to the Vitre surfaces that had a
// fixed highlight (Search, the app switcher).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppearanceController, defaultFileExists, defaultThemeExists} from './controller.js';
import {LocationSource} from './location.js';

const clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.min(ms, 2 ** 31 - 1), () => {
        fn();
        return GLib.SOURCE_REMOVE;
    }),
    clearTimeout: id => GLib.source_remove(id),
};

export default class VitreAppearance extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._controller = null;
        // a style class on the shell's UI group while the style is light, so stylesheet.css can keep clear glass legible
        // over the light wallpaper (the shell theme itself has one, dark, style)
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._iface.connectObject('changed::color-scheme', () => this._syncStyleClass(), this);
        this._syncStyleClass();
        this._location = new LocationSource(this._settings, () => this._controller?.locationChanged());
        this._controller = new AppearanceController({
            settings: this._settings,
            iface: new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}),
            background: new Gio.Settings({schema_id: 'org.gnome.desktop.background'}),
            clock,
            tz: () => GLib.TimeZone.new_local(),
            location: () => this._location.current(),
            fileExists: defaultFileExists,
            themeExists: defaultThemeExists,
            log: msg => console.log(`vitre-appearance: ${msg}`),
        });
        this._controller.start();
    }

    _syncStyleClass() {
        const light = this._iface.get_string('color-scheme') !== 'prefer-dark';
        if (light)
            Main.uiGroup.add_style_class_name('vitre-style-light');
        else
            Main.uiGroup.remove_style_class_name('vitre-style-light');
    }

    disable() {
        // the style, wallpaper and theme name stay as they are; only the schedule stops
        this._iface?.disconnectObject(this);
        this._iface = null;
        Main.uiGroup.remove_style_class_name('vitre-style-light');
        this._controller?.stop();
        this._controller = null;
        this._location?.destroy();
        this._location = null;
        this._settings = null;
    }
}

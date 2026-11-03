import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {APP_ID} from './config.js';
import {ExtensionIndex} from './backend/extensions.js';
import {SettingsRegistry} from './backend/schemas.js';
import {VitreSettingsWindow} from './window.js';

// Folder this module was loaded from: <app>/src
const SRC_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
export const APP_DIR = GLib.path_get_dirname(SRC_DIR);

export const VitreSettingsApplication = GObject.registerClass(
class VitreSettingsApplication extends Adw.Application {
    constructor(params = {}) {
        super({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS, ...params});
        this._requestedPage = null;
        this.add_main_option('page', 0, GLib.OptionFlags.NONE, GLib.OptionArg.STRING,
            'Open this page (motion, dock, windows, glass, look, about)', 'PAGE');

        const showPage = new Gio.SimpleAction({name: 'show-page', parameter_type: new GLib.VariantType('s')});
        showPage.connect('activate', (_a, param) => {
            this._requestedPage = param.unpack();
            this.activate();
        });
        this.add_action(showPage);

        const quit = new Gio.SimpleAction({name: 'quit'});
        quit.connect('activate', () => this.quit());
        this.add_action(quit);
        this.set_accels_for_action('app.quit', ['<Control>q']);
        this.set_accels_for_action('window.close', ['<Control>w']);
    }

    vfunc_handle_local_options(options) {
        const page = options.lookup_value('page', null)?.unpack();
        if (page) {
            this.register(null);
            this.activate_action('show-page', new GLib.Variant('s', page));
            return 0;
        }
        return -1;
    }

    vfunc_startup() {
        super.vfunc_startup();
        // our own icons (sidebar glyphs and the app icon) next to the app, so nothing outside this folder is needed
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        for (const sub of ['actions', 'apps'])
            theme.add_search_path(GLib.build_filenamev([APP_DIR, 'icons', 'hicolor', 'scalable', sub]));
        const css = new Gtk.CssProvider();
        css.load_from_path(GLib.build_filenamev([APP_DIR, 'src', 'style.css']));
        // above the user stylesheet (Vitre links its theme there), so these few rules for our own widgets win
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_USER + 1);

        this.extensions = new ExtensionIndex();
        this.extensions.load();
        this.registry = new SettingsRegistry(this.extensions);
    }

    vfunc_activate() {
        let win = this.active_window;
        if (!win)
            win = new VitreSettingsWindow({application: this, registry: this.registry, extensions: this.extensions});
        if (this._requestedPage) {
            win.showPage(this._requestedPage);
            this._requestedPage = null;
        }
        win.present();
    }
});

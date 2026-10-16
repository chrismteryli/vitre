/**
 * @file Contains the implementation of the reset page.
 * The list of prefs that can be reset is stored in the `#resetPrefs` variable,
 * and the UI is automatically generated from that.
 */
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { getPref, prefs, Schema, setPref, } from '../../utils/settings.js';
export const ResetPage = GObject.registerClass({
    Template: GLib.uri_resolve_relative(import.meta.url, 'reset.ui', GLib.UriFlags.NONE),
    GTypeName: 'ResetPage',
    InternalChildren: ['resetGroup', 'resetButton', 'dialog'],
}, class extends Adw.NavigationPage {
    // Store all switches in a list to enable the "select all" button.
    #rows = [];
    // List of prefs that should be reset.
    #resetPrefs = [];
    // Map prefs to their labels in the UI.
    #resetLabels = {
        'skip-libadwaita-app': 'Skip LibAdwaita Applications',
        'skip-libhandy-app': 'Skip LibHandy Applications',
        'focused-shadow': 'Focus Window Shadow Style',
        'unfocused-shadow': 'Unfocus Window Shadow Style',
        'keep-shadow-for-maximized-fullscreen': 'Keep Window Shadows when Maximized or Fullscreen',
        'border-width': 'Border Width',
        'debug-mode': 'Enable Log',
        borderRadius: 'Border Radius',
        borderColor: 'Border Color',
        padding: 'Padding',
        keepRoundedCorners: 'Keep Rounded Corners when Maximized or Fullscreen',
        smoothing: 'Corner Smoothing',
    };
    constructor() {
        super();
        this.#buildUi();
    }
    selectAll() {
        for (const row of this.#rows) {
            row.set_active(true);
        }
    }
    askForReset() {
        this._dialog.choose(this, null, null);
    }
    reset(_, response) {
        if (response === 'cancel') {
            return;
        }
        const defaultRoundedCornerSettings = prefs
            .get_default_value('global-rounded-corner-settings')
            ?.recursiveUnpack();
        const currentRoundedCornerSettings = getPref('global-rounded-corner-settings');
        for (const key of this.#resetPrefs) {
            if (key in Schema) {
                // If the key is a top-level prefs schema key, reset it directly.
                prefs.reset(key);
            }
            else {
                // Otherwise, it's a key inside of `global-rounded-corner-settings`,
                // and should be reset accordingly.
                const settingsKey = key;
                currentRoundedCornerSettings[settingsKey] =
                    defaultRoundedCornerSettings[settingsKey];
            }
        }
        setPref('global-rounded-corner-settings', currentRoundedCornerSettings);
        const root = this.root;
        root.pop_subpage();
    }
    /** Generate the UI from {@link #resetLabels}. */
    #buildUi() {
        for (const [key, label] of Object.entries(this.#resetLabels)) {
            const row = new Adw.SwitchRow({
                active: false,
                name: key,
                title: _(label),
            });
            row.connect('notify::active', source => this.#onToggled(source));
            this._resetGroup.add(row);
            this.#rows.push(row);
        }
    }
    /** Callback to add or remove a pref from the list of prefs to reset. */
    #onToggled(source) {
        if (source.active) {
            this.#resetPrefs.push(source.name);
        }
        else {
            this.#resetPrefs = this.#resetPrefs.filter(k => k !== source.name);
        }
    }
});

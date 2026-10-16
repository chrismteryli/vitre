import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AppAdmission} from './admission.js';
import {AppWindowsSession} from './session.js';
import {hasAppWindows, matchesApp, rootWindow, windowApp} from './scope.js';

export default class AppWindowsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._tracker = Shell.WindowTracker.get_default();
        this._bindingInstalled = false;
        this._admission = null;
        this._session = new AppWindowsSession({
            overview: Main.overview,
            allowed: () => Main.sessionMode.hasOverview && !Main.sessionMode.isLocked && !Main.overview.isDummy,
            hasWindows: app => hasAppWindows(app, this._tracker),
            install: app => {
                this._admission = new AppAdmission({
                    prototype: Workspace.Workspace.prototype,
                    injection: new InjectionManager(),
                    windows: () => global.get_window_actors().map(actor => actor.meta_window),
                    matches: (window, target) => matchesApp(window, target, this._tracker),
                });
                this._admission.start(app);
            },
            remove: options => {
                this._admission?.stop(options);
                this._admission = null;
            },
            focus: app => this._focusWindows(app),
            defer: callback => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                try { callback(); } catch (error) { console.error(`App Windows: ${error.message}`); }
                return GLib.SOURCE_REMOVE;
            }),
            cancelDeferred: id => GLib.source_remove(id),
        });

        this._indicator = new SystemIndicator();
        this._action = new QuickToggle({title: 'App Windows', subtitle: 'Current app',
            iconName: 'view-grid-symbolic', toggleMode: false});
        this._action.connect('clicked', () => {
            const app = windowApp(global.display.focus_window, this._tracker);
            Main.panel.statusArea.quickSettings.menu.close({animate: false});
            this.toggleApp(app);
        });
        this._indicator.quickSettingsItems.push(this._action);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._settingsSignal = this._settings.connect('changed::app-windows-shortcut', () => this._syncBinding());
        this._modeSignal = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked || !Main.sessionMode.hasOverview)
                this._session.cancel();
        });
        this._syncBinding();
    }

    // Public entry point for a future dock action; captures one app per session.
    toggleApp(app = null) {
        try {
            return this._session.toggle(app ?? windowApp(global.display.focus_window, this._tracker));
        } catch (error) {
            console.error(`App Windows: ${error.message}`);
            return false;
        }
    }

    _focusWindows(app) {
        const focused = rootWindow(global.display.focus_window);
        const active = global.workspace_manager.get_active_workspace();
        const previews = this._admission?.previewsForWorkspace(active).filter(preview =>
            preview.mapped &&
            matchesApp(preview.metaWindow, app, this._tracker)) ?? [];
        const target = previews.find(preview => preview.metaWindow === focused) ?? previews[0];
        if (target)
            target.grab_key_focus();
        else
            Main.overview._overview.controls._workspacesDisplay.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    _syncBinding() {
        if (this._bindingInstalled)
            Main.wm.removeKeybinding('app-windows-shortcut');
        this._bindingInstalled = false;
        this._action.subtitle = 'Current app';
        if (!this._settings.get_strv('app-windows-shortcut').length)
            return;
        try {
            const action = Main.wm.addKeybinding('app-windows-shortcut', this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggleApp());
            this._bindingInstalled = action !== Meta.KeyBindingAction.NONE;
        } catch (_error) {
            this._bindingInstalled = false;
        }
        if (!this._bindingInstalled) {
            Main.wm.removeKeybinding('app-windows-shortcut');
            this._action.subtitle = 'Shortcut unavailable';
            console.warn('App Windows: shortcut registration failed; existing shortcuts were not changed.');
        }
    }

    disable() {
        if (this._bindingInstalled)
            Main.wm.removeKeybinding('app-windows-shortcut');
        this._bindingInstalled = false;
        if (this._settingsSignal)
            this._settings.disconnect(this._settingsSignal);
        if (this._modeSignal)
            Main.sessionMode.disconnect(this._modeSignal);
        this._session?.disable();
        this._session = null;
        this._action?.destroy();
        this._indicator?.destroy();
        this._action = null;
        this._indicator = null;
        this._settings = null;
        this._tracker = null;
    }
}

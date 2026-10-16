import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getOperations} from './windowOperations.js';
import {DesktopSession} from './session.js';
import {DesktopScene} from './scene.js';

export default class ShowDesktopExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._operations = getOperations();
        this._signals = [];
        this._windowSignals = [];
        this._session = new DesktopSession({
            operations: this._operations,
            allowed: () => !Main.sessionMode.isLocked && !Main.overview.visible &&
                Main.sessionMode.hasWindows && this._coordinatedStage(),
            select: () => this._select(),
            makeScene: (windows, restore) => new DesktopScene(windows, restore),
            watch: windows => this._watch(windows),
            unwatch: () => this._unwatch(),
            setMinimized: (windows, value) => this._setMinimized(windows, value),
            alive: win => Boolean(win.get_compositor_private()),
            focusDesktop: () => global.display.focus_default_window(global.get_current_time()),
            focusWindow: win => Main.activateWindow(win),
            sameWorkspace: workspace => global.workspace_manager.get_active_workspace() === workspace,
            reducedMotion: () => !St.Settings.get().enable_animations ||
                St.Settings.get().reducedMotion === St.ReducedMotion.REDUCE,
            reportRecoveryFailure: () => console.warn('Show Desktop: a window could not be restored; toggle again to retry.'),
        });
        this._disposeController = this._operations.setDesktopController(this, () => this._session.toggle());
        const connect = (object, signal, callback) => this._signals.push([object, object.connect(signal, callback)]);
        connect(global.workspace_manager, 'active-workspace-changed', () => this._cancel('workspace'));
        connect(Main.layoutManager, 'monitors-changed', () => this._cancel('monitors'));
        connect(Main.overview, 'showing', () => this._cancel('overview'));
        connect(Main.sessionMode, 'updated', () => this._cancel('session'));
        connect(global.display, 'window-created', () => this._cancel('new-window'));
        connect(global.display, 'notify::focus-window', () => {
            if (this._session.mutating) return;
            const win = global.display.focus_window;
            if (win && !win.minimized && this._isApplicationWindow(win)) this._cancel('focus');
        });

        this._indicator = new SystemIndicator();
        this._action = new QuickToggle({title: 'Show Desktop', iconName: 'user-desktop-symbolic', toggleMode: false});
        this._action.connect('clicked', () => {
            Main.panel.statusArea.quickSettings.menu.close({animate: false});
            this._session.toggle();
        });
        this._indicator.quickSettingsItems.push(this._action);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        connect(this._settings, 'changed::show-desktop-shortcut', () => this._syncBinding());
        this._syncBinding();
    }

    _isApplicationWindow(win) {
        return [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG].includes(win.get_window_type()) &&
            !win.is_override_redirect();
    }

    _coordinatedStage() {
        const stage = Main.extensionManager.lookup('vitre-stage@vitre-desktop')?.stateObj;
        // Stage v4 reports contract 2; 2 only adds optional hooks to the prepare/release lease this
        // extension uses, so 1 and 2 are both coordinated. Anything else still fails closed.
        return !(stage?._settings && ![1, 2].includes(stage.windowOperationsVersion)) &&
            !(stage?._manager && !this._operations.hasStageProvider());
    }

    _select() {
        const workspace = global.workspace_manager.get_active_workspace();
        const focus = global.display.focus_window;
        const windows = global.get_window_actors().filter(actor => {
            const win = actor.meta_window;
            // Stage and dock restore can temporarily hide the real actor while
            // its native window is already unminimized. Lease preparation settles
            // those visuals before capture; opacity is not window eligibility.
            return this._isApplicationWindow(win) &&
                win.located_on_workspace(workspace) && !win.minimized && !win.fullscreen &&
                !this._operations.isReserved(win);
        }).map(actor => actor.meta_window);
        // Native map/resize awaits can still resume after their cleanup method
        // is called. Do not seize those operations or capture a partial frame.
        // A fresh invocation after that short native transition can proceed.
        const nativeBusy = windows.some(win => {
            const actor = win.get_compositor_private();
            return ['_mapping', '_unminimizing', '_resizing', '_resizePending']
                .some(key => Main.wm[key]?.has(actor));
        });
        if (nativeBusy) return {windows: [], focus, workspace};
        return {windows: global.display.sort_windows_by_stacking(windows), focus, workspace};
    }

    _watch(windows) {
        for (const win of windows) {
            for (const signal of ['notify::minimized', 'workspace-changed', 'position-changed', 'size-changed'])
                this._windowSignals.push([win, win.connect(signal, () => this._session.windowChanged(win))]);
            this._windowSignals.push([win, win.connect('unmanaged', () => this._session.windowClosed(win))]);
        }
    }

    _unwatch() {
        for (const [object, id] of this._windowSignals.splice(0)) object.disconnect(id);
    }

    _setMinimized(windows, value) {
        const kind = value ? 'minimize' : 'unminimize';
        // Arm every token before a parent operation can synchronously affect an
        // attached dialog; native and Dhruva effect paths see the same intent.
        const arm = index => {
            if (index < windows.length)
                return this._operations.quiet(windows[index], kind, () => arm(index + 1));
            let failed = false;
            const skips = [];
            for (const win of windows) {
                const actor = win.get_compositor_private();
                if (actor && win.minimized !== value) {
                    const owned = !Main.wm._skippedActors.has(actor);
                    Main.wm.skipNextEffect(actor);
                    skips.push({win, actor, owned});
                }
            }
            for (const win of windows) {
                try {
                    const actor = win.get_compositor_private();
                    if (!actor || win.minimized === value) continue;
                    if (value) win.minimize();
                    else win.unminimize();
                } catch (_error) { failed = true; }
            }
            // A refusal emits no native operation to consume its one-shot skip.
            // Clear only markers this batch created, never another owner's.
            for (const {win, actor, owned} of skips) {
                if (owned && win.minimized !== value) Main.wm._skippedActors.delete(actor);
            }
            if (failed) throw new Error('A window operation failed');
        };
        arm(0);
    }

    _cancel(reason) {
        if (!this._session.mutating) this._session.cancel(reason);
    }

    _syncBinding() {
        if (this._bindingInstalled) Main.wm.removeKeybinding('show-desktop-shortcut');
        this._bindingInstalled = false;
        if (!this._settings.get_strv('show-desktop-shortcut').length) return;
        try {
            const action = Main.wm.addKeybinding('show-desktop-shortcut', this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL, () => this._session.toggle());
            this._bindingInstalled = action !== Meta.KeyBindingAction.NONE;
        } catch (_error) { this._bindingInstalled = false; }
        if (!this._bindingInstalled) {
            Main.wm.removeKeybinding('show-desktop-shortcut');
            console.warn('Show Desktop: shortcut unavailable; use the dock or Quick Settings.');
        }
    }

    disable() {
        this._disposeController?.();
        this._disposeController = null;
        if (this._bindingInstalled) Main.wm.removeKeybinding('show-desktop-shortcut');
        this._bindingInstalled = false;
        this._session?.cancel('disable');
        // If native restoration failed, leave a recoverable minimized window,
        // but never retain actors/signals/leases belonging to a disabled extension.
        for (const entry of this._session?.entries.values() ?? []) entry.lease.release('disable');
        this._session?.scene?.destroy();
        this._unwatch();
        for (const [object, id] of this._signals.splice(0)) object.disconnect(id);
        this._action?.destroy();
        this._indicator?.destroy();
        this._session = null;
        this._settings = null;
        this._operations = null;
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Fullscreen Spaces: a reversible workspace transaction. A window that goes fullscreen gets a workspace of its own and
// returns to its desktop when it leaves fullscreen.
//
// Motion (setting `motion`): 'vitre' (default, fullscreenMotion.js) grows the window to the screen in one gesture while the
// desktop steps back and the chrome slides away; the workspace move happens under that motion, so the workspace switch
// itself does not slide. 'native' is the earlier behaviour: GNOME's size-change effect and the workspace slide.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getOperations} from './windowOperations.js';
import {FullscreenMotion} from './fullscreenMotion.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class FullscreenSpaces extends Extension {
    enable() {
        this._enabled = true;
        this._signals = [];
        this._windows = new Map();
        this._records = new Map();
        this._retained = new Map();
        this._pending = new Map();
        this._checkingWorkspaces = 0;
        this._deferred = new Set();         // windows whose workspace move waits for the motion to land
        this._quietSwitch = 0;              // > 0: a switch made under the motion's layer (no slide of its own)
        this._switching = 0;                // > 0: this extension is switching workspaces
        this._motion = null;
        this._operations = getOperations();
        this._hooks = new InjectionManager();
        this._names = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        try {
            const tracker = Main.wm._workspaceTracker;
            if (!tracker || typeof tracker._checkWorkspaces !== 'function' ||
                typeof tracker.unblockUpdates !== 'function')
                throw new Error('Unsupported native workspace tracker');
            // Retain only our source/destination objects during automatic pruning.
            // Explicit removals outside the native check still pass through.
            const owner = this;
            this._hooks.overrideMethod(tracker, '_checkWorkspaces', original => function (...args) {
                owner._checkingWorkspaces++;
                try { return original.apply(this, args); }
                finally { owner._checkingWorkspaces--; }
            });
            this._hooks.overrideMethod(tracker, 'unblockUpdates', original => function (...args) {
                const result = original.apply(this, args);
                if (owner._enabled && !this._pauseWorkspaceCheck) {
                    // Native finish still owns monitor groups in this stack.
                    // Queue an idle; do not remove any workspace inside unblock.
                    for (const record of owner._pending.keys())
                        owner._queueCleanup(record);
                }
                return result;
            });
            this._hooks.overrideMethod(global.workspace_manager, 'remove_workspace', original => function (ws, time) {
                if (owner._checkingWorkspaces && owner._retained.has(ws))
                    return;
                return original.call(this, ws, time);
            });
            // A pending native later has already bound the old method. Requeue
            // that one check through its own routine so retention applies to it.
            if (tracker._checkWorkspacesId) {
                global.compositor.get_laters().remove(tracker._checkWorkspacesId);
                tracker._checkWorkspacesId = 0;
                tracker._queueCheckWorkspaces();
            }
            this._connect(global.display, 'window-created', (_display, win) => this._watch(win, true));
            this._connect(global.workspace_manager, 'workspace-removed', () => {
                for (const record of [...this._records.values()]) {
                    if (!this._alive(record.space))
                        this._finish(record, false);
                }
            });
            this._connect(global.workspace_manager, 'workspaces-reordered', () => {
                // A user/other extension has arranged these workspaces: leave them.
                for (const record of [...this._records.values(), ...this._pending.keys()])
                    record.reused = true;
            });
            this._connect(this._names, 'changed::workspace-names', () => {
                for (const record of [...this._records.values(), ...this._pending.keys()])
                    record.reused = true;
            });
            for (const win of global.display.list_all_windows())
                this._watch(win, false);
        } catch (error) {
            this.disable();
            throw error;
        }
        // the motion is its own part: if it cannot start, the workspace transaction still runs with native motion
        try {
            this._settings = this.getSettings();
            this._connect(this._settings, 'changed::motion', () => this._syncMotion());
        } catch (error) {
            this._settings = null;
            console.warn(`Full Screen Spaces: no settings, native motion (${error.message})`);
        }
        this._syncMotion();
    }

    _syncMotion() {
        const want = this._enabled && (this._settings?.get_string('motion') ?? 'vitre') === 'vitre';
        if (want && !this._motion) {
            try {
                this._motion = new FullscreenMotion(this);
                this._motion.enable();
                this._switchHooks = new InjectionManager();
                const owner = this;
                // a switch under the motion's layer completes at once: the layer is the motion
                this._switchHooks.overrideMethod(Main.wm._workspaceAnimation, 'animateSwitch', original => function (from, to, direction, onComplete) {
                    if (owner._quietSwitch > 0) {
                        onComplete();
                        return;
                    }
                    original.call(this, from, to, direction, onComplete);
                });
            } catch (error) {
                console.warn(`Full Screen Spaces: native motion (${error.message})`);
                this._stopMotion();
            }
        } else if (!want && this._motion) {
            this._stopMotion();
        }
    }

    _stopMotion() {
        // a move still waiting for the motion runs now (with GNOME's slide)
        const waiting = [...this._deferred];
        this._switchHooks?.clear();
        this._switchHooks = null;
        const motion = this._motion;
        this._motion = null;
        motion?.disable();
        for (const win of waiting)
            this._enterDeferred(win);
    }

    // ---- what the motion asks and tells (fullscreenMotion.js) ----------------------------------------------------------

    motionOwnsSwitch() {
        return this._switching > 0;
    }

    // the desktop a returning window lands on
    motionDesktopFor(win) {
        const record = this._records.get(win);
        return record && this._alive(record.origin) ? record.origin : null;
    }

    motionPending(win) {
        return this._deferred.has(win);
    }

    motionStageStrip() {
        return Main.extensionManager.lookup('vitre-stage@vitre-desktop')?.stateObj?._manager?._strip ?? null;
    }

    motionStageIdle() {
        const manager = Main.extensionManager.lookup('vitre-stage@vitre-desktop')?.stateObj?._manager;
        return !manager || ((manager._flights?.size ?? 0) === 0 && !manager._busy);
    }

    // the enter motion has landed (the window covers the screen): its workspace move happens now, under the layer
    motionLanded(win) {
        this._enterDeferred(win);
    }

    // the motion ended (landed, or cut short): a move still waiting runs now
    motionEnded(win) {
        this._enterDeferred(win);
    }

    _enterDeferred(win) {
        if (!this._deferred.delete(win) || !this._enabled || !this._windows.has(win))
            return;
        try {
            if (win.is_fullscreen())
                this._withQuietSwitch(win, () => this._enter(win));
        } catch (error) {
            console.error(`Full Screen Spaces could not enter: ${error.message}`);
        }
    }

    // Switches made while the motion covers the window's monitor need no slide of their own: they finish at once under the
    // layer. Only when that monitor is the only one that switches (one monitor, or workspaces on the primary only).
    _withQuietSwitch(win, fn) {
        const covered = Boolean(this._motion?.covers(win)) && (Main.layoutManager.monitors.length === 1 ||
            (Meta.prefs_get_workspaces_only_on_primary() && win.get_monitor() === Main.layoutManager.primaryIndex));
        if (covered)
            this._quietSwitch++;
        try {
            return fn();
        } finally {
            if (covered)
                this._quietSwitch--;
        }
    }

    _connect(object, name, callback, list = this._signals) {
        list.push([object, object.connect(name, callback)]);
    }

    _disconnect(list) {
        for (const [object, id] of list.splice(0)) {
            try { object.disconnect(id); } catch (_) { /* Already disposed. */ }
        }
    }

    _alive(workspace) {
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.n_workspaces; i++) {
            if (manager.get_workspace_by_index(i) === workspace)
                return true;
        }
        return false;
    }

    _retain(workspace, delta) {
        const count = (this._retained.get(workspace) ?? 0) + delta;
        if (count > 0)
            this._retained.set(workspace, count);
        else
            this._retained.delete(workspace);
    }

    _family(win, other) {
        return other === win || Boolean(other && win.is_ancestor_of_transient(other));
    }

    _watch(win, created) {
        if (this._windows.has(win))
            return;
        const state = {signals: [], fullscreen: win.is_fullscreen(), source: 0};
        this._windows.set(win, state);
        this._connect(win, 'notify::fullscreen', () => this._fullscreenChanged(win), state.signals);
        this._connect(win, 'workspace-changed', () => {
            const record = this._records.get(win);
            if (record && !record.moving && win.get_workspace() !== record.space)
                this._finish(record, false); // External move wins, including workspace removal.
        }, state.signals);
        for (const signal of ['notify::main-monitor', 'notify::on-all-workspaces']) {
            this._connect(win, signal, () => {
                const record = this._records.get(win);
                if (record && (win.get_monitor() !== record.monitor || win.is_on_all_workspaces())) {
                    record.reused = true;
                    this._finish(record, false); // Preserve the user's new monitor/sticky placement.
                }
            }, state.signals);
        }
        this._connect(win, 'unmanaged', () => {
            this._deferred?.delete(win);
            const record = this._records.get(win);
            if (record)
                this._finish(record, false, true);
            if (state.source)
                GLib.source_remove(state.source);
            this._disconnect(state.signals);
            this._windows.delete(win);
        }, state.signals);
        if (created) {
            // Initial workspace/fullscreen assignment may follow window-created.
            state.fullscreen = false;
            state.source = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                state.source = 0;
                this._fullscreenChanged(win);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _fullscreenChanged(win) {
        const state = this._windows.get(win);
        if (!state || !this._enabled)
            return;
        const fullscreen = win.is_fullscreen();
        if (state.fullscreen === fullscreen)
            return;
        state.fullscreen = fullscreen;
        if (fullscreen) {
            if (this._motion?.holdsEnter(win)) {
                // the motion moves the window to its workspace when it has landed (motionLanded)
                this._deferred.add(win);
                return;
            }
            this._withQuietSwitch(win, () => this._enter(win));
        } else {
            this._deferred.delete(win);
            if (this._records.has(win))
                this._withQuietSwitch(win, () => this._finish(this._records.get(win), true));
        }
    }

    _eligible(win) {
        return this._alive(win.get_workspace()) && win.is_fullscreen() &&
            win.get_window_type() === Meta.WindowType.NORMAL && !win.is_skip_taskbar() &&
            !win.is_override_redirect() && !win.get_transient_for() &&
            !win.is_on_all_workspaces() &&
            (!Meta.prefs_get_workspaces_only_on_primary() || win.is_on_primary_monitor());
    }

    _hasUnsupportedStage() {
        const stage = Main.extensionManager.lookup('vitre-stage@vitre-desktop')?.stateObj;
        // Updated files alone do not mean the coordinated implementation loaded.
        // An active legacy implementation must not receive unguarded windows.
        return Boolean(stage?._settings && ![1, 2].includes(stage.windowOperationsVersion)) ||
            Boolean(stage?._manager && !this._operations.hasStageProvider());
    }

    _enter(win) {
        if (this._hasUnsupportedStage() || this._records.has(win) || !this._eligible(win))
            return;
        // Preparation settles Stage-owned motion and restores only windows Stage
        // minimized. The reservation is already visible to its mutation guards.
        const lease = this._operations.acquire(win, this, 'fullscreen');
        if (!lease)
            return;
        let record = null;
        try {
            if (!this._windows.has(win) || !this._eligible(win) || win.minimized) {
                lease.release('ineligible');
                return;
            }
            const origin = win.get_workspace();
            const manager = global.workspace_manager;
            const shouldFollow = manager.get_active_workspace() === origin && this._family(win, global.display.focus_window);
            record = {win, origin, lease, space: null, monitor: win.get_monitor(), moving: false,
                reused: false, signals: [], closed: false};
            this._retain(origin, 1);
            record.space = manager.append_new_workspace(false, global.get_current_time());
            this._retain(record.space, 1);
            this._records.set(win, record);
            this._connect(record.space, 'window-added', (_space, other) => {
                if (!this._family(win, other))
                    record.reused = true;
            }, record.signals);
            record.moving = true;
            try { win.change_workspace(record.space); }
            finally { record.moving = false; }
            if (this._records.get(win) !== record)
                return;
            if (win.get_workspace() !== record.space) {
                this._finish(record, false, false, 'entry-refused');
                return;
            }
            // Like native actionMoveWindow, follow the captured focused window.
            // Moving it can itself cause Mutter to select a different focus.
            if (shouldFollow && manager.get_active_workspace() === origin) {
                this._switching++;
                try { record.space.activate_with_focus(win, global.get_current_time()); }
                finally { this._switching--; }
            }
        } catch (error) {
            if (record?.space && this._records.get(win) === record) {
                this._finish(record, true, false, 'entry-failed');
            } else {
                if (record)
                    this._retain(record.origin, -1);
                lease.release('entry-failed');
            }
            console.error(`Full Screen Spaces could not enter: ${error.message}`);
        }
    }

    _destination(record) {
        if (this._alive(record.origin))
            return record.origin;
        const manager = global.workspace_manager;
        const active = manager.get_active_workspace();
        if (active !== record.space && !this._isOwnedSpace(active))
            return active;
        for (let i = 0; i < manager.n_workspaces; i++) {
            const ws = manager.get_workspace_by_index(i);
            if (ws !== record.space && !this._isOwnedSpace(ws))
                return ws;
        }
        // Only if every surviving workspace belongs to another fullscreen app.
        return manager.append_new_workspace(false, global.get_current_time());
    }

    _isOwnedSpace(workspace) {
        return [...this._records.values()].some(record => record.space === workspace);
    }

    _finish(record, restore, closed = false, reason = closed ? 'unmanaged' : restore ? 'complete' : 'external-move') {
        if (this._records.get(record.win) !== record)
            return;
        this._records.delete(record.win);
        // Include the transaction in user-reuse protection during the move too.
        this._pending.set(record, 0);
        record.closed = closed;
        const manager = global.workspace_manager;
        const follow = restore && manager.get_active_workspace() === record.space &&
            this._family(record.win, global.display.focus_window) && !Main.sessionMode.isLocked;
        try {
            if (restore && record.win.get_workspace() === record.space) {
                const destination = this._destination(record);
                record.win.change_workspace(destination);
                if (follow && manager.get_active_workspace() === record.space) {
                    this._switching++;
                    try { destination.activate_with_focus(record.win, global.get_current_time()); }
                    finally { this._switching--; }
                }
            }
        } catch (error) {
            // Never remove a nonempty workspace after a refused/failed move.
            record.reused = true;
            reason = 'return-failed';
            console.error(`Full Screen Spaces could not return a window: ${error.message}`);
        } finally {
            // Stage reconciles only after our actual placement and focus settle.
            record.lease.release(reason);
            record.lease = null;
            this._retain(record.origin, -1);
            this._retain(record.space, -1);
            this._queueCleanup(record);
        }
    }

    _queueCleanup(record) {
        if (this._pending.get(record))
            return;
        const source = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending.set(record, 0);
            if (this._cleanup(record))
                this._pending.delete(record);
            return GLib.SOURCE_REMOVE;
        });
        this._pending.set(record, source);
    }

    _deletable(record) {
        const space = record.space;
        return this._alive(space) && !record.reused && !this._retained.has(space) &&
            !space.list_windows().some(win => !win.is_on_all_workspaces()) &&
            !this._names.get_strv('workspace-names')[space.index()];
    }

    _cleanup(record) {
        // A native animation/gesture holds Workspace objects and index snapshots.
        // Keep our records/signals, without polling, until its real unblock.
        const tracker = Main.wm._workspaceTracker;
        if (tracker._pauseWorkspaceCheck)
            return false;
        const complete = () => {
            this._disconnect(record.signals);
            return true;
        };
        if (!this._deletable(record))
            return complete();
        const space = record.space;
        const manager = global.workspace_manager;
        if (manager.get_active_workspace() === space) {
            // Closing the sole app returns to its desktop. Manual moves don't
            // authorize a focus/workspace switch; leave that empty desktop alone.
            if (!record.closed || Main.sessionMode.isLocked)
                return complete();
            this._switching++;
            try { this._destination(record).activate(global.get_current_time()); }
            finally { this._switching--; }
        }
        // Returning after a close can itself start a new native switch.
        if (tracker._pauseWorkspaceCheck)
            return false;
        if (this._deletable(record) && manager.n_workspaces > 1 &&
            manager.get_active_workspace() !== space)
            manager.remove_workspace(space, global.get_current_time());
        return complete();
    }

    disable() {
        this._enabled = false;
        // waiting moves are dropped (the window stays fullscreen where it is), then the motion lets go of its layer
        this._deferred?.clear();
        this._switchHooks?.clear();
        this._switchHooks = null;
        this._motion?.disable();
        this._motion = null;
        this._settings = null;
        this._disconnect(this._signals ?? []);
        for (const state of this._windows?.values() ?? []) {
            if (state.source)
                GLib.source_remove(state.source);
            this._disconnect(state.signals);
        }
        for (const record of [...(this._records?.values() ?? [])])
            this._finish(record, true, false, 'disabled');
        let cededCleanup = false;
        for (const [record, source] of this._pending ?? []) {
            if (source)
                GLib.source_remove(source);
            if (!this._cleanup(record)) {
                cededCleanup = true;
                this._disconnect(record.signals);
            }
        }
        this._pending?.clear();
        this._hooks?.clear();
        this._retained?.clear();
        this._windows?.clear();
        this._names = null;
        this._operations = null;
        // No extension hook/source survives disable. Dynamic pruning has its
        // own native pause guard; static empty Spaces must remain recoverable.
        if (cededCleanup && Meta.prefs_get_dynamic_workspaces())
            Main.wm._workspaceTracker._queueCheckWorkspaces();
    }
}

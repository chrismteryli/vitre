import GLib from 'gi://GLib';

// Identical copies live in each consumer. The Shell JS global owns one registry;
// no extension owns another extension's lifetime, settings or module cache.
const REGISTRY_KEY = Symbol.for('vitre.desktop.window-operations.v1');
const QUIET_TIMEOUT_MS = 500;

export class WindowOperations {
    constructor(schedule, cancel) {
        this._schedule = schedule;
        this._cancel = cancel;
        this._leases = new Map();
        this._quiet = new Map();
        this._stage = null;
        this._desktop = null;
        this._effects = null;
    }

    isReserved(win) { return this._leases.has(win); }

    hasStageProvider() { return this._stage !== null; }

    // Optional on older Stage adapters. A handled activation includes a queued
    // group switch: callers must not race it with a separate Dock restore.
    activateStage(win) {
        if (!win || this.isReserved(win) || typeof this._stage?.activate !== 'function')
            return false;
        return this._stage.activate(win) === true;
    }

    parkStage(win) {
        if (!win || this.isReserved(win) || typeof this._stage?.park !== 'function')
            return false;
        return this._stage.park(win) === true;
    }

    ownsStageMinimize(win) {
        if (!win || !win.minimized || this.isReserved(win) ||
            typeof this._stage?.ownsMinimize !== 'function')
            return false;
        return this._stage.ownsMinimize(win) === true;
    }

    // Native animation predicates do not carry an operation kind. A minimized
    // window must never be mistaken for a Stage-owned restore, even if an
    // adapter retains a stale membership record while minimize is dispatched.
    ownsStageRestore(win) {
        if (!win || win.minimized || this.isReserved(win) ||
            typeof this._stage?.ownsRestore !== 'function')
            return false;
        return this._stage.ownsRestore(win) === true;
    }

    acquire(win, owner, intent) {
        if (!win || !owner || this.isReserved(win))
            return null;
        const record = {win, owner, intent, stage: null, ticket: null, unmanaged: 0};
        const lease = {release: reason => this._release(record, reason ?? 'complete')};
        record.lease = lease;
        this._leases.set(win, record); // Stage guards apply during preparation.
        try {
            record.unmanaged = win.connect('unmanaged', () => lease.release('unmanaged'));
            // Reserve first so completion of an old visual cannot cause Stage
            // to re-adopt this window. Snapshots taken after acquire must see
            // the settled window, never an intermediate fade/deformation.
            this.settle(win);
            if (this._leases.get(win) !== record)
                return null;
            if (this._stage) {
                record.stage = this._stage;
                record.ticket = record.stage.prepare(win, intent);
            }
        } catch (error) {
            lease.release('prepare-failed');
            console.warn(`Window operations: preparation failed: ${error.message}`);
            return null;
        }
        return this._leases.get(win) === record ? lease : null;
    }

    registerEffects(callback) {
        if (this._effects)
            throw new Error('An effects provider is already registered');
        const provider = {callback};
        this._effects = provider;
        return () => {
            if (this._effects === provider)
                this._effects = null;
        };
    }

    settle(win) {
        // Failure must reach acquire/capture: a partial visual is not a valid
        // snapshot fallback. Each provider only touches effects it owns.
        this._effects?.callback(win);
    }

    _release(record, reason) {
        if (this._leases.get(record.win) !== record)
            return false;
        this._leases.delete(record.win);
        if (record.unmanaged)
            record.win.disconnect(record.unmanaged);
        record.unmanaged = 0;
        const stage = record.stage;
        record.stage = null;
        try {
            stage?.release(record.ticket, record.win, record.intent, reason);
        } catch (error) {
            console.warn(`Window operations: Stage release failed: ${error.message}`);
        }
        record.ticket = null;
        return true;
    }

    registerStage(adapter) {
        if (this._stage)
            throw new Error('A Stage adapter is already registered');
        this._stage = adapter;
        for (const record of this._leases.values()) {
            try {
                record.stage = adapter;
                record.ticket = adapter.prepare(record.win, record.intent);
            } catch (error) {
                record.stage = null;
                console.warn(`Window operations: late Stage preparation failed: ${error.message}`);
            }
        }
        return () => {
            if (this._stage !== adapter)
                return;
            this._stage = null;
            for (const record of this._leases.values()) {
                if (record.stage === adapter) {
                    record.stage = null;
                    record.ticket = null;
                }
            }
        };
    }

    _clearQuiet(win, kind, token) {
        const kinds = this._quiet.get(win);
        if (kinds?.get(kind) !== token)
            return false;
        kinds.delete(kind);
        if (kinds.size === 0)
            this._quiet.delete(win);
        if (token.timer)
            this._cancel(token.timer);
        token.timer = 0;
        return true;
    }

    quiet(win, kind, action) {
        if (kind !== 'minimize' && kind !== 'unminimize')
            throw new Error('Unknown quiet window operation');
        // A no-op must not suppress a later, unrelated user action.
        if ((kind === 'minimize' && win.minimized) ||
            (kind === 'unminimize' && !win.minimized))
            return action();
        const old = this._quiet.get(win)?.get(kind);
        if (old)
            this._clearQuiet(win, kind, old);
        const kinds = this._quiet.get(win) ?? new Map();
        const token = {timer: 0};
        kinds.set(kind, token);
        this._quiet.set(win, kinds);
        token.timer = this._schedule(QUIET_TIMEOUT_MS, () => {
            token.timer = 0;
            this._clearQuiet(win, kind, token);
        });
        try {
            return action();
        } catch (error) {
            this._clearQuiet(win, kind, token);
            throw error;
        }
    }

    peekQuiet(win, kind) { return Boolean(this._quiet.get(win)?.has(kind)); }

    consumeQuiet(win, kind) {
        const token = this._quiet.get(win)?.get(kind);
        return token ? this._clearQuiet(win, kind, token) : false;
    }

    setDesktopController(owner, callback) {
        const controller = {owner, callback};
        this._desktop = controller;
        return () => {
            if (this._desktop === controller)
                this._desktop = null;
        };
    }

    hasDesktopController() { return this._desktop !== null; }

    toggleDesktop() {
        if (!this._desktop)
            return false;
        try {
            this._desktop.callback();
        } catch (error) {
            console.warn(`Window operations: desktop action failed: ${error.message}`);
        }
        // A busy/locked controller still owns this invocation. A legacy dock
        // fallback must not mutate its windows when it declines an action.
        return true;
    }
}

export function getOperations() {
    if (!globalThis[REGISTRY_KEY]) {
        globalThis[REGISTRY_KEY] = new WindowOperations(
            (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            id => GLib.source_remove(id));
    }
    const operations = globalThis[REGISTRY_KEY];
    // A Shell session retains the v1 registry across extension reloads. Add
    // only the new optional methods to that same object, so older consumers
    // keep their providers, leases, quiet tokens and object identity intact.
    for (const name of ['activateStage', 'parkStage', 'ownsStageRestore', 'ownsStageMinimize']) {
        if (typeof operations[name] !== 'function')
            operations[name] = WindowOperations.prototype[name];
    }
    return operations;
}

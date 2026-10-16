// Window state belongs to this transaction only while its lease is held.
// Rendering and GNOME APIs are injected so interruption/ownership is testable.
export class DesktopSession {
    constructor(deps) {
        this.d = deps;
        this.state = 'idle';
        this.entries = new Map();
        this.mutating = false;
        this.generation = 0;
        this.scene = null;
    }

    toggle() {
        if (!this.d.allowed()) return false;
        if (this.state === 'idle') return this._begin();
        if (this.state === 'preparing') return false;
        this._animate(this.state === 'restoring' ? 1 : 0);
        return true;
    }

    _begin() {
        const {windows, focus, workspace} = this.d.select();
        if (!windows.length) return false;
        this.state = 'preparing';
        this.focus = focus;
        this.workspace = workspace;
        this.mutating = true;
        try {
            // Reserve the complete set before capturing or minimizing anything.
            for (const win of windows) {
                const lease = this.d.operations.acquire(win, this, 'show-desktop');
                if (!lease) throw new Error('Window is owned by another operation');
                this.entries.set(win, {lease, owned: false});
            }
            this.scene = this.d.makeScene(windows, reason => {
                if (reason === 'scene-destroyed') this.cancel(reason);
                else if (this.state === 'exposed') this._animate(0);
            });
            this.d.watch(windows);
            // Claim before synchronous notifications, including attached-dialog
            // minimizes caused by a parent. Previously minimized windows were
            // excluded by selection and must never enter this set.
            for (const entry of this.entries.values()) entry.owned = true;
            this.d.setMinimized(windows, true);
            if (windows.some(win => this.d.alive(win) && !win.minimized))
                throw new Error('A window declined desktop reveal');
            this.d.focusDesktop();
        } catch (_error) {
            this.mutating = false;
            this.cancel('prepare-failed');
            return false;
        } finally {
            this.mutating = false;
        }
        this._animate(1);
        return true;
    }

    _animate(target) {
        const generation = ++this.generation;
        this.state = target ? 'exposing' : 'restoring';
        try {
            this.scene.animateTo(target, () => {
                if (generation !== this.generation) return;
                if (target) this.state = 'exposed';
                else this._finish(true, 'complete');
            }, this.d.reducedMotion());
        } catch (_error) {
            this.cancel('animation-failed');
        }
    }

    cancel(reason = 'external') {
        if (this.state === 'idle') return true;
        return this._finish(false, reason);
    }

    _finish(restoreFocus, reason) {
        ++this.generation;
        this.mutating = true;
        let complete = true;
        try {
            const owned = [...this.entries].filter(([win, entry]) =>
                entry.owned && this.d.alive(win) && win.minimized).map(([win]) => win);
            // Individual failures do not stop recovery of the other windows.
            this.d.setMinimized(owned, false);
        } catch (_error) {
            complete = false;
        }
        for (const [win, entry] of [...this.entries]) {
            if (entry.owned && this.d.alive(win) && win.minimized) {
                complete = false;
                continue;
            }
            entry.owned = false;
            this.entries.delete(win);
            this.scene?.remove(win);
            entry.lease.release(reason);
        }
        if (this.entries.size) {
            // Keep a retryable ledger if the compositor refuses restoration.
            // A later toggle retries; do not silently abandon a hidden window.
            this.state = 'exposed';
            try { this.scene?.animateTo(1, () => {}, true); }
            catch (_error) { /* Native state remains retryable if presentation died. */ }
            this.d.reportRecoveryFailure();
            this.mutating = false;
            return false;
        }
        this.d.unwatch();
        this.scene?.destroy();
        this.scene = null;
        this.state = 'idle';
        try {
            if (restoreFocus && this.focus && this.d.alive(this.focus) &&
                !this.focus.minimized && this.d.sameWorkspace(this.workspace))
                this.d.focusWindow(this.focus);
        } finally {
            this.focus = null;
            this.workspace = null;
            this.mutating = false;
        }
        return complete;
    }

    windowClosed(win) {
        if (this.mutating) return;
        const entry = this.entries.get(win);
        if (!entry) return;
        this.entries.delete(win);
        this.scene?.remove(win);
        entry.lease.release('unmanaged');
        if (!this.entries.size) this.cancel('closed');
    }

    windowChanged(win) {
        if (this.mutating || this.state === 'idle') return;
        // A user restores, moves or resizes a window. Its real state wins;
        // remaining temporary minimizations are recovered without focus theft.
        if (this.entries.has(win)) this.cancel('external-window-change');
    }
}

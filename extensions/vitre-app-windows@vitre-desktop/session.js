// Overview state is owned by GNOME. This controller only requests transitions
// at native shown/hidden boundaries and scopes the admission adapter to one use.
export class AppWindowsSession {
    constructor({overview, allowed, hasWindows, install, remove, focus, defer, cancelDeferred}) {
        Object.assign(this, {_overview: overview, _allowed: allowed, _hasWindows: hasWindows,
            _install: install, _remove: remove, _focus: focus, _defer: defer, _cancelDeferred: cancelDeferred});
        this._enabled = true;
        this._app = null;
        this._pendingApp = null;
        this._closeRequested = false;
        this._deferredId = 0;
        this._appSignal = 0;
        this._signals = [
            overview.connect('shown', () => this._onShown()),
            overview.connect('hidden', () => this._onHidden()),
        ];
    }

    toggle(app) {
        if (!this._enabled)
            return false;
        if (this._app || this._pendingApp) {
            this.cancel();
            return true;
        }
        if (!this._allowed() || !app || !this._hasWindows(app))
            return false;
        this._pendingApp = app;
        this._drive();
        return true;
    }

    _drive() {
        if (!this._enabled || !this._pendingApp)
            return;
        if (!this._allowed() || !this._hasWindows(this._pendingApp)) {
            this._pendingApp = null;
            return;
        }
        if (this._overview.animationInProgress)
            return;
        if (this._overview.visible || this._overview.visibleTarget) {
            this._overview.hide();
            return;
        }
        const app = this._pendingApp;
        this._pendingApp = null;
        this._app = app;
        try {
            this._install(app);
            this._appSignal = app.connect('windows-changed', () => {
                if (!this._hasWindows(app))
                    this.cancel();
            });
            this._overview.show();
            // A denied native modal grab can leave show() without entering.
            if (!this._overview.visible && !this._overview.animationInProgress) {
                this._overview.hide();
                this._endSession(true);
            }
        } catch (error) {
            this._endSession(true);
            throw error;
        }
    }

    _onShown() {
        if (this._closeRequested || this._pendingApp) {
            this._overview.hide();
            return;
        }
        if (this._app)
            this._focus(this._app);
    }

    _onHidden() {
        this._endSession(false);
        this._closeRequested = false;
        if (this._pendingApp && !this._deferredId) {
            // Finish native hide/teardown before creating the next native views.
            this._deferredId = this._defer(() => {
                this._deferredId = 0;
                this._drive();
            });
        }
    }

    cancel() {
        this._pendingApp = null;
        if (this._deferredId) {
            this._cancelDeferred(this._deferredId);
            this._deferredId = 0;
        }
        if (!this._app)
            return;
        this._closeRequested = true;
        // Never set native _shown during an active gesture: its next update
        // could otherwise attempt an invalid SHOWING -> SHOWING transition.
        if (!this._overview.animationInProgress) {
            this._overview.hide();
            if (!this._overview.visible)
                this._onHidden();
        }
    }

    _endSession(reconcile) {
        if (this._appSignal) {
            this._app.disconnect(this._appSignal);
            this._appSignal = 0;
        }
        this._app = null;
        this._remove({reconcile});
    }

    disable() {
        this._enabled = false;
        this._pendingApp = null;
        if (this._deferredId)
            this._cancelDeferred(this._deferredId);
        this._deferredId = 0;
        const wasActive = Boolean(this._app);
        try {
            this._endSession(wasActive && this._allowed() && !this._overview.closing);
        } finally {
            for (const id of this._signals)
                this._overview.disconnect(id);
            this._signals = [];
            this._closeRequested = false;
        }
        // During a gesture, restore the full native window list instead of
        // forcing it to close. Stable app mode can leave via native hide().
        if (wasActive && !this._overview.animationInProgress)
            this._overview.hide();
    }
}

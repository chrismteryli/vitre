// A session-scoped adapter around native Workspace admission. Never constructs
// WindowPreview, writes Meta.Window._delegate, or owns native preview actors.
export class AppAdmission {
    constructor({prototype, injection, windows, matches}) {
        this._prototype = prototype;
        this._injection = injection;
        this._windows = windows;
        this._matches = matches;
        this._views = new Map();
        this._app = null;
        this._wrapper = null;
    }

    start(app) {
        if (this._wrapper)
            throw new Error('App Windows admission is already installed');
        this._app = app;
        const owner = this;
        this._injection.overrideMethod(this._prototype, '_doAddWindow', original => {
            this._wrapper = function (window) {
                if (!owner._app)
                    return original.call(this, window);
                owner._trackView(this);
                if (owner._matches(window, owner._app))
                    return original.call(this, window);
                return undefined;
            };
            return this._wrapper;
        });
    }

    _trackView(view) {
        if (this._views.has(view))
            return;
        this._views.set(view, view.connect('destroy', () => this._views.delete(view)));
    }

    previewsForWorkspace(metaWorkspace) {
        // A sticky window can have native previews in several workspaces. Focus
        // the owner view, not window.located_on_workspace(), which is true for
        // every copy. ExtraWorkspaceView uses null for its shared monitor view.
        return [...this._views.keys()]
            .filter(view => view.metaWorkspace === null || view.metaWorkspace === metaWorkspace)
            .flatMap(view => view._windows ?? []);
    }

    stop({reconcile = false} = {}) {
        // Make any wrapper retained by another extension a neutral pass-through
        // before touching hooks. Never overwrite a newer extension's override.
        this._app = null;
        if (this._wrapper && this._prototype._doAddWindow === this._wrapper)
            this._injection.clear();
        this._wrapper = null;
        try {
            if (reconcile) {
                // Emergency disable/abort recovery only. Native admission checks
                // membership/clones. Already tracked dialogs have no standalone
                // clone: skip them too, avoiding duplicate skip-taskbar signals.
                const windows = this._windows();
                for (const view of this._views.keys()) {
                    for (const window of windows) {
                        if (!view._skipTaskbarSignals.has(window))
                            view._doAddWindow(window);
                    }
                }
            }
        } finally {
            for (const [view, id] of this._views)
                view.disconnect(id);
            this._views.clear();
        }
    }
}

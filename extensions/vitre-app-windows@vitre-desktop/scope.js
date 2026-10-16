// Provisional GNOME policy. EXPOSE-SCOPE still requires the reference design observation.
// This file filters app identity only. Native Workspace retains membership,
// monitor, minimized/full-screen, sticky-window and attached-dialog semantics.
export const SCOPE_POLICY = 'native-overview-membership-v1';

export function rootWindow(window) {
    return window?.find_root_ancestor() ?? window;
}

export function windowApp(window, tracker) {
    if (!window)
        return null;
    return tracker.get_window_app(rootWindow(window)) ?? tracker.get_window_app(window);
}

export function matchesApp(window, app, tracker) {
    return Boolean(app && window && windowApp(window, tracker) === app);
}

export function hasAppWindows(app, tracker) {
    return Boolean(app?.get_windows().some(window =>
        matchesApp(window, app, tracker) &&
        !rootWindow(window).skip_taskbar && rootWindow(window).get_compositor_private()));
}

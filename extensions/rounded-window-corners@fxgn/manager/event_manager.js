/**
 * @file Manages connections between gnome shell events and the rounded corners
 * effect. See {@link enableEffect} for more information.
 */
import { logDebug } from '../utils/log.js';
import { prefs } from '../utils/settings.js';
import { hasMetaWindow } from '../utils/types.js';
import * as handlers from './event_handlers.js';
/**
 * The rounded corners effect has to perform some actions when differen events
 * happen. For example, when a new window is opened, the effect has to detect
 * it and add rounded corners to it.
 *
 * The `enableEffect` method handles this by attaching the necessary signals
 * to matching handlers on each effect.
 */
export function enableEffect() {
    // Update the effect when settings are changed.
    connect(prefs, 'changed', handlers.onSettingsChanged);
    const wm = global.windowManager;
    // Add the effect to all windows when the extension is enabled.
    const windowActors = global.get_window_actors();
    logDebug(`Initial window count: ${windowActors.length}`);
    for (const actor of windowActors) {
        if (hasMetaWindow(actor)) {
            applyEffectTo(actor);
        }
    }
    // Add the effect to new windows when they are opened.
    connect(global.display, 'window-created', (_, win) => {
        const actor = win.get_compositor_private();
        // If wm_class_instance of Meta.Window is null, wait for it to be
        // set before applying the effect.
        if (win?.wmClass === null) {
            const notifyId = win.connect('notify::wm-class', () => {
                applyEffectTo(actor);
                win.disconnect(notifyId);
            });
        }
        else {
            applyEffectTo(actor);
        }
    });
    // Window minimized.
    connect(wm, 'minimize', (_, actor) => {
        if (hasMetaWindow(actor))
            handlers.onMinimize(actor);
    });
    // Window unminimized.
    connect(wm, 'unminimize', (_, actor) => {
        if (hasMetaWindow(actor))
            handlers.onUnminimize(actor);
    });
    // Shell's "destroy" signal starts the native close animation; it is not
    // actor destruction. Keep corners and shadow until the actor actually dies.
    // Block late asynchronous creation/refresh while its final pose fades out.
    connect(wm, 'destroy', (_, actor) => {
        if (actor.rwcLifecycle)
            actor.rwcLifecycle.closing = true;
    });
    // When windows are restacked, the order of shadow actors as well.
    connect(global.display, 'restacked', handlers.onRestacked);
}
/** Disable the effect for all windows. */
export function disableEffect() {
    // Closing actors can already have left the compositor's public window list.
    for (const actor of new Set([...global.get_window_actors(), ...trackedActors])) {
        removeEffectFrom(actor);
    }
    disconnectAll();
}
const connections = [];
const trackedActors = new Set();
/**
 * Connect a callback to an object signal and add it to the list of all
 * connections. This allows to easily disconnect all signals when removing
 * the effect.
 *
 * @param object - The object to connect the callback to.
 * @param signal - The name of the signal.
 * @param callback - The function to connect to the signal.
 */
function connect(object, signal, 
// biome-ignore lint/suspicious/noExplicitAny: Signal callbacks can have any return args and return types.
callback) {
    connections.push({
        object,
        id: object.connect(signal, callback),
    });
}
/**
 * Disconnect all connected signals from all actors or a specific object.
 * Pruning disconnected entries keeps the array from growing unboundedly as
 * windows are opened and closed over the lifetime of the session.
 *
 * @param object - If object is provided, only disconnect signals from it.
 */
function disconnectAll(object) {
    if (object === null)
        return;
    let i = connections.length;
    while (i--) {
        const connection = connections[i];
        if (object === undefined || connection.object === object) {
            connection.object.disconnect(connection.id);
            // Over time as windows open and close, connections would grow
            // indefinitely with stale entries pointing to dead window objects
            // Release the reference to the GObject so it can be garbage
            // collected after the window is closed, preventing a memory leak.
            connections.splice(i, 1);
        }
    }
}
/**
 * Apply the effect to a window.
 *
 * While {@link enableEffect} handles global events such as window creation,
 * this function handles events that happen to a specific window, like changing
 * its size or workspace.
 *
 * @param actor - The window actor to apply the effect to.
 */
function applyEffectTo(actor) {
    if (!actor || !hasMetaWindow(actor))
        return;
    if (!actor.rwcLifecycle?.active) {
        actor.rwcLifecycle = {
            active: true,
            closing: false,
            window: actor.metaWindow,
            texture: null,
        };
        trackedActors.add(actor);
        // Register before waiting for first-child/async effect eligibility, so
        // a very short-lived window cannot miss cleanup.
        connect(actor, 'destroy', () => removeEffectFrom(actor));
    }
    if (actor.rwcLifecycle.closing)
        return;
    // In wayland sessions, the surface actor of XWayland clients is sometimes
    // not ready when the window is created. In this case, we wait until it is
    // ready before applying the effect.
    if (!actor.firstChild) {
        const id = actor.connect('notify::first-child', () => {
            applyEffectTo(actor);
            actor.disconnect(id);
            const index = connections.findIndex(c => c.object === actor && c.id === id);
            if (index >= 0)
                connections.splice(index, 1);
        });
        connections.push({object: actor, id});
        return;
    }
    const texture = actor.get_texture();
    if (!texture) {
        return;
    }
    actor.rwcLifecycle.texture = texture;
    // Window resized.
    //
    // The signal has to be connected both to the actor and the texture. Why is
    // that? I have no idea. But without that, weird bugs can happen. For
    // example, when using Dash to Dock, all opened windows will be invisible
    // *unless they are pinned in the dock*. So yeah, GNOME is magic.
    connect(actor, 'notify::size', () => {
        if (actor.metaWindow) {
            handlers.onSizeChanged(actor);
        }
    });
    connect(texture, 'size-changed', () => {
        if (actor.metaWindow) {
            handlers.onSizeChanged(actor);
        }
    });
    // Get notified about fullscreen explicitly, since a window must not change in
    // size to go fullscreen
    connect(actor.metaWindow, 'notify::fullscreen', () => {
        if (actor.metaWindow) {
            handlers.onSizeChanged(actor);
        }
    });
    // Window focus changed.
    connect(actor.metaWindow, 'notify::appears-focused', () => {
        if (actor.metaWindow) {
            handlers.onFocusChanged(actor);
        }
    });
    // Workspace or monitor of the window changed.
    connect(actor.metaWindow, 'workspace-changed', () => {
        if (actor.metaWindow) {
            handlers.onFocusChanged(actor);
        }
    });
    handlers.onAddEffect(actor);
}
/**
 * Remove the effect from a window.
 *
 * @param actor - The window actor to remove the effect from.
 */
function removeEffectFrom(actor) {
    const lifecycle = actor.rwcLifecycle;
    if (lifecycle) {
        lifecycle.active = false;
        lifecycle.closing = true;
    }
    trackedActors.delete(actor);
    disconnectAll(actor);
    disconnectAll(lifecycle?.window ?? actor.metaWindow);
    const texture = lifecycle ? lifecycle.texture : actor.get_texture();
    if (texture) {
        disconnectAll(texture);
    }
    // Shadow/effect references are captured at creation, so they can still be
    // released after MetaWindow is cleared during compositor destruction.
    handlers.onRemoveEffect(actor);
}

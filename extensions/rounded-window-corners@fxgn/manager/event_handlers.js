/**
 * @file Contains the implementation of handlers for various events that need
 * to be processed by the extension. Those handlers are bound to event signals
 * in effect_manager.ts.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';
import { ClipShadowEffect } from '../effect/clip_shadow_effect.js';
import { RoundedCornersEffect } from '../effect/rounded_corners_effect.js';
import { CLIP_SHADOW_EFFECT, ROUNDED_CORNERS_EFFECT, } from '../utils/constants.js';
import { logDebug } from '../utils/log.js';
import { getPref } from '../utils/settings.js';
import { hasMetaWindow } from '../utils/types.js';
import { computeBounds, computeShadowActorOffset, computeWindowContentsOffset, getRoundedCornersCfg, getRoundedCornersEffect, isChromium, shouldEnableEffect, unwrapActor, updateShadowActorStyle, } from './utils.js';
/**
 * Per-actor queue lock to run event handlers one after another and avoid
 * needlessly refreshing the effect a lot of times.
 */
function withActorLock(actor, fn) {
    const prev = actor.rwcLock;
    const next = prev ? prev.then(fn, fn) : fn();
    actor.rwcLock = next;
    return next;
}
export function onAddEffect(actor) {
    const lifecycle = actor.rwcLifecycle;
    return withActorLock(actor, async () => {
        if (!isCurrentLifecycle(actor, lifecycle))
            return;
        logDebug(`Adding effect to ${actor?.metaWindow.wmClass}`);
        const win = actor.metaWindow;
        // Skip windows that already have the effect to prevent a memory leak
        const shouldHaveEffect = await shouldEnableEffect(win);
        if (!isCurrentLifecycle(actor, lifecycle))
            return;
        const effect = getRoundedCornersEffect(actor);
        const hasEffect = effect && actor.rwcCustomData;
        if (!shouldHaveEffect || hasEffect) {
            logDebug(`Skipping ${win.wmClass}`);
            return;
        }
        createEffect(actor);
    });
}

function isCurrentLifecycle(actor, lifecycle) {
    return lifecycle?.active && !lifecycle.closing &&
        actor.rwcLifecycle === lifecycle && hasMetaWindow(actor);
}
/**
 * Create the effect on an actor.
 *
 * @param actor - The window actor to create the effect on.
 */
function createEffect(actor) {
    const effectActor = unwrapActor(actor);
    effectActor?.add_effect_with_name(ROUNDED_CORNERS_EFFECT, new RoundedCornersEffect());
    const shadow = createShadow(actor);
    // Bind properties of the window to the shadow actor.
    const propertyBindings = [];
    for (const prop of [
        'pivot-point',
        'translation-x',
        'translation-y',
        'scale-x',
        'scale-y',
        'visible',
        'opacity',
    ]) {
        const binding = actor.bind_property(prop, shadow, prop, GObject.BindingFlags.SYNC_CREATE);
        propertyBindings.push(binding);
    }
    // Store shadow, app type, visible binding, so that we can access them later
    actor.rwcCustomData = {
        shadow,
        unminimizedTimeoutId: 0,
        propertyBindings,
        effectActor,
        deforming: false,
        deformRestoreId: 0,
        deformSignals: [],
    };
    const data = actor.rwcCustomData;
    data.deformSignals = [
        actor.connect('notify::effect', () => syncDeformShadow(actor, data)),
        // The normal visibility binding runs first; an active deformation must
        // keep its separate, undeformed shadow hidden even when actor.show()
        // runs. Other animations retain the existing visibility behavior.
        actor.connect_after('notify::visible', () => syncDeformShadow(actor, data)),
    ];
    syncDeformShadow(actor, data);
    // Make sure the effect is applied correctly.
    updateEffect(actor);
}

function hasDhruvaDeformation(actor) {
    return actor.get_effect('we-minimize-effect') ||
        actor.get_effect('we-unminimize-effect');
}

function syncDeformShadow(actor, data) {
    if (actor.rwcCustomData !== data)
        return;
    const laters = global.compositor.get_laters();
    if (hasDhruvaDeformation(actor)) {
        if (data.deformRestoreId)
            laters.remove(data.deformRestoreId);
        data.deformRestoreId = 0;
        data.deforming = true;
        data.shadow.visible = false;
    }
    else if (data.deforming) {
        data.shadow.visible = false;
        if (!data.deformRestoreId) {
            // Dhruva removes the old effect before hide/show or a replacement
            // effect is attached. Observe the final state before the next paint
            // instead of exposing a rectangular shadow between those steps.
            data.deformRestoreId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                data.deformRestoreId = 0;
                if (actor.rwcCustomData !== data)
                    return GLib.SOURCE_REMOVE;
                if (hasDhruvaDeformation(actor)) {
                    syncDeformShadow(actor, data);
                    return GLib.SOURCE_REMOVE;
                }
                data.deforming = false;
                data.shadow.visible = actor.visible;
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}

export function onRemoveEffect(actor) {
    const data = actor.rwcCustomData;
    if (!data)
        return;
    // Drop ownership first: a simultaneous destroy/disable path is idempotent.
    delete actor.rwcCustomData;
    for (const id of data.deformSignals)
        actor.disconnect(id);
    if (data.deformRestoreId)
        global.compositor.get_laters().remove(data.deformRestoreId);
    const name = ROUNDED_CORNERS_EFFECT;
    data.effectActor?.remove_effect_by_name(name);
    // Unbind all properties
    for (const binding of data.propertyBindings || []) {
        binding.unbind();
    }
    // Remove shadow actor
    const shadow = data.shadow;
    if (shadow) {
        shadow.get_constraints().forEach(constraint => {
            shadow.remove_constraint(constraint);
        });
        shadow.get_parent()?.remove_child(shadow);
        shadow.clear_effects();
        shadow.destroy();
    }
    // Remove all timeout handler
    const timeoutId = data.unminimizedTimeoutId;
    if (timeoutId) {
        GLib.source_remove(timeoutId);
    }
}
export function onMinimize(actor) {
    // Compatibility with "Compiz alike magic lamp effect".
    // When minimizing a window, disable the shadow to make the magic lamp effect
    // work.
    const magicLampEffect = actor.get_effect('minimize-magic-lamp-effect');
    const shadow = actor.rwcCustomData?.shadow;
    const roundedCornersEffect = getRoundedCornersEffect(actor);
    if (magicLampEffect && shadow && roundedCornersEffect) {
        logDebug('Minimizing with magic lamp effect');
        shadow.visible = false;
        roundedCornersEffect.enabled = false;
    }
}
export async function onUnminimize(actor) {
    const lifecycle = actor.rwcLifecycle;
    // Compatibility with "Compiz alike magic lamp effect".
    // When unminimizing a window, wait until the effect is completed before
    // showing the shadow.
    const magicLampEffect = actor.get_effect('unminimize-magic-lamp-effect');
    const shadow = actor.rwcCustomData?.shadow;
    const roundedCornersEffect = getRoundedCornersEffect(actor);
    if (magicLampEffect && shadow && roundedCornersEffect) {
        shadow.visible = false;
        const timer = magicLampEffect.timerId;
        const id = timer.connect('new-frame', source => {
            // Wait until the effect is 98% completed
            if (source.get_progress() > 0.98) {
                logDebug('Unminimizing with magic lamp effect');
                shadow.visible = true;
                roundedCornersEffect.enabled = true;
                source.disconnect(id);
            }
        });
    }
    // Chromium has a bug where windows are sometimes unminimized to the
    // wrong location, and then move to the correct position shortly after.
    // This forces an effect refresh after the window has already moved to the
    // proper position; otherwise, the effect bounds would use the wrong one and
    // cut off a part of the window.
    //
    // See https://github.com/flexagoon/rounded-window-corners/issues/124
    if ((await isChromium(actor.metaWindow)) && isCurrentLifecycle(actor, lifecycle) &&
        actor.rwcCustomData !== undefined) {
        const oldTimeout = actor.rwcCustomData.unminimizedTimeoutId;
        if (oldTimeout !== 0)
            GLib.source_remove(oldTimeout);
        actor.rwcCustomData.unminimizedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (isCurrentLifecycle(actor, lifecycle))
                refreshRoundedCorners(actor);
            return GLib.SOURCE_REMOVE;
        });
    }
}
export function onRestacked() {
    for (const actor of global.get_window_actors()) {
        const shadow = actor.rwcCustomData?.shadow;
        if (!(actor.visible && shadow)) {
            continue;
        }
        global.windowGroup.set_child_below_sibling(shadow, actor);
    }
}
export const onSizeChanged = refreshRoundedCorners;
export const onFocusChanged = refreshShadow;
export const onSettingsChanged = refreshAllRoundedCorners;
/**
 * Create the shadow actor for a window.
 *
 * @param actor - The window actor to create the shadow actor for.
 */
function createShadow(actor) {
    const shadow = new St.Bin({
        name: 'Shadow Actor',
        child: new St.Bin({
            xExpand: true,
            yExpand: true,
        }),
    });
    shadow.firstChild.add_style_class_name('shadow');
    refreshShadow(actor);
    // We have to clip the shadow because of this issue:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4474
    shadow.add_effect_with_name(CLIP_SHADOW_EFFECT, new ClipShadowEffect());
    // Draw the shadow actor below the window actor.
    global.windowGroup.insert_child_below(shadow, actor);
    // Bind position and size between window and shadow
    for (let i = 0; i < 4; i++) {
        const constraint = new Clutter.BindConstraint({
            source: actor,
            coordinate: i,
            offset: 0,
        });
        shadow.add_constraint(constraint);
    }
    return shadow;
}
/**
 * Refresh the shadow actor for a window.
 *
 * @param actor - The window actor to refresh the shadow for.
 */
function refreshShadow(actor) {
    const win = actor.metaWindow;
    const shadow = actor.rwcCustomData?.shadow;
    if (!shadow)
        return;
    const shadowSettings = win.appears_focused
        ? getPref('focused-shadow')
        : getPref('unfocused-shadow');
    const { borderRadius, padding } = getRoundedCornersCfg(win);
    updateShadowActorStyle(win, shadow, borderRadius, shadowSettings, padding);
}
/**
 * Refresh rounded corners state and settings for a window.
 *
 * @param actor - The window actor to refresh the rounded corners settings for.
 */
function refreshRoundedCorners(actor) {
    const lifecycle = actor.rwcLifecycle;
    return withActorLock(actor, async () => {
        if (!isCurrentLifecycle(actor, lifecycle))
            return;
        const win = actor.metaWindow;
        const shouldHaveEffect = await shouldEnableEffect(win);
        if (!isCurrentLifecycle(actor, lifecycle))
            return;
        const windowInfo = actor.rwcCustomData;
        const effect = getRoundedCornersEffect(actor);
        const hasEffect = effect && windowInfo;
        // onAddEffect already skips windows that shouldn't have rounded corners.
        // This if statement is just for code readability to match the check for
        // onRemoveEffect below.
        if (!hasEffect && shouldHaveEffect) {
            createEffect(actor);
            // createEffect already calls updateEffect at the end,
            // so return here to avoid running the update twice.
            return;
        }
        if (hasEffect && !shouldHaveEffect) {
            onRemoveEffect(actor);
            return;
        }
        // Don'd do anything when the window doesn't have the effect and shouldn't have it.
        if (!hasEffect)
            return;
        updateEffect(actor);
    });
}
/**
 * Update effect uniforms and constraints for a window.
 *
 * @param actor - The window actor to update the effect for.
 */
function updateEffect(actor) {
    const win = actor.metaWindow;
    const windowInfo = actor.rwcCustomData;
    if (!windowInfo)
        return;
    const effect = getRoundedCornersEffect(actor);
    if (!effect)
        return;
    if (!effect.enabled) {
        effect.enabled = true;
    }
    const cfg = getRoundedCornersCfg(win);
    const windowContentOffset = computeWindowContentsOffset(win);
    effect.updateUniforms(cfg, computeBounds(actor, windowContentOffset));
    const shadow = windowInfo.shadow;
    const offsets = computeShadowActorOffset(windowContentOffset);
    const constraints = shadow.get_constraints();
    constraints.forEach((constraint, i) => {
        if (constraint instanceof Clutter.BindConstraint) {
            constraint.offset = offsets[i];
        }
    });
    refreshShadow(actor);
}
/** Refresh rounded corners settings for all windows. */
function refreshAllRoundedCorners() {
    for (const actor of global.get_window_actors()) {
        if (hasMetaWindow(actor)) {
            refreshRoundedCorners(actor);
        }
    }
}

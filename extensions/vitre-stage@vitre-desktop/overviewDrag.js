// Vitre: drag and drop between the overview's window grid and the Stage strip.
//
//   grid window -> strip  Pick a window up in the exploded grid and carry it over the strip: the strip lights up and the window
//                         shrinks toward thumbnail size. Let go and it flies into a pile, which clicks into place; the grid
//                         closes the gap at once.
//   strip pile -> grid    The pile's window lifts out of the strip as a picture (see createDragProxy in extension.js). Let go on
//                         the grid and it flies to its new slot, which clicks into place; the grid makes room for it.
//
// Both need the swipe-depth hook (the strip stays painted in the overview, manager._railStays, and manager._gridSync puts the
// grid right after a change). Without it the overview behaves as before and nothing here does anything.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ZONE_PAD = 10;            // the drop zone reaches this far past the strip's column
const HOVER_WIDTH = 190;        // a window carried over the strip shrinks to about this wide (thumbnails are 134)
const HOVER_MS = 170;
const GLOW_MS = 200;
const REVEAL_CLICK = 1.03;      // a window that lands in the grid presses 3 % and comes back

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function warn(what, e) {
    console.warn(`Vitre Stage: overview drag ${what} failed (${e?.message ?? e})`);
}

// The workspace actor of the active workspace in the overview's grid, or null.
export function gridWorkspace() {
    const display = Main.overview._overview?.controls?._workspacesDisplay;
    const view = display?._workspacesViews?.[Main.layoutManager.primaryIndex];
    const active = global.workspace_manager.get_active_workspace();
    return view?._workspaces?.find(w => w.metaWorkspace === active) ?? view?._workspaces?.[active.index()] ?? null;
}

export function previewOf(win) {
    return gridWorkspace()?._windows?.find(p => p.metaWindow === win) ?? null;
}

// The window's frame rectangle as the preview paints it (the preview shows the window's whole buffer, shadows included, scaled
// by `sc`; the picture that flies is the frame only).
function frameInPreview(preview, win, boxX, boxY, sc) {
    const frame = win.get_frame_rect();
    const bb = preview._cachedBoundingBox ?? {x: frame.x, y: frame.y, width: frame.width, height: frame.height};
    return {
        x: boxX + (frame.x - bb.x) * sc,
        y: boxY + (frame.y - bb.y) * sc,
        width: frame.width * sc,
        height: frame.height * sc,
    };
}

// Where the window's frame sits on screen right now in its grid preview (a preview that is being dragged, scaled by DND).
export function livePoseOf(preview, win) {
    const container = preview.window_container ?? preview;
    const [x, y] = container.get_transformed_position();
    const [w] = container.get_transformed_size();
    const bb = preview._cachedBoundingBox;
    const sc = bb?.width ? w / bb.width : 1;
    return {...frameInPreview(preview, win, x, y, sc), opacity: 255, tilt: 0};
}

// Where the window's frame will sit in the grid once the layout has run: from the layout's own slot for its preview (the slot
// exists one frame after the preview was added; the preview itself is still animating its allocation then).
export function slotPoseOf(win) {
    const ws = gridWorkspace();
    const preview = previewOf(win);
    const layout = ws?._container?.layout_manager;
    const slot = layout?._windowSlots?.find(s => s[4] === preview);
    const box = layout?._windowSlotsBox;
    if (!slot || !box || !preview)
        return null;
    const container = ws._container;
    const k = container.allocation.get_width() / box.get_width();
    const [sx, sy, sw] = [slot[0] * k, slot[1] * k, slot[2] * k];
    const bb = preview._cachedBoundingBox;
    if (!bb?.width)
        return null;
    const sc = sw / bb.width;
    const local = frameInPreview(preview, win, sx, sy, sc);
    const at = (x, y) => container.apply_transform_to_point(new Graphene.Point3D({x, y, z: 0}));
    const [tw] = container.get_transformed_size();
    const ts = container.width ? tw / container.width : 1;
    const origin = at(local.x, local.y);
    let x = origin.x, y = origin.y, w = local.width * ts, h = local.height * ts;
    // the preview is lifted by swipe-depth (a scale about its pivot): the picture lands on the lifted window
    const lift = preview.scale_x || 1;
    if (Math.abs(lift - 1) > 1e-4) {
        const [fx, fy] = preview.get_pivot_point();
        const slotOrigin = at(sx, sy);
        const cx = slotOrigin.x + fx * sw * ts, cy = slotOrigin.y + fy * (slot[3] * k) * ts;
        x = cx + (x - cx) * lift;
        y = cy + (y - cy) * lift;
        w *= lift;
        h *= lift;
    }
    return {x, y, width: w, height: h, opacity: 255, tilt: 0};
}

// Run `fn` once the next frame has been laid out (the stage's after-update), or after `fallbackMs`.
function afterLayout(manager, fn, fallbackMs = 120) {
    let done = false;
    const tag = {};
    const go = () => {
        if (done)
            return;
        done = true;
        try {
            global.stage.disconnectObject(tag);
        } catch (_e) { /* stage gone */ }
        fn();
    };
    try {
        global.stage.connectObject('after-update', go, tag);
    } catch (_e) { /* the timer does it */ }
    manager._later(fallbackMs, go);
}

export class OverviewDrag {
    constructor(manager) {
        this._m = manager;
        this._zone = null;
        this._glow = null;
        this._monitor = null;
        this._drag = null;          // {win} while a grid window is being dragged
        this._hover = false;
        this._hoverBase = null;
    }

    enable() {
        const m = this._m;
        this._zone = new St.Widget({name: 'stageManagerPreviewZone', reactive: false, visible: false});
        this._glow = new St.Widget({
            name: 'stageManagerPreviewGlow', opacity: 0, reactive: false,
            style: 'background-color: rgba(120, 190, 255, 0.10); border: 1px solid rgba(170, 220, 255, 0.40); ' +
                'border-left-width: 0; border-radius: 0 28px 28px 0; box-shadow: 0 0 36px rgba(110, 190, 255, 0.35);',
        });
        this._zone._delegate = {
            handleDragOver: source => this._canDrop(source) ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE,
            acceptDrop: (source, actor) => this._accept(source, actor),
        };
        Main.layoutManager.uiGroup.add_child(this._zone);
        // the light sits under the strip's thumbnails, the hit zone over them
        Main.layoutManager.uiGroup.insert_child_below(this._glow, m._strip);
        this._glow.hide();
        Main.overview.connectObject(
            'window-drag-begin', (_o, win) => this._begin(win),
            'window-drag-end', () => this._end(),
            'window-drag-cancelled', () => this._end(),
            'hiding', () => this._end(),
            this);
        void m;
    }

    disable() {
        this._end();
        Main.overview.disconnectObject(this);
        this._zone?.destroy();
        this._zone = null;
        this._glow?.destroy();
        this._glow = null;
    }

    // -- a grid window onto the strip --

    _canPark(win) {
        const m = this._m;
        return Boolean(m._railStays && !m._disabled && Main.overview.visible && win && m._eligible(win) && !m._ours.has(win) &&
            !win.minimized && win.get_workspace() === global.workspace_manager.get_active_workspace() &&
            m._state().groups.some(g => g.windows.includes(win)));
    }

    _canDrop(source) {
        return Boolean(this._drag && source?.metaWindow === this._drag.win && this._canPark(source.metaWindow));
    }

    _zoneRect() {
        const m = this._m;
        const area = m._workArea();
        return {x: area.x, y: area.y, width: m._look.stripWidth + ZONE_PAD, height: area.height};
    }

    _begin(win) {
        this._end();
        try {
            if (!this._canPark(win))
                return;
            this._drag = {win};
            const r = this._zoneRect();
            this._zone.set_position(r.x, r.y);
            this._zone.set_size(r.width, r.height);
            this._glow.remove_all_transitions();
            this._glow.set_position(r.x, r.y);
            this._glow.set_size(r.width, r.height);
            this._glow.opacity = 0;
            this._glow.show();
            this._zone.reactive = true;
            this._zone.show();
            Main.layoutManager.uiGroup.set_child_above_sibling(this._zone, null);
            this._monitor = {
                dragMotion: event => {
                    try {
                        const z = this._zoneRect();
                        this._setHover(event.x < z.x + z.width && event.y >= z.y, event.dragActor);
                    } catch (e) {
                        warn('hover', e);
                    }
                    return DND.DragMotionResult.CONTINUE;
                },
            };
            DND.addDragMonitor(this._monitor);
        } catch (e) {
            warn('begin', e);
            this._end();
        }
    }

    _end() {
        if (this._monitor) {
            DND.removeDragMonitor(this._monitor);
            this._monitor = null;
        }
        if (this._hover)
            this._setHover(false, null);
        this._drag = null;
        if (this._zone) {
            this._zone.reactive = false;
            this._zone.hide();
        }
        const glow = this._glow;
        if (glow?.visible) {
            glow.remove_all_transitions();
            glow.ease({opacity: 0, duration: GLOW_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => {
                if (!glow.is_finalized?.() && !this._drag)
                    glow.hide();
            }});
        }
    }

    // The strip lights up and the carried window shrinks toward thumbnail size, about the pointer.
    _setHover(on, actor) {
        if (on === this._hover)
            return;
        this._hover = on;
        const ms = HOVER_MS, mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        this._glow?.ease({opacity: on ? 255 : 0, duration: GLOW_MS, mode});
        const live = actor && !actor.is_finalized?.() && actor.get_parent();
        if (on && live) {
            const [pw] = (actor.get_transformed_size());
            if (!pw)
                return;
            const [px, py] = global.get_pointer();
            const k = clamp(HOVER_WIDTH / pw, 0.3, 1);
            this._hoverBase = {actor, sx: actor.scale_x, sy: actor.scale_y, opacity: actor.opacity};
            actor.remove_transition('scale-x');
            actor.remove_transition('scale-y');
            actor.ease({
                scale_x: actor.scale_x * k, scale_y: actor.scale_y * k,
                translation_x: (1 - k) * (px - actor.x), translation_y: (1 - k) * (py - actor.y),
                opacity: Math.max(actor.opacity, 190), duration: HOVER_MS, mode,
            });
        } else if (!on && this._hoverBase) {
            const base = this._hoverBase;
            this._hoverBase = null;
            const a = base.actor;
            if (a && !a.is_finalized?.() && a.get_parent()) {
                a.ease({
                    scale_x: base.sx, scale_y: base.sy, translation_x: 0, translation_y: 0, opacity: base.opacity,
                    duration: HOVER_MS, mode,
                });
            }
        }
    }

    _clearHoverNow() {
        const base = this._hoverBase;
        this._hoverBase = null;
        this._hover = false;
        const a = base?.actor;
        if (a && !a.is_finalized?.()) {
            a.remove_all_transitions();
            a.translation_x = 0;
            a.translation_y = 0;
        }
    }

    _accept(source, dragActor) {
        const m = this._m;
        const win = source?.metaWindow;
        if (!this._canDrop(source))
            return false;
        try {
            const pose = livePoseOf(source, win);
            this._clearHoverNow();
            this._end();
            m._ovFlightOK++;
            let parked = false;
            try {
                parked = m._parkWindow(win, {detach: true, user: false, fromPose: pose});
            } finally {
                m._ovFlightOK--;
            }
            if (!parked)
                return false;
            // the window is no longer an overview window: its preview (the one under the pointer) goes now and the grid closes
            // the gap straight away instead of waiting for the pointer to rest
            m._gridSync?.({unfreeze: true});
            if (Main.overview._inWindowDrag)
                Main.overview.endWindowDrag(win);
            void dragActor;
            return true;
        } catch (e) {
            warn('drop', e);
            return false;
        }
    }

    // -- a strip pile's windows into the grid --

    // `landings`: [{win, snap, from, count}] the windows that have just been brought out of the strip by a drop on the grid.
    // Their previews join the grid hidden, and one frame later (when the layout has its slots) each picture flies from where it
    // was let go to its slot; the preview takes over there and clicks into place.
    land(landings) {
        const m = this._m;
        if (!landings.length)
            return;
        try {
            m._gridSync?.({hide: new Set(landings.map(l => l.win))});
        } catch (e) {
            warn('grid sync', e);
        }
        afterLayout(m, () => {
            if (m._disabled || !Main.overview.visible)
                return;
            for (const {win, snap, from, count} of landings) {
                const preview = previewOf(win);
                const target = slotPoseOf(win);
                if (!preview || !target || !snap) {
                    this.reveal(win, false);
                    if (!m._ours.has(win))
                        m._snapshots.delete(win);
                    continue;
                }
                m._ovFlightOK++;
                try {
                    m._startFlight(win, snap, from, target, 'in', {}, {count, p0: 0, onLanded: () => this.reveal(win, true)});
                } catch (e) {
                    warn('flight', e);
                    this.reveal(win, false);
                } finally {
                    m._ovFlightOK--;
                }
            }
        });
    }

    // The grid's own preview takes over from the flying picture and presses in place.
    reveal(win, click) {
        const preview = previewOf(win);
        if (!preview || preview.is_finalized?.())
            return;
        preview.remove_transition('opacity');
        preview.opacity = 255;
        if (click)
            this._m._clickActor(preview, REVEAL_CLICK);
    }
}

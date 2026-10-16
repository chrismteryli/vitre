import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {edgeOffset, nearestEdge, positionAt, segment} from './motion.js';

// Motion constants (12 px strip, 410 ms hide, 500 ms return, cubic-bezier(0.20, 0, 0.20, 1))
// live in motion.js with their sources. POSITION_EPSILON only decides "already there".
const POSITION_EPSILON = 0.0002;

function rect(value) {
    const result = {x: value.x, y: value.y, width: value.width, height: value.height};
    if (!Object.values(result).every(Number.isFinite) || result.width <= 0 || result.height <= 0)
        throw new Error('Invalid desktop scene geometry');
    return result;
}

function intersects(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
}

export class DesktopScene {
    constructor(windows, onRestore) {
        this._destroyed = false;
        this._generation = 0;
        this._animation = null;
        this._position = 0;
        this._elapsed = 0;
        this._entries = new Map();
        this._rootSignals = [];
        this._onRestore = onRestore;
        this._root = new Clutter.Actor({name: 'vitreDesktopScene', reactive: false,
            width: global.stage.width, height: global.stage.height});
        try {
            const monitors = Main.layoutManager.monitors.map(monitor => ({...rect(monitor), index: monitor.index}));
            // The menu bar sits on the primary monitor. A window that leaves through the top
            // edge slides UNDER it (clipped there, like the reference design) and its 12 px strip stays below.
            const primary = Main.layoutManager.primaryMonitor;
            const menuBar = monitor => primary && monitor.index === primary.index ?
                Main.layoutManager.panelBox?.height ?? 0 : 0;
            this._layers = monitors.map(monitor => {
                const actor = new Clutter.Actor({x: monitor.x, y: monitor.y, width: monitor.width,
                    height: monitor.height, reactive: false});
                const inset = menuBar(monitor);
                actor.set_clip(0, inset, monitor.width, monitor.height - inset);
                this._root.add_child(actor);
                return {actor, monitor};
            });
            // Input order is already bottom-to-top. No window sorting or real
            // actor/geometry writes belong to this in-memory presentation.
            for (const win of new Set(windows)) {
                const source = win.get_compositor_private();
                if (!source)
                    throw new Error('Window cannot be captured');
                const frame = rect(win.get_frame_rect());
                const buffer = rect(win.get_buffer_rect());
                const layers = this._layers.filter(layer => intersects(frame, layer.monitor));
                if (!layers.length)
                    throw new Error('Window is outside the desktop scene');
                const content = source.paint_to_content(null);
                if (!content)
                    throw new Error('Window snapshot unavailable');
                // The window leaves through the nearest edge of the monitor(s) it sits on.
                // Every clipped copy uses the same travel, so a window spanning
                // monitors remains one coherent shape throughout.
                const left = Math.min(...layers.map(layer => layer.monitor.x));
                const top = Math.min(...layers.map(layer => layer.monitor.y));
                const right = Math.max(...layers.map(layer => layer.monitor.x + layer.monitor.width));
                const bottom = Math.max(...layers.map(layer => layer.monitor.y + layer.monitor.height));
                const bounds = {x: left, y: top, width: right - left, height: bottom - top};
                const edge = nearestEdge(frame, bounds);
                const topInset = Math.max(0, ...layers.filter(layer => layer.monitor.y === top)
                    .map(layer => menuBar(layer.monitor)));
                const {dx, dy} = edgeOffset(frame, bounds, edge, topInset);
                const entry = {edge, dx, dy, copies: []};
                this._entries.set(win, entry);
                for (const {actor: layer, monitor} of layers) {
                    const startX = frame.x - monitor.x;
                    const startY = frame.y - monitor.y;
                    const copy = new Clutter.Actor({
                        x: startX, y: startY,
                        width: frame.width, height: frame.height,
                        clip_to_allocation: true, reactive: false,
                    });
                    copy.add_child(new Clutter.Actor({
                        content, x: buffer.x - frame.x, y: buffer.y - frame.y,
                        width: buffer.width, height: buffer.height, reactive: false,
                    }));
                    copy.connect('button-release-event', (_actor, event) => {
                        if (!this._destroyed && !this._animation && this._position === 1 &&
                            event.get_button() === 1) {
                            this._onRestore?.();
                            return Clutter.EVENT_STOP;
                        }
                        return Clutter.EVENT_PROPAGATE;
                    });
                    layer.add_child(copy);
                    entry.copies.push({actor: copy, startX, startY});
                }
            }
            // Adjacent to the real window group, below the existing Shell chrome.
            // Build all snapshots first: a failed transaction never exposes a
            // partially constructed scene or leaves actors behind in uiGroup.
            Main.layoutManager.uiGroup.insert_child_above(this._root, global.window_group);
            this._everMapped = this._root.is_mapped();
            this._rootSignals.push(this._root.connect('notify::mapped', () => {
                if (this._root.is_mapped())
                    this._everMapped = true;
                else if (this._everMapped && this._animation)
                    this._complete(this._animation.generation);
            }));
            this._rootSignals.push(this._root.connect('notify::visible', () => {
                if (!this._root.visible && this._animation)
                    this._complete(this._animation.generation);
            }));
            this._rootSignals.push(this._root.connect('destroy', () => this.destroy(true)));
        } catch (_error) {
            this.destroy();
            // Never include window titles, application data or captured pixels.
            throw new Error('Could not create the desktop window scene');
        }
    }

    _render() {
        const progress = this._position;
        for (const entry of this._entries.values()) {
            for (const {actor, startX, startY} of entry.copies)
                actor.set_position(startX + entry.dx * progress, startY + entry.dy * progress);
        }
    }

    _setReactive(reactive) {
        for (const entry of this._entries.values()) {
            for (const {actor} of entry.copies)
                actor.reactive = reactive;
        }
    }

    _stopTimeline() {
        const animation = this._animation;
        this._animation = null;
        if (!animation)
            return;
        for (const id of animation.signals)
            animation.timeline.disconnect(id);
        animation.timeline.stop();
    }

    _complete(generation) {
        const animation = this._animation;
        if (this._destroyed || !animation || animation.generation !== generation)
            return;
        this._stopTimeline();
        this._position = animation.target;
        this._render();
        this._setReactive(animation.target === 1);
        animation.callback?.();
    }

    animateTo(target, callback, reducedMotion = false) {
        if (this._destroyed)
            throw new Error('Desktop window scene has been destroyed');
        if (target !== 0 && target !== 1)
            throw new Error('Desktop scene target must be 0 or 1');
        // The displayed position is the last rendered one, so a reversal never jumps.
        // It resumes the target's own curve at the matching progress (motion.js).
        ++this._generation;
        this._stopTimeline();
        this._setReactive(false);
        const seg = segment(this._position, target);
        const timeline = new Clutter.Timeline({actor: this._root, duration: seg.duration});
        const animation = {timeline, signals: [], generation: this._generation, seg, target, callback};
        this._animation = animation;
        if (reducedMotion || !this._root.visible || !this._root.is_mapped() ||
            Math.abs(this._position - target) < POSITION_EPSILON) {
            this._complete(animation.generation);
            return;
        }
        // Frame-clock time, not wall time: the windows land where the frame is shown,
        // and the duration is the reference's absolute one (no slow-down factor).
        animation.signals.push(timeline.connect('new-frame', (_timeline, elapsed) => {
            if (this._destroyed || this._animation !== animation)
                return;
            this._elapsed = elapsed;
            this._position = positionAt(seg, target, elapsed);
            this._render();
        }));
        animation.signals.push(timeline.connect('completed', () => this._complete(animation.generation)));
        timeline.start();
    }

    remove(win) {
        const entry = this._entries.get(win);
        if (!entry)
            return;
        this._entries.delete(win);
        for (const {actor} of entry.copies)
            actor.destroy();
    }

    destroy(rootDestroyed = false) {
        if (this._destroyed)
            return;
        this._destroyed = true;
        ++this._generation;
        this._stopTimeline();
        for (const id of this._rootSignals)
            this._root.disconnect(id);
        this._rootSignals = [];
        this._entries.clear();
        this._layers = [];
        const onRestore = this._onRestore;
        this._onRestore = null;
        if (!rootDestroyed)
            this._root.destroy();
        else
            onRestore?.('scene-destroyed');
    }
}

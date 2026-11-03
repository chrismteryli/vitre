import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {edgeOffset, nearestEdge} from './motion.js';
import {Spring, Fade, role, epsFor, REDUCED, EPS_OPACITY} from './liquid.js';
import {Ticker, motionMode} from './liquidClock.js';

// The 12 px strip lives in motion.js; the motion is a liquid.js spring (see animateTo). POSITION_EPSILON only decides
// "already there".
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
        this._spring = null;            // the windows' position (0 home .. 1 parked at the edges), liquid.js
        this._veil = null;              // reduced motion: their opacity (a Fade)
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
        const op = this._veil ? Math.round(255 * this._veil.x) : 255;
        for (const entry of this._entries.values()) {
            for (const {actor, startX, startY} of entry.copies) {
                actor.set_position(startX + entry.dx * progress, startY + entry.dy * progress);
                if (actor.opacity !== op)
                    actor.opacity = op;
            }
        }
    }

    // the longest travel of any window (px): the position spring rests under a quarter of a pixel of it
    _span() {
        let most = 1;
        for (const entry of this._entries.values())
            most = Math.max(most, Math.abs(entry.dx), Math.abs(entry.dy));
        return most;
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
        animation.ticker.stop();
    }

    _complete(generation) {
        const animation = this._animation;
        if (this._destroyed || !animation || animation.generation !== generation)
            return;
        this._stopTimeline();
        this._position = animation.target;
        this._spring?.snap(animation.target);
        if (this._veil)
            this._veil.snap(1);
        this._render();
        this._veil = null;
        this._setReactive(animation.target === 1);
        animation.callback?.();
    }

    // instant: no motion at all (animations off, a forced re-park); reduced motion is read here and cross-fades
    animateTo(target, callback, instant = false) {
        if (this._destroyed)
            throw new Error('Desktop window scene has been destroyed');
        if (target !== 0 && target !== 1)
            throw new Error('Desktop scene target must be 0 or 1');
        // The displayed position is the last rendered one, and the spring keeps its speed, so a reversal never jumps.
        ++this._generation;
        this._stopTimeline();
        this._setReactive(false);
        const mode = motionMode();
        const reduced = mode === 'reduced';
        const animation = {ticker: null, generation: this._generation, target, callback};
        this._animation = animation;
        if (instant || mode === 'off' || !this._root.visible || !this._root.is_mapped() ||
            Math.abs(this._position - target) < POSITION_EPSILON) {
            this._complete(animation.generation);
            return;
        }
        const s = this._spring ??= new Spring(this._position, role('glide'), epsFor(this._span()));
        s.eps = epsFor(this._span());
        if (Math.abs(s.x - this._position) > 1e-6)
            s.snap(this._position);
        if (reduced) {
            // no travel: they fade out where they are, are moved, and fade in there (the 160 ms spring each way)
            s.snap(this._position);
            this._veil ??= new Fade(1, REDUCED, EPS_OPACITY);
            this._veil.set(0, REDUCED);
        } else {
            this._veil = null;
            s.set(target, target === 1 ? role('glide', {exit: true}) : role('glide'));
        }
        animation.ticker = new Ticker(dt => {
            if (this._destroyed || this._animation !== animation)
                return false;
            if (reduced) {
                const v = this._veil.step(dt);
                if (v === 0 && this._position !== target) {
                    this._position = target;
                    s.snap(target);
                    this._veil.set(1, REDUCED);
                }
                this._render();
                if (this._position === target && this._veil.rest && this._veil.x === 1) {
                    this._complete(animation.generation);
                    return false;
                }
                return true;
            }
            this._position = s.step(dt);
            this._render();
            if (s.rest) {
                this._complete(animation.generation);
                return false;
            }
            return true;
        }, {actor: this._root});
        animation.ticker.start();
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

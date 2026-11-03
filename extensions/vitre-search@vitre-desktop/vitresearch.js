/* VitreSearch: the bar, the results panel and the four filter buttons, as one glass field.
 *
 * Actor tree (all in "group" coordinates: origin = top-left of the wide bar):
 *   root (monitor sized, reactive: catches clicks outside)
 *     group (opacity + blur for the materialize / dematerialize)
 *       field   LegibleField: bar + panel + 4 buttons as one smooth-union shape, legible over any backdrop
 *       barBox  search glyph + entry, clipped to the bar's current width
 *       buttons Apps / Files / Actions / Clipboard
 *       panelClip -> list   result rows, clipped to the panel's current height
 *
 * Motion (motion.js, liquid.js springs; Motion Lab 2 for the open and close): open = the glass pours out of a pill at the
 * top bar's centre into the field and the content fades in at 55 % of the way; close = the content goes, the glass drains
 * back into the pill on the pour exit spring; result rows pour in top to bottom (fade + a 10 px drop on pour, staggered),
 * a row that goes fades on {r: 0.1, z: 1}; results panel on the pour spring; the filter split as springs (bar, four buttons
 * spilling out, their radius, the glyphs' fade). One Clutter.Timeline paces every track (unscaled by St's slow-down
 * factor). While the glass is above the field the field reaches up to it (its top margin follows the shape). Reduced
 * motion: opacity crosses on the 160 ms spring, nothing travels.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LegibleField, MARGIN} from './legibleField.js';
import {SearchBackend, GROUPS, GROUP_TITLES} from './searchBackend.js';
import {AppsGrid} from './appsView.js';
import {GEO, ShowMotion, PanelMotion, SplitMotion, RowMotion} from './motion.js';
import {motionMode} from './liquidClock.js';

const SPLIT_POS_MS = 800;        // the rig's split position scale (progress x this), as before
const MAX_STEP_MS = 34;          // a frame the shell held slows the motion instead of skipping it

const FX = MARGIN + 60;          // field margin left/right of the wide bar (room for the open-scale and close-growth)
const FYT = MARGIN + 44;         // field margin above the bar (close growth of a tall panel)
const FYB = MARGIN + 44;
const PAD_X = 12;                // result rows inset from the panel edge
const ROW_H = 48;
const HEAD_H = 28;
const PAD_TOP = 4;
const PAD_BOTTOM = 12;
const PT_TO_PX = 1.15;           // GNOME logical px per the reference point (plan A9 k)
const PILL_H = 21;               // the pill the glass pours out of: the height of the top bar's highlight pill ...
const PILL_W = 134;              // ... and the lab's search pill's proportion (140 x 22)
// Shell.BlurEffect radius per px of gaussian sigma. Calibrated in the rig (m-close edge 10-90 % widths,
// sigma = width / 2.563): sigma_px = 0.56 * radius, so radius = 1.78 * sigma.
const BLUR_RADIUS_PER_SIGMA = 1.78;
const BUTTONS = [
    {group: 'apps', icon: 'view-app-grid-symbolic', label: 'Applications'},
    {group: 'files', icon: 'folder-symbolic', label: 'Files'},
    {group: 'actions', icon: 'applications-system-symbolic', label: 'Actions'},
    {group: 'clipboard', icon: 'edit-paste-symbolic', label: 'Clipboard'},
];
const KIND = {apps: 'Application', actions: 'Action', files: 'File', clipboard: 'Clipboard', other: ''};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// full motion (reduced motion still cross-fades, but nothing travels)
function animationsAllowed() {
    return motionMode() === 'full';
}

export class VitreSearch {
    constructor(settings) {
        this._settings = settings;
        this._showM = new ShowMotion();
        this._panelM = new PanelMotion();
        this._splitM = new SplitMotion();
        this._lastNow = null;
        this._mode = 'closed';           // closed | opening | open | closing
        this._now = 0;
        this._epoch = 0;
        this._timeline = null;
        this._manual = false;
        this._frameLog = null;
        this._panel = {h: 0, to: 0, ref: 1, active: false};
        this._splitState = {pos: 0, dir: 0};
        this._filter = null;
        this._selected = -1;
        this._flat = [];
        this._grab = null;
        this._pointerStart = null;
        this._lastShow = {alpha: 0, glass: 0, box: null, blur: 0};
        this._rows = [];                 // RowMotion per list child (by index)
        this._top = FYT;                 // the field's margin above the bar (it reaches up to the pill while the glass is there)
        this._geom = null;
        this._ghost = false;
        this._appsMode = false;

        this._backend = new SearchBackend({
            useRemote: settings.get_boolean('use-remote-providers'),
            onChanged: () => this._onResultsChanged(),
        });
        this._build();
    }

    // ---- construction -------------------------------------------------------------------------

    _build() {
        const {H, W0, D} = GEO;
        this._root = new St.Widget({name: 'vitresearch-root', visible: false, reactive: false});
        // fx: sized to the glass field so its offscreen pass (opacity, blur) covers everything it draws;
        // group: the content, origin = top-left of the wide bar.
        this._fx = new Clutter.Actor({name: 'vitresearch-fx'});
        this._root.add_child(this._fx);
        this._field = new LegibleField();
        this._fx.add_child(this._field.actor);
        this._group = new Clutter.Actor({name: 'vitresearch-group'});
        this._group.set_position(FX, FYT);
        this._fx.add_child(this._group);

        this._barBox = new St.BoxLayout({style_class: 'sp-bar', name: 'vitresearch-bar'});
        this._barBox.set_size(W0, H);
        this._barBox.set_clip_to_allocation(true);
        this._searchIcon = new St.Icon({icon_name: 'system-search-symbolic', style_class: 'sp-search-icon', y_align: Clutter.ActorAlign.CENTER});
        this._entry = new St.Entry({style_class: 'sp-entry', hint_text: 'Vitre Search', x_expand: true, y_align: Clutter.ActorAlign.CENTER, can_focus: true});
        this._barBox.add_child(this._searchIcon);
        this._barBox.add_child(this._entry);
        this._group.add_child(this._barBox);

        this._buttons = BUTTONS.map(def => {
            const icon = new St.Icon({icon_name: def.icon, style_class: 'sp-button-icon'});
            const b = new St.Button({style_class: 'sp-button', child: icon, can_focus: false, reactive: false, track_hover: true,
                accessible_name: def.label, visible: false});
            b.set_size(D, D);
            b._def = def;
            b.connect('clicked', () => this._toggleFilter(def.group));
            this._group.add_child(b);
            return b;
        });

        this._panelClip = new Clutter.Actor({name: 'vitresearch-panel', clip_to_allocation: true, visible: false});
        this._list = new St.BoxLayout({style_class: 'sp-list', orientation: Clutter.Orientation.VERTICAL});
        this._panelClip.add_child(this._list);
        this._apps = new AppsGrid({onActivate: app => this._launchApp(app)});
        this._apps.actor.visible = false;
        this._panelClip.add_child(this._apps.actor);
        this._group.add_child(this._panelClip);

        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1.0});
        this._blur.set_enabled(false);
        this._fx.add_effect_with_name('sp-dematerialize-blur', this._blur);

        this._entry.clutter_text.connect('text-changed', () => this._onTextChanged());
        this._entry.clutter_text.connect('key-press-event', (_a, event) => this._onKey(event));
        // Return / Enter reach Clutter.Text's own activate action, not key-press-event handlers
        this._entry.clutter_text.connect('activate', () => {
            this._activateSelected();
            return Clutter.EVENT_STOP;
        });
        this._root.connect('button-press-event', (_a, event) => this._onRootPress(event));
        // A19: in the Apps view the arrow keys move through the grid while the search text is empty. Left and
        // Right are taken here, in the capture phase, because the entry's input method consumes them first.
        this._root.connect('captured-event', (_a, event) => {
            if (!this._appsMode || event.type() !== Clutter.EventType.KEY_PRESS || this._entry.get_text().length > 0)
                return Clutter.EVENT_PROPAGATE;
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Left || sym === Clutter.KEY_Right) {
                this._apps.move(sym === Clutter.KEY_Left ? -1 : 1, 0);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._root.connect('motion-event', (_a, event) => this._onMotion(event));
        Main.layoutManager.uiGroup.add_child(this._root);
        // anything that takes the screen over closes VitreSearch at once (no fade): monitors changing, the
        // overview opening, the session locking
        Main.layoutManager.connectObject('monitors-changed', () => this.closeNow(), this);
        Main.overview.connectObject('showing', () => this.closeNow(), this);
        Main.sessionMode.connectObject('updated', () => {
            if (Main.sessionMode.isLocked)
                this.closeNow();
        }, this);
    }

    destroy() {
        this.closeNow();
        this._stopTicker();
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._backend.destroy();
        this._apps?.destroy();
        this._field.destroy();
        this._root.destroy();
    }

    // ---- public API ---------------------------------------------------------------------------

    get backend() {
        return this._backend;
    }

    get mode() {
        return this._mode;
    }

    get isOpen() {
        return this._mode === 'open' || this._mode === 'opening';
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._mode === 'open' || this._mode === 'opening')
            return;
        if (Main.overview.visible || Main.overview.animationInProgress || Main.sessionMode.isLocked || Main.modalCount > 0)
            return;
        const wasClosing = this._mode === 'closing';
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
        if (!this._grab) {
            console.log('A11 VitreSearch: could not take the keyboard grab');
            return;
        }
        if (!wasClosing)
            this._resetState();
        this._place(mon);
        this._root.show();
        this._root.reactive = true;
        this._entry.grab_key_focus();
        this._mode = 'opening';
        // a reopen while it closes turns the springs around from where they are, with their speed
        if (motionMode() === 'off')
            this._showM.settle(true, this._mainRect());
        else
            this._showM.open(motionMode() === 'reduced', this._pillShape(), this._mainRect());
        this._ensureTicker();
        this._tick(this._now);
        this._pointerStart = null;
    }

    // Apps view (A19). origin: stage point the icons ripple from (the Dock button), or null
    openApps(origin = null) {
        if (!this.isOpen)
            this.open();
        if (!this.isOpen)
            return false;
        this._appsMode = true;
        this._filter = 'apps';
        this._syncFilterButtons();
        this._apps.show(origin ?? this._barCentre());
        this._refreshView();
        return true;
    }

    toggleApps(origin = null) {
        if (this.isOpen && this._appsMode)
            this.close();
        else
            this.openApps(origin);
    }

    get appsMode() {
        return this._appsMode && this.isOpen;
    }

    _barCentre() {
        const o = this._origin;
        return o ? {x: o.stageX + GEO.W0 / 2, y: o.stageY + GEO.H} : null;
    }

    _launchApp(app) {
        this.close();
        try {
            app.activate();
        } catch (e) {
            console.log(`A19 Apps: could not open ${app?.get_id?.()}: ${e.message}`);
        }
    }

    close() {
        if (this._mode === 'closed' || this._mode === 'closing')
            return;
        this._release();
        this._mode = 'closing';
        if (motionMode() === 'off') {
            this._showM.settle(false);
        } else {
            this._showM.close(motionMode() === 'reduced', this._mainRect());
            this._rows.forEach(r => r.leave(motionMode()));
        }
        this._ensureTicker();
        this._tick(this._now);
    }

    closeNow() {
        if (this._mode === 'closed')
            return;
        this._release();
        this._finishClose();
    }

    // ---- state helpers ------------------------------------------------------------------------

    _release() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._root.reactive = false;
    }

    _resetState() {
        this._backend.reset();
        this._entry.set_text('');
        this._filter = null;
        this._appsMode = false;
        if (this._apps)
            this._apps.actor.visible = false;
        this._selected = -1;
        this._flat = [];
        this._list.destroy_all_children();
        this._rows = [];
        this._ghost = false;
        this._panel = {h: 0, to: 0, ref: 1, active: false};
        this._panelM.snap(0);
        this._splitM.settle(false);
        this._splitState = {pos: 0, dir: 0};
        for (const b of this._buttons) {
            b.remove_style_pseudo_class('active');
            b.visible = false;
            b.reactive = false;
        }
    }

    _finishClose() {
        this._mode = 'closed';
        this._root.hide();
        this._root.reactive = false;
        this._blur.set_enabled(false);
        this._fx.opacity = 255;
        this._group.set_scale(1, 1);
        this._group.set_translation(0, 0, 0);
        this._group.opacity = 255;
        this._setTop(FYT);
        this._showM.settle(false);
        this._resetState();
        this._stopTicker();
    }

    _place(mon) {
        const {H, W0} = GEO;
        this._mon = mon;
        const L = Math.round((mon.width - W0) / 2);
        const T = Math.round(mon.height * GEO.TOP_FRACTION);
        this._root.set_position(mon.x, mon.y);
        this._root.set_size(mon.width, mon.height);
        this._origin = {L, T, stageX: mon.x + L, stageY: mon.y + T};
        this._field.actor.set_position(0, 0);
        this._setTop(FYT, true);
        this._maxPanel = Math.max(0, mon.height - T - H - 70);
    }

    // the field's margin above the bar: FYT at rest, more while the glass is up at the pill
    _setTop(top, force = false) {
        top = Math.ceil(top);
        if ((!force && top === this._top) || !this._origin)
            return;
        this._top = top;
        const o = this._origin;
        this._fx.set_position(o.L - FX, o.T - top);
        this._group.set_position(FX, top);
        this._field.sync(o.stageX - FX, o.stageY - top);
    }

    // the field's rectangle at rest (group coordinates): the bar and the results panel
    _mainRect() {
        const sf = this._splitM.on ? this._splitM.frame() : null;
        return {x: 0, y: 0, w: sf ? sf.barRight : GEO.W0, h: GEO.H + (this._panel?.h ?? 0)};
    }

    // the pill the glass pours out of (group coordinates): there is no search pill in the top bar, so a pill of the top bar's
    // pill height at the bar's centre, where one would be (lab 2: the search pill); with no top bar, just above the field
    _pillShape() {
        const o = this._origin;
        let y = -GEO.H;
        try {
            const panel = Main.panel;
            if (panel?.mapped) {
                const [, py] = panel.get_transformed_position();
                const [, ph] = panel.get_transformed_size();
                if (Number.isFinite(py) && ph > 0)
                    y = py + (ph - PILL_H) / 2 - o.stageY;
            }
        } catch (_e) {
            y = -GEO.H;
        }
        const cx = GEO.W0 / 2;
        // the lab's source: the whole pill, 0.8 as wide at its bottom (geomOf(P, 0.8))
        return {tY: y, bY: y + PILL_H, tCx: cx, bCx: cx, tHw: PILL_W / 2, bHw: PILL_W / 2 * 0.8};
    }

    // ---- clock --------------------------------------------------------------------------------

    _ensureTicker() {
        if (this._manual || this._timeline)
            return;
        const tl = new Clutter.Timeline({duration: 3600000, actor: this._group});
        this._timeline = tl;
        this._tickBase = this._now;
        tl.connectObject('new-frame', () => this._tick(this._tickBase + tl.get_elapsed_time()), this);
        tl.start();
    }

    _stopTicker() {
        const tl = this._timeline;
        if (!tl)
            return;
        this._timeline = null;
        tl.disconnectObject(this);
        tl.stop();
    }

    // Rig: switch to a hand-driven clock (advanceTo) so frames can be sampled at exact times.
    setManualClock(on) {
        this._manual = on;
        if (on) {
            this._stopTicker();
            this._now = 0;
        }
    }

    // Rig: paint the bare coverage of the glass shape (white on the wall) and hide the content, so a
    // screenshot is a clean silhouette of the shape that motion.js describes.
    setMeasureMode(on) {
        this._field.setDebugCoverage(on);
        this._barBox.visible = !on;
        this._panelClip.opacity = on ? 0 : this._panelClip.opacity;
        this._measure = on;
        for (const b of this._buttons)
            b.get_child().visible = !on;
    }

    advanceTo(ms) {
        this._tick(ms);
    }

    startFrameLog(on = true) {
        this._frameLog = on ? [] : null;
    }

    get frameLog() {
        return this._frameLog;
    }

    get now() {
        return this._now;
    }

    // ---- per-frame evaluation -----------------------------------------------------------------

    _tick(now) {
        const dt = this._lastNow === null ? 0 : Math.min(MAX_STEP_MS, Math.max(0, now - this._lastNow)) / 1000;
        this._lastNow = now;
        this._now = now;
        let busy = false;
        const sm = this._showM;
        if (sm.mode === 'opening')
            sm.retarget(this._mainRect());
        const show = sm.moving ? sm.step(dt) : sm.frame();
        if (this._mode === 'opening' && sm.mode === 'open') {
            this._mode = 'open';
        } else if (this._mode === 'closing' && sm.mode === 'closed') {
            this._lastShow = {alpha: 0, glass: 0, box: null, blur: 0};
            this._finishClose();
            if (this._frameLog)
                this._frameLog.push({now, closed: true});
            return;
        }
        if (this._mode === 'open')
            Object.assign(show, {alpha: 1, glass: 1, box: null, blur: 0});
        busy ||= sm.moving;
        this._lastShow = show;

        // result rows
        const nowS = now / 1000;
        for (const r of this._rows) {
            if (!r.moving)
                continue;
            r.step(dt, nowS);
            busy = true;
        }
        this._applyRows();

        // results panel height
        const p = this._panel;
        if (p.active) {
            p.h = this._panelM.step(dt);
            if (this._panelM.rest) {
                p.h = p.to;
                p.active = false;
                if (p.to === 0 && this._ghost) {
                    this._ghost = false;
                    this._list.destroy_all_children();
                }
            } else {
                busy = true;
            }
        }

        // filter split
        const spm = this._splitM;
        const sp = this._splitState;
        let sf = null;
        if (spm.moving) {
            sf = spm.step(dt);
            busy = true;
            sp.dir = spm.on ? 1 : -1;
        } else {
            sp.dir = 0;
            if (spm.on)
                sf = spm.frame();
        }
        if (sf && !spm.on && sf.rho <= 0.05 && !spm.moving)
            sf = null;
        sp.pos = sf ? Math.max(0, sf.progress) * SPLIT_POS_MS : 0;

        this._applyFrame(show, p.h, sf);

        if (this._frameLog) {
            this._frameLog.push({now, mode: this._mode, alpha: show.alpha, glass: show.glass, box: show.box, blur: show.blur,
                panelH: p.h, splitPos: sp.pos, barRight: sf ? sf.barRight : GEO.W0,
                lobes: sf ? sf.lobes.map(v => Math.round(v * 100) / 100) : null, rho: sf ? sf.rho : null, k: sf ? sf.k : null,
                paintClock: GLib.get_monotonic_time() / 1000});
        }
        if (!busy) {
            this._stopTicker();
            this._lastNow = null;
        }
    }

    _applyFrame(show, panelH, sf) {
        const {H, W0, PANEL_R} = GEO;
        const barRight = sf ? sf.barRight : W0;
        const hMain = H + panelH;
        // the glass's box (group coordinates): the pour's shape while it moves, the field itself at rest
        const b = show.box ?? {x: 0, y: 0, w: barRight, h: hMain};
        const sx = Math.max(1e-3, b.w / barRight);
        const sy = Math.max(1e-3, b.h / hMain);
        const tf = (x, y) => [b.x + x * sx, b.y + y * sy];
        // the field reaches up to the glass while it is above the bar
        this._setTop(Math.max(FYT, MARGIN + 8 - b.y));
        const top = this._top;
        const hw = b.w / 2;
        const hh = b.h / 2;
        const shapes = [{x: FX + b.x + hw, y: top + b.y + hh, w: hw, h: hh, r: Math.min(PANEL_R, hh, hw)}];
        if (sf && sf.rho > 0.05) {
            for (const c of sf.lobes) {
                const [lx, ly] = tf(c, H / 2);
                const rw = sf.rho * sx;
                const rh = sf.rho * sy;
                shapes.push({x: FX + lx, y: top + ly, w: rw, h: rh, r: Math.min(rw, rh)});
            }
        }
        const k = (sf ? sf.k : 3) * Math.min(1, sx, sy);
        const fieldW = W0 + 2 * FX;
        const fieldH = top + Math.max(b.y + b.h, 0) + FYB;
        this._fx.set_size(fieldW, fieldH);
        this._field.actor.set_size(fieldW, fieldH);
        this._field.setFieldSize(fieldW, fieldH);
        this._field.setShapes(shapes, k);
        this._geom = {shapes, k, fieldW, fieldH, barRight, hMain};

        // the glass's alpha on the whole field; the content follows the box and fades on its own
        this._fx.opacity = Math.round(clamp(show.glass ?? show.alpha, 0, 1) * 255);
        this._group.set_pivot_point(0, 0);
        this._group.set_scale(sx, sy);
        this._group.set_translation(b.x, b.y, 0);
        this._group.opacity = Math.round(clamp(show.alpha, 0, 1) * 255);
        if (show.blur > 0.02) {
            this._blur.radius = Math.max(1, Math.round(show.blur * PT_TO_PX * BLUR_RADIUS_PER_SIGMA));
            this._blur.set_enabled(true);
        } else if (this._blur.enabled) {
            this._blur.set_enabled(false);
        }

        // content
        this._barBox.set_size(Math.max(H, barRight), H);
        if (panelH > 0.5) {
            this._panelClip.visible = true;
            this._panelClip.set_position(0, H);
            this._panelClip.set_size(barRight, panelH);
            this._list.set_position(PAD_X, PAD_TOP);
            const w = Math.max(10, barRight - 2 * PAD_X);
            if (Math.abs(this._list.width - w) > 0.5)
                this._list.set_width(w);
            if (this._appsMode && this._apps) {
                const gw = Math.max(10, barRight - 2 * PAD_X);
                this._apps.actor.set_position(PAD_X, 0);
                if (Math.abs(this._apps.actor.width - gw) > 0.5)
                    this._apps.actor.set_width(gw);
                // the scroller fills the panel's FINAL height; the clip reveals it as the panel grows
                this._apps.fitTo(Math.max(panelH, this._panel.to));
            }
            const target = Math.max(1, this._panel.ref);
            // full motion: the rows fade on their own springs; the Apps view and reduced motion keep the panel's reveal
            const reveal = this._appsMode || !animationsAllowed() ? clamp((panelH / target - 0.15) / 0.45, 0, 1) : 1;
            this._panelClip.opacity = this._measure ? 0 : Math.round(255 * reveal);
        } else {
            this._panelClip.visible = false;
        }
        this._applyButtons(sf);
    }

    _applyButtons(sf) {
        const {H, D} = GEO;
        const show = sf && sf.rho > D / 2 - 6;
        for (let i = 0; i < this._buttons.length; i++) {
            const b = this._buttons[i];
            if (!show) {
                b.visible = false;
                b.reactive = false;
                continue;
            }
            b.visible = true;
            b.set_position(sf.lobes[i] - D / 2, H / 2 - D / 2);
            b.opacity = Math.round(255 * sf.iconAlpha);
            b.reactive = sf.iconAlpha >= 1 || this._splitState.pos >= 467;
        }
    }

    // ---- filters ------------------------------------------------------------------------------

    get isSplit() {
        return this._splitM.on;
    }

    showFilters(on = true) {
        if (this._mode === 'closed' || this._mode === 'closing')
            return;
        if (on === this.isSplit)
            return;
        const mode = motionMode();
        if (mode === 'off')
            this._splitM.settle(on);
        else
            this._splitM.set(on, mode === 'reduced');
        this._ensureTicker();
        this._tick(this._now);
    }

    _toggleFilter(group) {
        if (group === 'apps') {
            if (this._appsMode) {
                this._appsMode = false;
                this._setFilter(null);
            } else {
                const b = this._buttons.find(x => x._def.group === 'apps');
                const [bx, by] = b ? b.get_transformed_position() : [0, 0];
                this.openApps(b ? {x: bx + GEO.D / 2, y: by + GEO.D / 2} : null);
            }
            return;
        }
        this._appsMode = false;
        this._setFilter(this._filter === group ? null : group);
    }

    _setFilter(group) {
        this._filter = group;
        if (group === 'clipboard')
            this._backend.refreshClipboard();
        this._syncFilterButtons();
        this._refreshView();
    }

    _syncFilterButtons() {
        for (const b of this._buttons) {
            if (b._def.group === this._filter)
                b.add_style_pseudo_class('active');
            else
                b.remove_style_pseudo_class('active');
        }
    }

    _cycleFilter(dir) {
        const order = [null, ...GROUPS];
        const i = order.indexOf(this._filter);
        this._setFilter(order[(i + dir + order.length) % order.length]);
    }

    // ---- input --------------------------------------------------------------------------------

    _onKey(event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        switch (sym) {
        case Clutter.KEY_Escape:
            if (this._entry.get_text().length > 0)
                this._entry.set_text('');
            else
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            if (this._appsMode)
                this._apps.move(0, 1);
            else
                this._moveSelection(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            if (this._appsMode)
                this._apps.move(0, -1);
            else
                this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Left:
        case Clutter.KEY_Right:
            if (this._appsMode && this._entry.get_text().length === 0) {
                this._apps.move(sym === Clutter.KEY_Left ? -1 : 1, 0);
                return Clutter.EVENT_STOP;
            }
            break;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            if (!this.isSplit && !(this._splitState.dir < 0))
                this.showFilters(true);
            else
                this._cycleFilter(shift || sym === Clutter.KEY_ISO_Left_Tab ? -1 : 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_n:
        case Clutter.KEY_N:
            if (ctrl) {
                this._moveSelection(1);
                return Clutter.EVENT_STOP;
            }
            break;
        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (ctrl) {
                this._moveSelection(-1);
                return Clutter.EVENT_STOP;
            }
            break;
        default:
            break;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _inShape(x, y) {
        // x, y in group coordinates; the bar/panel rectangle or any button
        const g = this._geom;
        if (!g)
            return false;
        const {H, D} = GEO;
        if (x >= 0 && x <= g.barRight && y >= 0 && y <= g.hMain)
            return true;
        for (const b of this._buttons) {
            if (!b.visible)
                continue;
            const bx = b.x + D / 2;
            const by = b.y + D / 2;
            if (Math.hypot(x - bx, y - by) <= D / 2 + 2)
                return true;
        }
        return false;
    }

    _onRootPress(event) {
        const [sx, sy] = event.get_coords();
        const [ok, x, y] = this._group.transform_stage_point(sx, sy);
        if (ok && this._inShape(x, y))
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._settings.get_boolean('filters-on-pointer') || this._mode !== 'open')
            return Clutter.EVENT_PROPAGATE;
        if (this.isSplit || this._splitState.dir !== 0 || this._entry.get_text().length > 0)
            return Clutter.EVENT_PROPAGATE;
        const [sx, sy] = event.get_coords();
        if (!this._pointerStart) {
            this._pointerStart = [sx, sy];
            return Clutter.EVENT_PROPAGATE;
        }
        const [ok, x, y] = this._group.transform_stage_point(sx, sy);
        if (!ok || !this._inShape(x, y))
            return Clutter.EVENT_PROPAGATE;
        if (Math.hypot(sx - this._pointerStart[0], sy - this._pointerStart[1]) >= 8)
            this.showFilters(true);
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- results ------------------------------------------------------------------------------

    _onTextChanged() {
        if (this._mode === 'closed' || this._mode === 'closing')
            return;
        if (!this._appsMode)
            this._backend.setQuery(this._entry.get_text());
        this._refreshView();
    }

    _onResultsChanged() {
        if (this._mode === 'closed' || this._mode === 'closing')
            return;
        this._refreshView();
    }

    _refreshView() {
        if (this._appsMode) {
            this._ghost = false;
            this._list.destroy_all_children();
            this._rows = [];
            this._list.visible = false;
            this._apps.actor.visible = true;
            this._apps.setQuery(this._entry.get_text());
            this._setPanelTarget(Math.min(this._maxPanel ?? 600, this._apps.naturalHeight));
            return;
        }
        this._list.visible = true;
        if (this._apps)
            this._apps.actor.visible = false;
        const text = this._entry.get_text().trim();
        const maxRows = Math.max(3, Math.floor((this._maxPanel ?? 600) / ROW_H) - 2);
        const hasQuery = text.length > 0;
        const clipOnly = this._filter === 'clipboard';
        let view = {top: null, sections: [], rows: 0};
        if (hasQuery || clipOnly)
            view = this._backend.view(this._filter, maxRows);
        this._flat = [];
        // when the results vanish the panel collapses: keep the old rows on screen (clipped and faded by the
        // shrinking panel) instead of showing an empty box, and drop them when the collapse is over
        const keepGhost = !(view.top || view.sections.length) && !(hasQuery || clipOnly) && this._panel.h > 0.5 &&
            animationsAllowed() && (this._mode === 'open' || this._mode === 'opening');
        this._ghost = keepGhost;
        if (!keepGhost)
            this._list.destroy_all_children();
        const addSection = (title, items) => {
            if (title)
                this._list.add_child(new St.Label({text: title, style_class: 'sp-section'}));
            for (const it of items)
                this._list.add_child(this._makeRow(it));
        };
        let height = 0;
        if (view.top) {
            addSection('Top Hit', [view.top]);
            height += HEAD_H + ROW_H;
        }
        for (const s of view.sections) {
            addSection(GROUP_TITLES[s.group], s.items);
            height += HEAD_H + ROW_H * s.items.length;
        }
        if (!view.rows && (hasQuery || clipOnly) && !this._backend.searching) {
            this._list.add_child(new St.Label({text: 'No Results', style_class: 'sp-empty'}));
            height = ROW_H + 8;
        }
        const target = height > 0 ? Math.min(this._maxPanel ?? 600, PAD_TOP + height + PAD_BOTTOM) : 0;
        this._selected = this._flat.length ? Math.min(Math.max(this._selected, 0), this._flat.length - 1) : -1;
        if (this._flat.length && this._selected < 0)
            this._selected = 0;
        this._syncSelection();
        this._syncRows(keepGhost);
        this._setPanelTarget(target);
    }

    // the rows: the ones that are new pour in top to bottom, the ones that went fade (a ghost list fades as a whole)
    _syncRows(ghost) {
        const mode = motionMode();
        const count = this._list.get_n_children();
        const n = ghost ? 0 : count;
        const now = this._now / 1000;
        while (this._rows.length < count)
            this._rows.push(new RowMotion());
        this._rows.forEach((r, i) => (i < n ? r.arrive(now, i, mode) : r.leave(mode)));
        this._applyRows();
        if (this._rows.some(r => r.moving)) {
            this._ensureTicker();
            this._tick(this._now);
        }
    }

    _applyRows() {
        const kids = this._list.get_children();
        this._rows.forEach((r, i) => {
            const a = kids[i];
            if (!a)
                return;
            a.opacity = Math.round(255 * clamp(r.o.x, 0, 1));
            a.translation_y = r.y.x;
        });
    }

    _makeRow(item) {
        const box = new St.BoxLayout({style_class: 'sp-row-content', x_expand: true});
        let icon = null;
        try {
            icon = item.meta.createIcon(32);
        } catch (e) {
            console.log(`A11 VitreSearch: icon failed for ${item.id}: ${e.message}`);
        }
        if (icon) {
            icon.add_style_class_name('sp-row-icon');
            icon.y_align = Clutter.ActorAlign.CENTER;
            box.add_child(icon);
        }
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        text.add_child(new St.Label({text: item.meta.name, style_class: 'sp-row-title'}));
        const sub = (item.meta.description ?? '').split('\n')[0];
        if (sub)
            text.add_child(new St.Label({text: sub, style_class: 'sp-row-sub'}));
        box.add_child(text);
        const kind = new St.Label({text: KIND[item.group] ?? '', style_class: 'sp-row-kind', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(kind);
        const row = new St.Button({style_class: 'sp-row', child: box, can_focus: false, reactive: true, track_hover: true, x_expand: true});
        row._item = item;
        row.connect('clicked', () => {
            this._selected = this._flat.indexOf(row);
            this._activateSelected();
        });
        this._flat.push(row);
        return row;
    }

    _syncSelection() {
        this._flat.forEach((row, i) => {
            if (i === this._selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
    }

    _moveSelection(d) {
        if (!this._flat.length)
            return;
        this._selected = clamp((this._selected < 0 ? -1 : this._selected) + d, 0, this._flat.length - 1);
        this._syncSelection();
    }

    _activateSelected() {
        if (this._appsMode) {
            this._apps.activateSelected();
            return;
        }
        this._backend.flush();
        const row = this._flat[this._selected];
        if (!row)
            return;
        const item = row._item;
        this.close();
        // activate after the grab is gone so the launched app gets the focus
        this._backend.activate(item);
    }

    _setPanelTarget(target) {
        const p = this._panel;
        if (target > 0)
            p.ref = target;
        if (Math.abs(target - p.to) < 0.5)
            return;
        if (!animationsAllowed() || this._mode === 'closed' || this._mode === 'closing') {
            p.h = target;
            p.to = target;
            this._panelM.snap(target);
            p.active = false;
            if (target === 0 && this._ghost) {
                this._ghost = false;
                this._list.destroy_all_children();
            }
            if (this._mode === 'open' || this._mode === 'opening') {
                this._ensureTicker();
                this._tick(this._now);
            }
            return;
        }
        p.to = target;
        this._panelM.to(target, false);
        p.active = true;
        this._ensureTicker();
        this._tick(this._now);
    }
}

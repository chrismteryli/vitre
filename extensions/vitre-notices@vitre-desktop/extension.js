import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {formatDateWithCFormatString} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {UndoJournal, NCGEO, columnOrigin, columnMaxHeight, pairUp,
    configuredWidgetVisible, notificationSectionVisible} from './helpers.js';
import {GlassLayer} from './glass.js';
import {PlateLayout} from './plate.js';
import {LiquidGlassDateMenuBridge} from './liquidGlassBridge.js';
import {installPopupMotion} from './popupMotion.js';
import {DripController} from './liquidDrip.js';
import {DripStyle} from './dripStyle.js';
import {NCDripAdapter} from './ncDrip.js';
import {CardFeedback, installStackMotion} from './cardFeedback.js';
import {AnalogClockWidget, WeatherWidget} from './widgets.js';

function requireCondition(condition) {
    if (!condition)
        throw new Error('Notification Center requires the verified GNOME 51 date-menu structure');
}

function isActor(actor) {
    return actor instanceof Clutter.Actor &&
        typeof actor.get_parent === 'function' &&
        typeof actor.add_style_class_name === 'function';
}

/* Validate every private dependency and parent chain before changing anything. */
function inspectNativeMenu() {
    const dateMenu = Main.panel.statusArea.dateMenu;
    const menu = dateMenu?.menu;
    const pointer = menu?._boxPointer;
    const messages = dateMenu?._messageList;
    const scroll = messages?._scrollView;
    const view = messages?._messageView;
    const date = dateMenu?._date;
    const calendar = dateMenu?._calendar;
    const events = dateMenu?._eventsItem;
    const clocks = dateMenu?._clocksItem;
    const weather = dateMenu?._weatherItem;
    for (const actor of [menu?.box, menu?.actor, messages, scroll, view,
        date, calendar, events, clocks, weather])
        requireCondition(isActor(actor));
    requireCondition(pointer === menu.actor &&
        typeof pointer._reposition === 'function' &&
        typeof menu.close === 'function' &&
        typeof date.setDate === 'function' &&
        typeof calendar.setDate === 'function' &&
        typeof messages.setCaptureContainer === 'function' &&
        typeof view._scrollToExpandedGroup === 'function');
    requireCondition(isActor(date._dayLabel) && isActor(date._dateLabel) &&
        scroll.child === view && Array.isArray(clocks._locations) &&
        typeof clocks._settings?.connect === 'function' &&
        typeof weather._weatherClient?.connect === 'function');
    const messageBox = scroll.get_parent();
    const calendarArea = messages.get_parent();
    let originalBin = calendarArea;
    while (originalBin && originalBin.get_parent() !== menu.box)
        originalBin = originalBin.get_parent();
    requireCondition(isActor(messageBox) && isActor(calendarArea) &&
        isActor(originalBin) && originalBin.get_parent() === menu.box &&
        originalBin.contains(messages) && originalBin.contains(date) &&
        originalBin.contains(calendar) && originalBin.contains(events) &&
        originalBin.contains(clocks) && originalBin.contains(weather));
    requireCondition(messages.contains(messageBox) &&
        typeof scroll.enable_mouse_scrolling === 'boolean' &&
        typeof scroll.enable_touch_scrolling === 'boolean');
    return {dateMenu, menu, pointer, messages, scroll, view, date, calendar,
        events, clocks, weather, messageBox, originalBin};
}

export default class NotificationCenter extends Extension {
    enable() {
        this._enabled = true;
        this._active = false;
        this._pending = new Set();
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncSession());
        try {
            this._syncSession();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._enabled = false;
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = 0;
        }
        this._deactivate();
    }

    _syncSession() {
        if (!this._enabled)
            return;
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
            this._deactivate();
            return;
        }
        if (!this._active)
            this._activate();
    }

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._journal.add(() => object.disconnect(id));
    }

    _class(actor, name) {
        if (actor.has_style_class_name(name))
            return;
        actor.add_style_class_name(name);
        this._journal.add(() => actor.remove_style_class_name(name));
    }

    _own(actor) {
        // Registered before reparent operations, so rollback returns all native
        // children before destroying the new containers.
        this._journal.add(() => actor.destroy());
        return actor;
    }

    _activate() {
        const native = inspectNativeMenu();
        this._native = native;
        this._gone = false;
        this._journal = new UndoJournal();
        this._plates = new Map();     // message -> {journal, plate, layout, layer}
        this._fb = new Map();         // message -> CardFeedback (A13)
        // A17: liquid drip (drip-style liquid | classic, read from the liquid-menus schema; liquid if it is absent)
        this._dripStyle = new DripStyle();
        this._dripAdapter = new NCDripAdapter(this);
        this._drip = {style: this._dripStyle, controller: new DripController('nc', this._dripAdapter, {prewarm: 12, prewarmIf: () => this._dripStyle?.liquid})};
        this._watched = new Set();
        this._smallWidgets = [];
        this._bridge = new LiquidGlassDateMenuBridge({onError: () => {
            this._deactivate();
            console.error('Notification Center restored the native menu after a glass lifecycle mismatch');
        }});
        try {
            this._bridge.enable();
            native.menu.close({animate: false});
            // Liquid Glass can apply scale even with its date effect disabled.
            // Normalize both native animation roots after its cleanup, recording
            // values for restoration before the bridge recreates its manager.
            for (const actor of [native.menu.actor, native.menu.box]) {
                for (const [key, value] of [['scale_x', 1], ['scale_y', 1],
                    ['translation_x', 0], ['translation_y', 0], ['opacity', 255]])
                    this._journal.property(actor, key, value);
            }
            this._build(native);
            // At shell shutdown the date menu is destroyed before any extension is disabled; from then on nothing of the
            // native menu may be touched (every access logs "already disposed"), so the skin goes inert at once.
            this._connect(native.menu.actor, 'destroy', () => {
                this._gone = true;
                this._active = false;
                this._stopTick();
            });
            this._active = true;
            this._tidyCalendar();
            this._updateGeometry();
            this._updateWidgets();
            native.date.setDate(new Date());
            this._watch(native.view);
            this._scrollFresh = true;
        } catch (error) {
            this._deactivate();
            throw error;
        }
    }

    _build(n) {
        const j = this._journal;
        const outer = this._own(new St.ScrollView({
            style_class: 'nc-scroll', x_expand: false,
            y_expand: false, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        }));
        const column = this._own(new St.BoxLayout({
            style_class: 'nc-column', orientation: Clutter.Orientation.VERTICAL,
            x_expand: false, y_expand: false,
        }));
        outer.child = column;
        // Native menu emptiness/delegate handling expects this menu-box child.
        outer._delegate = n.dateMenu;
        const notificationSection = this._own(new St.BoxLayout({
            style_class: 'nc-notification-section',
            orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        }));
        const calendarCard = this._own(new St.BoxLayout({
            style_class: 'nc-widget nc-calendar-widget nc-medium',
            orientation: Clutter.Orientation.HORIZONTAL, x_expand: true,
        }));
        const summary = this._own(new St.BoxLayout({
            style_class: 'nc-calendar-summary',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.START,
        }));
        calendarCard.add_child(summary);
        const widgetsBox = this._own(new St.BoxLayout({
            style_class: 'nc-widgets-box', orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        }));
        this._outer = outer;
        this._column = column;
        this._calendarCard = calendarCard;
        this._summary = summary;
        this._widgetsBox = widgetsBox;
        this._notificationSection = notificationSection;

        for (const [actor, cls] of [[n.menu.actor, 'nc-panel'],
            [n.menu.box, 'nc-surface'], [n.messages, 'nc-notifications'],
            [n.date, 'nc-date-header'], [n.calendar, 'nc-month'],
            [n.events, 'nc-agenda'], [n.dateMenu, 'nc-button']])
            this._class(actor, cls);

        // Native message list retains capture gestures, notification signals,
        // content actors and adjustment bindings. It is now natural-height;
        // wheel/touch scroll is handled only by the outer viewport.
        for (const actor of [n.messages, n.messageBox, n.scroll, n.view])
            j.property(actor, 'y_expand', false);
        j.property(n.scroll, 'hscrollbar_policy', St.PolicyType.NEVER);
        j.property(n.scroll, 'vscrollbar_policy', St.PolicyType.NEVER);
        j.property(n.scroll, 'enable_mouse_scrolling', false);
        j.property(n.scroll, 'enable_touch_scrolling', false);
        j.property(n.scroll.vadjustment, 'value', 0);

        const originalIndex = n.menu.box.get_children().indexOf(n.originalBin);
        j.move(n.originalBin, null);
        n.menu.box.insert_child_at_index(outer, originalIndex);
        column.add_child(notificationSection);
        j.move(n.messages, notificationSection);
        column.add_child(calendarCard);
        j.move(n.date, summary);
        j.move(n.events, summary);
        j.move(n.calendar, calendarCard);
        column.add_child(widgetsBox);
        // The native clocks / weather sections stay in the detached original container: they
        // keep updating their data, and the small widgets above read it.

        // Native collapse gestures and Escape cover all content. The new outer
        // scrollbar stays outside that capture ancestry, so dragging it does
        // not collapse the expanded group. PopupMenu still owns outside clicks.
        const captureContainer = n.messages._captureContainer;
        j.add(() => n.messages.setCaptureContainer(captureContainer));
        n.messages.setCaptureContainer(column);

        // Restore exact native styles after responsive inline bounds.
        const savedMessagesStyle = n.messages.get_style();
        j.add(() => n.messages.set_style(savedMessagesStyle));
        this._messagesStyle = savedMessagesStyle || '';

        const adapter = this;
        this._styleCalendar(n);

        // Right edge 13 px from the monitor edge, 23 px under the bar.
        j.method(n.pointer, '_reposition', original => function (allocationBox) {
            original.call(this, allocationBox);
            if (!adapter._active)
                return;
            adapter._dripAdapter.allocCount++;
            const area = this._workArea;
            if (!area)
                return;
            const pad = NCGEO.clipPad;
            const target = columnOrigin(area, allocationBox.get_width() - 2 * pad);
            target.x -= pad;
            target.y -= pad;
            let parent = this.get_parent();
            let success = false;
            let x = 0;
            let y = 0;
            while (!success && parent) {
                [success, x, y] = parent.transform_stage_point(target.x, target.y);
                parent = parent.get_parent();
            }
            if (success)
                allocationBox.set_origin(Math.floor(x), Math.floor(y));
        });
        j.property(n.pointer, '_dripOwned', true);   // A17: Liquid Menus leaves this menu to us
        installPopupMotion(n.pointer, j, () => this._active, this._drip);
        // A13: stacks expand / collapse on the slide curve shape
        try {
            installStackMotion(j, () => this._active);
        } catch (error) {
            console.error(`Notification Center stack motion skipped: ${error.message}`);
        }

        // Do not center/scroll a notification group inside the disabled inner
        // viewport; expose its first native card in the outer scroll instead.
        j.method(n.view, '_scrollToExpandedGroup', original => function () {
            if (!adapter._active)
                return original.call(this);
            // A group may be taller than the screen. Its first card (not the
            // whole group's bottom) is the useful initial reveal target.
            const firstCard = this.expandedGroup?.get_first_child()?.child;
            adapter._queueFocusReveal(firstCard);
        });

        this._originalSetDate = j.method(n.date, 'setDate', original => function (date) {
            original.call(this, date); // Native full-date accessible name stays.
            if (!adapter._active)
                return;
            this._dayLabel.set_text(formatDateWithCFormatString(date, '%A').toUpperCase());
            this._dateLabel.set_text(formatDateWithCFormatString(date, '%-d'));
        });
        this._connect(n.calendar, 'selected-date-changed', (_calendar, dateTime) => {
            n.date.setDate(new Date(dateTime.to_unix() * 1000 +
                dateTime.get_microsecond() / 1000));
        });
        this._connect(n.menu, 'open-state-changed', (_menu, open) => {
            if (!open) {
                this._stopTick();
                for (const fb of this._fb?.values() ?? [])
                    fb.reset?.();
                return;
            }
            this._outer.vadjustment.value = 0;
            this._updateWidgets();
            this._updateGeometry();
            this._startTick();
            this._refreshGlass();
        });
        this._connect(this._outer.vadjustment, 'notify::value', () => this._refreshGlass());
        this._connect(n.view, 'message-focused', (_view, actor) => this._queueFocusReveal(actor));
        this._connect(n.view, 'notify::empty', () => this._updateWidgets());
        this._connect(n.messages, 'notify::visible', () => this._updateWidgets());
        this._connect(global.stage, 'notify::key-focus', () => {
            if (!this._active)
                return;
            const focus = global.stage.get_key_focus();
            if (n.menu.isOpen && focus && this._outer.contains(focus))
                this._queueFocusReveal(focus);
        });
        this._connect(Main.layoutManager, 'monitors-changed', () => this._updateGeometry());
        this._connect(global.display, 'workareas-changed', () => this._updateGeometry());
        this._connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => this._updateGeometry());
        for (const actor of [n.clocks, n.weather])
            this._connect(actor, 'notify::visible', () => this._updateWidgets());
        this._connect(n.clocks._settings, 'changed::locations', () => this._updateWidgets());
        this._connect(n.weather._weatherClient, 'changed', () => this._updateWidgets());
    }

    // ---- calendar widget: day numbers without leading zeros, only this month's days, no arrows ----

    _tidyCalendar() {
        const cal = this._native?.calendar;
        if (!cal || !this._active)
            return;
        for (const button of cal._buttons ?? []) {
            const date = button._date;
            if (!date)
                continue;
            if (button.has_style_class_name('calendar-other-month')) {
                button.label = '';
                button.reactive = false;
                button.can_focus = false;
            } else {
                button.label = String(date.getDate());
            }
        }
        if (cal._monthLabel)
            cal._monthLabel.text = cal._monthLabel.text.toUpperCase();
    }

    _styleCalendar(n) {
        const j = this._journal;
        const cal = n.calendar;
        const adapter = this;
        // registered first, so it runs after the method overrides are undone: native digits and
        // month label come back with the original methods
        j.add(() => {
            cal._rebuildCalendar();
            cal._update();
        });
        j.method(cal, '_rebuildCalendar', original => function () {
            original.call(this);
            adapter._tidyCalendar();
        });
        j.method(cal, '_update', original => function () {
            original.call(this);
            adapter._tidyCalendar();
        });
        j.property(cal._backButton, 'visible', false);
        j.property(cal._forwardButton, 'visible', false);
        j.property(cal._monthLabel, 'x_align', Clutter.ActorAlign.START);
        j.property(cal._monthLabel, 'x_expand', true);
        this._tidyCalendar();
    }

    // ---- cards: every notification becomes one glass plate ------------------------------

    _isMessage(actor) {
        return actor instanceof St.Button && actor.has_style_class_name('message') &&
            actor._header && actor.titleLabel;
    }

    _watch(actor) {
        if (!this._active || !actor)
            return;
        if (this._isMessage(actor)) {
            this._styleMessage(actor);
            return;
        }
        if (typeof actor.get_children !== 'function' || this._watched.has(actor))
            return;
        this._watched.add(actor);
        actor.connectObject('child-added', (_a, child) => this._watch(child), this);
        this._journal.add(() => actor.disconnectObject(this));
        for (const child of actor.get_children())
            this._watch(child);
    }

    _styleMessage(message) {
        if (this._plates.has(message) || !message.get_child())
            return;
        const mj = new UndoJournal();
        const vbox = message.get_child();
        const header = message._header;
        const layer = new GlassLayer({radius: NCGEO.cardRadius});
        layer.actor._plateRole = 'glass';
        const layout = new PlateLayout(layer, () => this._native?.pointer.translation_x ?? 0);
        const plate = new St.Widget({layout_manager: layout, x_expand: true, y_expand: true,
            style_class: 'nc-plate'});
        const rim = new St.Widget({style_class: 'nc-card-rim', reactive: false});
        rim._plateRole = 'rim';
        vbox._plateRole = 'content';
        // runs last: by then every borrowed actor is back in its native parent
        mj.add(() => {
            layer.destroy();
            plate.destroy();
        });

        // title row: title + time on one line; the reference's card has no app-name header
        const contentBox = message.titleLabel.get_parent();
        const titleRow = new St.BoxLayout({style_class: 'nc-title-row', x_expand: true});
        mj.add(() => titleRow.destroy());
        const sourceIcon = header.get_first_child();
        const headerContent = sourceIcon.get_next_sibling();
        const sourceTitle = headerContent.get_first_child();
        mj.property(sourceIcon, 'visible', false);
        mj.property(sourceTitle, 'visible', false);
        // the reference's card shows the app's own (full-colour) icon at 37 px; only when no app is known
        // does the current symbolic-in-a-square icon stay
        const appIcon = message.notification?.source?.app?.get_icon?.() ?? null;
        if (appIcon) {
            mj.property(message._icon, 'gicon', appIcon);
            mj.property(message._icon, 'visible', true);
        } else if (!message._icon.gicon && sourceIcon.gicon) {
            mj.property(message._icon, 'gicon', sourceIcon.gicon);
            mj.property(message._icon, 'visible', true);
        }
        mj.property(message.titleLabel, 'x_expand', true);
        contentBox.insert_child_at_index(titleRow, 0);
        mj.move(message.titleLabel, titleRow);
        mj.move(header.timeLabel, titleRow);
        mj.property(header.timeLabel, 'y_align', Clutter.ActorAlign.START);
        mj.property(header.timeLabel, 'x_expand', false);
        mj.property(header.timeLabel, 'x_align', Clutter.ActorAlign.END);

        // hover buttons become overlays on the plate; A13: each sits in a fader (opacity 0 -> 1 over 120 ms
        // when the pointer is over the card). GNOME writes the expand button's own opacity, so the fade
        // goes on a holder around it, not on the button.
        const closeButton = header.closeButton;
        const expandButton = header.expandButton;
        const holders = [[closeButton, Clutter.ActorAlign.START, Clutter.ActorAlign.START],
            [expandButton, Clutter.ActorAlign.END, Clutter.ActorAlign.END]].map(([button, xAlign, yAlign]) => {
            const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: false, style_class: 'nc-hover-holder'});
            holder._plateRole = 'overlay';
            holder.x_align = xAlign;
            holder.y_align = yAlign;
            mj.add(() => holder.destroy());
            mj.add(() => holder.get_parent()?.remove_child(holder));
            mj.move(button, holder);
            plate.add_child(holder);
            button.add_style_class_name('nc-hover-button');
            mj.add(() => button.remove_style_class_name('nc-hover-button'));
            return holder;
        });
        mj.property(header, 'visible', false);

        // swap the card's content into the plate
        message.set_child(plate);
        plate.insert_child_at_index(layer.actor, 0);
        plate.insert_child_at_index(vbox, 1);
        plate.add_child(rim);
        // overlay holders were added before the glass/content: lift them above the rim
        for (const holder of holders)
            plate.set_child_above_sibling(holder, null);
        mj.add(() => {
            plate.remove_child(vbox);
            message.set_child(vbox);
        });
        this._plates.set(message, {journal: mj, plate, layout, layer});
        try {
            this._fb.set(message, new CardFeedback(message, layer, holders, [closeButton, expandButton], mj));
            mj.add(() => this._fb?.delete(message));
        } catch (error) {
            console.error(`Notification Center card feedback skipped: ${error.message}`);
        }
        message.connectObject('destroy', () => {
            this._plates.delete(message);
            // Destroyed cards must not receive the close-time feedback reset.
            this._fb?.delete(message);
        }, this);
        this._journal.add(() => message.disconnectObject?.(this));
    }

    _refreshGlass() {
        for (const {plate, layout} of this._plates.values()) {
            try {
                layout.resync(plate);
            } catch {
                // plate already gone
            }
        }
    }

    // ---- small widgets (clock, weather) and the clock tick --------------------------------

    _weatherData() {
        if (this._testWeather)
            return this._testWeather; // rig fixture only; never set in the real session
        const client = this._native?.weather._weatherClient;
        if (!client?.hasLocation)
            return null;
        try {
            const info = client.info;
            if (!info)
                return null;
            const loc = info.location;
            return {
                city: loc?.get_city_name?.() ?? loc?.get_name?.() ?? '',
                temp: info.get_temp?.() ?? '',
                condition: info.get_conditions?.() ?? '',
                iconName: info.get_symbolic_icon_name?.() ?? info.get_icon_name?.() ?? '',
                range: '',
            };
        } catch {
            return null;
        }
    }

    _clockLocations() {
        if (this._testClocks)
            return this._testClocks;
        return (this._native?.clocks._locations ?? []).map(l => l.location);
    }

    _rebuildWidgets() {
        const box = this._widgetsBox;
        for (const child of box.get_children())
            child.destroy();
        this._smallWidgets = [];
        const items = [];
        if (this._native.clocks.visible || this._testClocks) {
            for (const location of this._clockLocations()) {
                const widget = new AnalogClockWidget(location);
                this._smallWidgets.push(widget);
                items.push(widget);
            }
        }
        const data = this._weatherData();
        if (data && (this._native.weather.visible || this._testWeather)) {
            const widget = new WeatherWidget();
            widget.update(data);
            items.push(widget);
        }
        for (const row of pairUp(items)) {
            const rowBox = new St.BoxLayout({style_class: 'nc-widgets-row', x_expand: true});
            for (const widget of row)
                rowBox.add_child(widget);
            box.add_child(rowBox);
        }
        box.visible = items.length > 0;
    }

    _startTick() {
        this._stopTick();
        if (this._smallWidgets.length === 0)
            return;
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            for (const widget of this._smallWidgets)
                widget.tick?.();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
    }

    _updateWidgets() {
        if (!this._native || !this._widgetsBox)
            return;
        if (this._dripAdapter?.deferWidgets())
            return;
        const {view, messages} = this._native;
        this._notificationSection.visible = notificationSectionVisible(view.empty, messages.visible);
        this._rebuildWidgets();
        if (this._native.menu.isOpen)
            this._startTick();
    }

    _updateGeometry() {
        if (!this._active)
            return;
        const {menu, messages} = this._native;
        const index = Main.layoutManager.findIndexForActor(menu.sourceActor);
        if (index < 0)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        this._outer.set_style(`max-height: ${columnMaxHeight(area) + 2 * NCGEO.clipPad}px;`);
        this._column.set_style(`width: ${NCGEO.width}px;`);
        messages.set_style(`${this._messagesStyle}; width: ${NCGEO.width}px;`);
        menu.actor.queue_relayout();
    }

    _queueFocusReveal(actor) {
        if (!this._active || !actor)
            return;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending.delete(id);
            try {
                if (this._active && this._native.menu.isOpen && this._outer.contains(actor))
                    ensureActorVisibleInScrollView(this._outer, actor);
            } catch {
                // Notifications can be withdrawn before the queued frame.
            }
            return GLib.SOURCE_REMOVE;
        });
        this._pending.add(id);
    }

    _deactivate() {
        this._active = false;
        this._stopTick();
        for (const id of this._pending ?? [])
            GLib.Source.remove(id);
        this._pending?.clear();
        const native = this._gone ? null : this._native;
        if (this._gone) {
            // the native menu is gone with the shell: nothing to hand back, and touching it would only log criticals
            this._plates?.clear();
            this._journal = null;
        }
        if (native) {
            try {
                native.menu.close({animate: false});
            } catch {
                // Continue returning surviving native actors during teardown.
            }
        }
        // A17: hand every piece back at rest before the cards are taken apart
        this._drip?.controller.destroy();
        this._dripStyle?.destroy();
        this._drip = null;
        this._dripStyle = null;
        this._dripAdapter = null;
        // cards first (they sit inside native messages), then everything else
        let failures = 0;
        for (const {journal} of this._plates?.values() ?? [])
            failures += journal.rollback();
        this._plates?.clear();
        failures += this._journal?.rollback() ?? 0;
        this._journal = null;
        if (native && this._originalSetDate) {
            try {
                this._originalSetDate.call(native.date, new Date());
            } catch {
                // Native actor may already be destroyed during Shell shutdown.
            }
        }
        this._originalSetDate = null;
        this._native = null;
        this._outer = null;
        this._column = null;
        this._calendarCard = null;
        this._summary = null;
        this._widgetsBox = null;
        this._smallWidgets = [];
        this._notificationSection = null;
        this._watched = null;
        this._fb = null;
        this._bridge?.disable();
        this._bridge = null;
        if (failures)
            console.error(`Notification Center cleanup encountered ${failures} unavailable native objects`);
    }
}

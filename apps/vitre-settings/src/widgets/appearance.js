// B6 rows: the accent swatches, the Light / Dark / Auto choice, and a time of day.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {onKeys, wrapRow} from './rows.js';

// GNOME's nine accents, in GNOME Settings' order. The swatch colours come from libadwaita's own --accent-* variables
// (style.css), so they match what apps draw.
export const ACCENTS = [
    ['blue', 'Blue'], ['teal', 'Teal'], ['green', 'Green'], ['yellow', 'Yellow'], ['orange', 'Orange'],
    ['red', 'Red'], ['pink', 'Pink'], ['purple', 'Purple'], ['slate', 'Slate'],
];

export function accentRow(ctx, iface) {
    const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER, halign: Gtk.Align.END,
        css_classes: ['vitre-accents']});
    const buttons = new Map();
    let group = null;
    let syncing = false;
    for (const [id, label] of ACCENTS) {
        const b = new Gtk.ToggleButton({
            css_classes: ['vitre-accent', id], tooltip_text: label, valign: Gtk.Align.CENTER,
            child: new Gtk.Image({icon_name: 'object-select-symbolic', pixel_size: 12}),
        });
        b.update_property([Gtk.AccessibleProperty.LABEL], [label]);
        if (group)
            b.set_group(group);
        else
            group = b;
        b.connect('toggled', () => {
            if (!syncing && b.active && iface.get_string('accent-color') !== id)
                iface.set_string('accent-color', id);
        });
        buttons.set(id, b);
        box.append(b);
    }
    const {row} = wrapRow('Accent Color', null, box);
    onKeys(ctx, iface, ['accent-color'], () => {
        syncing = true;
        const b = buttons.get(iface.get_string('accent-color'));
        if (b)
            b.active = true;
        else
            for (const x of buttons.values())
                x.active = false;   // an accent Vitre Settings does not offer (brown): none is shown as chosen
        syncing = false;
    });
    return row;
}

// Light | Dark | Auto. Light and Dark set the style and stop the schedule; Auto hands the style to the
// schedule (vitre-appearance mode sunset or custom). Without the extension the row has Light and Dark only.
export function styleRow(ctx, iface, appearance) {
    const group = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, halign: Gtk.Align.END});
    group.add_css_class('round');
    const options = [['light', 'Light'], ['dark', 'Dark']];
    if (appearance)
        options.push(['auto', 'Auto']);
    for (const [name, label] of options)
        group.add(new Adw.Toggle({name, label}));
    const {row, setSubtitle} = wrapRow('Style', null, group);
    let syncing = false;
    const keys = [[iface, ['color-scheme']]];
    if (appearance)
        keys.push([appearance, ['mode']]);
    const sync = () => {
        const auto = appearance && appearance.get_string('mode') !== 'manual';
        syncing = true;
        group.active_name = auto ? 'auto' : iface.get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light';
        syncing = false;
        setSubtitle(auto ? 'Light by day, dark at night' : null);
    };
    for (const [s, k] of keys)
        onKeys(ctx, s, k, sync);
    group.connect('notify::active-name', () => {
        if (syncing || !group.active_name)
            return;
        if (group.active_name === 'auto') {
            const last = appearance.get_string('mode');
            if (last === 'manual')
                appearance.set_string('mode', ctx.lastAutoMode ?? 'sunset');
            return;
        }
        if (appearance && appearance.get_string('mode') !== 'manual') {
            ctx.lastAutoMode = appearance.get_string('mode');
            appearance.set_string('mode', 'manual');
        }
        iface.set_string('color-scheme', group.active_name === 'dark' ? 'prefer-dark' : 'default');
    });
    return row;
}

const pad = n => String(n).padStart(2, '0');

// A time of day stored as minutes after midnight: hour and minute spin buttons.
export function timeRow(ctx, settings, key, {title}) {
    const hour = new Gtk.SpinButton({adjustment: new Gtk.Adjustment({lower: 0, upper: 23, step_increment: 1, page_increment: 1}),
        numeric: true, wrap: true, orientation: Gtk.Orientation.HORIZONTAL, valign: Gtk.Align.CENTER, width_chars: 2});
    const minute = new Gtk.SpinButton({adjustment: new Gtk.Adjustment({lower: 0, upper: 59, step_increment: 5, page_increment: 15}),
        numeric: true, wrap: true, orientation: Gtk.Orientation.HORIZONTAL, valign: Gtk.Align.CENTER, width_chars: 2});
    for (const s of [hour, minute]) {
        s.connect('output', () => {
            s.text = pad(s.adjustment.value);
            return true;
        });
    }
    hour.update_property([Gtk.AccessibleProperty.LABEL], [`${title}, hour`]);
    minute.update_property([Gtk.AccessibleProperty.LABEL], [`${title}, minute`]);
    const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER, halign: Gtk.Align.END, css_classes: ['vitre-time']});
    box.append(hour);
    box.append(new Gtk.Label({label: ':', css_classes: ['dim-label']}));
    box.append(minute);
    const {row} = wrapRow(title, null, box);
    let syncing = false;
    onKeys(ctx, settings, [key], () => {
        const v = settings.get_int(key);
        syncing = true;
        hour.value = Math.floor(v / 60);
        minute.value = v % 60;
        syncing = false;
    });
    const write = () => {
        if (!syncing)
            settings.set_int(key, hour.value * 60 + minute.value);
    };
    hour.connect('value-changed', write);
    minute.connect('value-changed', write);
    return row;
}

// What the schedule is doing, from the extension's status key: where the times come from and the next switch.
export function scheduleNote(appearance) {
    const [source, , next, nextDark] = appearance.get_value('status').deepUnpack();
    const where = {
        location: 'Sun times for where you are',
        timezone: 'Sun times for your time zone. Location Services gives your exact place',
        none: 'No location known, so the times below are used',
        custom: null, manual: null,
    }[source] ?? null;
    let when = null;
    if (next > 0) {
        const t = GLib.DateTime.new_from_unix_local(Number(next));
        const today = GLib.DateTime.new_now_local();
        const day = t.get_day_of_year() === today.get_day_of_year() ? 'today' : 'tomorrow';
        when = `${nextDark ? 'Dark' : 'Light'} at ${t.format('%H:%M')} ${day}`;
    }
    return [when, where].filter(Boolean).join('. ');
}

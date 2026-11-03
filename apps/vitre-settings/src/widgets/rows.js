// Preference rows bound to one Gio.Settings key each. Every builder takes the page context first so that the signal
// handlers it connects are dropped when the pages are rebuilt (an extension turned on or off while the window is open).
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

const WRITE_DELAY_MS = 60;   // a dragged slider writes at most this often

function keyType(settings, key) {
    return settings.settings_schema.get_key(key).get_value_type().dup_string();
}

export function readValue(settings, key) {
    return settings.get_value(key).recursiveUnpack();
}

export function writeValue(settings, key, value) {
    const type = keyType(settings, key);
    if (type === 'i' || type === 'u' || type === 'x' || type === 't')
        value = Math.round(value);
    const variant = new GLib.Variant(type, value);
    if (!settings.get_value(key).equal(variant))
        settings.set_value(key, variant);
}

// Calls fn now and whenever one of the keys changes.
export function onKeys(ctx, settings, keys, fn) {
    for (const key of keys)
        ctx.track(settings, settings.connect(`changed::${key}`, () => fn()));
    fn();
}

// Shows the widget only while predicate() is true.
export function showWhen(ctx, widget, settings, keys, predicate) {
    onKeys(ctx, settings, keys, () => {
        widget.visible = predicate();
    });
}

export function switchRow(ctx, settings, key, {title, subtitle = null, invert = false}) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    row.use_underline = false;
    settings.bind(key, row, 'active',
        invert ? Gio.SettingsBindFlags.INVERT_BOOLEAN : Gio.SettingsBindFlags.DEFAULT);
    ctx.onDispose(() => Gio.Settings.unbind(row, 'active'));
    return row;
}

// A boolean shown as a switch that maps to two string values of a key (for enum keys such as reduced-motion).
export function switchMapRow(ctx, settings, key, {title, subtitle = null, on, off}) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    let syncing = false;
    onKeys(ctx, settings, [key], () => {
        syncing = true;
        row.active = settings.get_string(key) === on;
        syncing = false;
    });
    row.connect('notify::active', () => {
        if (!syncing)
            settings.set_string(key, row.active ? on : off);
    });
    return row;
}

// options: [{value, label, hint?}]. The hint of the chosen option replaces the subtitle, so the row says what it does.
export function comboRow(ctx, settings, key, {title, subtitle = null, options}) {
    const model = Gtk.StringList.new(options.map(o => o.label));
    const row = new Adw.ComboRow({title, model, subtitle: subtitle ?? ''});
    let syncing = false;
    const sync = () => {
        const current = readValue(settings, key);
        const index = options.findIndex(o => o.value === current || o.aliases?.includes(current));
        syncing = true;
        row.selected = index >= 0 ? index : Gtk.INVALID_LIST_POSITION;
        syncing = false;
        const hint = options[index]?.hint;
        row.subtitle = hint ?? subtitle ?? '';
    };
    onKeys(ctx, settings, [key], sync);
    row.connect('notify::selected', () => {
        if (syncing || row.selected === Gtk.INVALID_LIST_POSITION)
            return;
        writeValue(settings, key, options[row.selected].value);
    });
    return row;
}


// A row whose control moves under the title when the window is narrow (an Adw.ActionRow keeps its suffix on the same
// line and would push the page wider than a phone-width window). Returns {row, setSubtitle}.
export function wrapRow(title, subtitle, control) {
    const titles = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true,
        css_classes: ['vitre-row-titles']});
    // capped natural widths, so a long subtitle wraps beside the control instead of pushing it onto its own line
    const titleLabel = new Gtk.Label({label: title, xalign: 0, wrap: true, max_width_chars: 28, css_classes: ['title']});
    const subtitleLabel = new Gtk.Label({label: subtitle ?? '', xalign: 0, wrap: true, max_width_chars: 30,
        css_classes: ['subtitle'], visible: Boolean(subtitle)});
    titles.append(titleLabel);
    titles.append(subtitleLabel);
    const box = new Adw.WrapBox({child_spacing: 12, line_spacing: 8, justify: Adw.JustifyMode.FILL, align: 0.5,
        css_classes: ['vitre-wrap-row']});
    box.append(titles);
    box.append(control);
    const row = new Adw.PreferencesRow({title, child: box, activatable: false});
    const setSubtitle = text => {
        subtitleLabel.label = text ?? '';
        subtitleLabel.visible = Boolean(text);
    };
    return {row, setSubtitle};
}

// A short choice as a segmented control at the end of the row. options: [{value, label, aliases?, tooltip?}]
export function toggleRow(ctx, settings, key, {title, subtitle = null, options}) {
    const group = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true});
    group.add_css_class('round');
    for (const o of options)
        group.add(new Adw.Toggle({name: String(o.value), label: o.label, tooltip: o.tooltip ?? ''}));
    group.halign = Gtk.Align.END;
    const {row} = wrapRow(title, subtitle, group);
    let syncing = false;
    onKeys(ctx, settings, [key], () => {
        const current = readValue(settings, key);
        const match = options.find(o => o.value === current || o.aliases?.includes(current));
        syncing = true;
        group.active_name = match ? String(match.value) : null;
        syncing = false;
    });
    group.connect('notify::active-name', () => {
        if (syncing || !group.active_name)
            return;
        const option = options.find(o => String(o.value) === group.active_name);
        if (option)
            writeValue(settings, key, option.value);
    });
    return row;
}

export function spinRow(ctx, settings, key, {title, subtitle = null, min, max, step = 1}) {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.title = title;
    row.subtitle = subtitle ?? '';
    let syncing = false;
    onKeys(ctx, settings, [key], () => {
        syncing = true;
        row.value = readValue(settings, key);
        syncing = false;
    });
    row.connect('notify::value', () => {
        if (!syncing)
            writeValue(settings, key, row.value);
    });
    return row;
}

// A slider at the end of the row with its value printed next to it.
// keys: one key, or several that move together (the row shows the first key's value; the subtitle says when they differ).
export function scaleRow(ctx, settings, keys, {title, subtitle = null, min, max, step, format, marks = [], mixedNote = null, mixedTolerance = 1e-6}) {
    keys = Array.isArray(keys) ? keys : [keys];
    const adjustment = new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 5});
    const scale = new Gtk.Scale({
        adjustment, draw_value: false, hexpand: true, valign: Gtk.Align.CENTER,
        digits: step < 1 ? 2 : 0, round_digits: step < 1 ? 2 : 0,
    });
    scale.add_css_class('vitre-row-scale');
    for (const m of marks)
        scale.add_mark(m, Gtk.PositionType.BOTTOM, null);
    const value = new Gtk.Label({width_chars: 5, xalign: 1, valign: Gtk.Align.CENTER});
    value.add_css_class('numeric');
    value.add_css_class('dim-label');
    const control = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER, width_request: 210, css_classes: ['vitre-scale-box']});
    control.append(scale);
    control.append(value);
    const {row, setSubtitle} = wrapRow(title, subtitle, control);
    scale.update_property([Gtk.AccessibleProperty.LABEL], [title]);

    let syncing = false;
    let pending = 0;
    const flush = () => {
        pending = 0;
        const v = Math.round(adjustment.value / step) * step;
        for (const key of keys)
            writeValue(settings, key, v);
        return GLib.SOURCE_REMOVE;
    };
    onKeys(ctx, settings, keys, () => {
        const values = keys.map(k => readValue(settings, k));
        syncing = true;
        adjustment.value = values[0];
        syncing = false;
        value.label = format(values[0]);
        const mixed = values.some(v => Math.abs(v - values[0]) > mixedTolerance);
        setSubtitle(mixed && mixedNote ? mixedNote : subtitle);
    });
    adjustment.connect('value-changed', () => {
        value.label = format(Math.round(adjustment.value / step) * step);
        if (syncing)
            return;
        if (!pending)
            pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WRITE_DELAY_MS, flush);
    });
    ctx.onDispose(() => {
        if (pending)
            GLib.source_remove(pending);
        pending = 0;
    });
    return row;
}

// A row that only shows text (used on About). The text can be selected and copied.
export function textRow({title, subtitle}) {
    const row = new Adw.ActionRow({title, subtitle, subtitle_selectable: true});
    row.add_css_class('property');
    return row;
}

export function linkRow({title, subtitle = null, uri}) {
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? '', activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic', valign: Gtk.Align.CENTER}));
    row.connect('activated', () => {
        new Gtk.UriLauncher({uri}).launch(row.get_root(), null, null);
    });
    row.tooltip_text = uri;
    return row;
}

// Steps as prose, then the command to type in a monospace block that can be selected and copied as it is.
export function commandRow({title, steps, command, after = null}) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
    box.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['heading']}));
    box.append(new Gtk.Label({label: steps, xalign: 0, wrap: true, css_classes: ['dim-label']}));
    const code = new Gtk.Label({label: command, xalign: 0, selectable: true, css_classes: ['monospace', 'vitre-command']});
    // a long command scrolls sideways on a narrow window instead of widening the page
    box.append(new Gtk.ScrolledWindow({
        child: code, vscrollbar_policy: Gtk.PolicyType.NEVER, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        propagate_natural_height: true, propagate_natural_width: true,
    }));
    if (after)
        box.append(new Gtk.Label({label: after, xalign: 0, wrap: true, css_classes: ['dim-label']}));
    const row = new Adw.PreferencesRow({child: box, activatable: false, title});
    return row;
}

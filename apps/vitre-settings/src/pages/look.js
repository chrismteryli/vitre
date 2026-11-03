import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {newPage, finish} from './context.js';
import {comboRow, onKeys, showWhen, switchRow, toggleRow} from '../widgets/rows.js';
import {accentRow, scheduleNote, styleRow, timeRow} from '../widgets/appearance.js';
import {WallpaperTile} from '../widgets/wallpapers.js';
import {listThemes, listWallpapers, uriToPath} from '../backend/themes.js';
import * as S from '../backend/specs.js';

export const id = 'look';
export const title = 'Look';
export const icon = 'vitre-settings-look-symbolic';

function themeRow(ctx, settings, key, kind, rowTitle) {
    const themes = listThemes(kind);
    if (themes.length === 0)
        return null;
    const current = settings.get_string(key);
    if (!themes.some(t => t.id === current))
        themes.push({id: current, name: current});   // keep a theme set by hand selectable
    return comboRow(ctx, settings, key, {
        title: rowTitle,
        options: themes.map(t => ({value: t.id, label: t.name})),
    });
}

function wallpaperGroup(ctx) {
    const bg = ctx.settings(S.BACKGROUND, 'picture-uri', 'picture-uri-dark');
    const pairs = bg ? listWallpapers() : [];
    if (pairs.length === 0)
        return null;

    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.SINGLE, homogeneous: true, activate_on_single_click: true,
        min_children_per_line: 1, max_children_per_line: 4, column_spacing: 12, row_spacing: 12,
        css_classes: ['vitre-wallpapers'],
    });
    const tiles = pairs.map(pair => new WallpaperTile(pair));
    for (const tile of tiles)
        flow.append(tile.widget);
    ctx.wallpaperTiles = tiles;   // the screenshot tool waits for the thumbnails

    let syncing = false;
    onKeys(ctx, bg, ['picture-uri', 'picture-uri-dark'], () => {
        const now = [uriToPath(bg.get_string('picture-uri')), uriToPath(bg.get_string('picture-uri-dark'))]
            .map(p => p && GLib.path_get_basename(p));
        const index = pairs.findIndex(p => now.includes(GLib.path_get_basename(p.light)) ||
            now.includes(GLib.path_get_basename(p.dark)));
        syncing = true;
        if (index >= 0)
            flow.select_child(flow.get_child_at_index(index));
        else
            flow.unselect_all();
        syncing = false;
    });
    flow.connect('child-activated', (_f, child) => {
        if (syncing)
            return;
        const pair = pairs[child.get_index()];
        bg.delay();
        bg.set_string('picture-uri', GLib.filename_to_uri(pair.light, null));
        bg.set_string('picture-uri-dark', GLib.filename_to_uri(pair.dark, null));
        if (bg.settings_schema.has_key('picture-options'))
            bg.set_string('picture-options', 'zoom');
        bg.apply();
    });

    const appearance = ctx.settings(S.APPEARANCE, 'pair-wallpaper');
    const group = new Adw.PreferencesGroup({
        title: 'Wallpaper',
        description: appearance ? '' : 'Each one has a light and a dark version that follows the style',
    });
    group.add(flow);
    if (appearance) {
        const pair = switchRow(ctx, appearance, 'pair-wallpaper', {
            title: 'Wallpaper Follows the Style',
            subtitle: 'Shows the light or the dark picture of the wallpaper, with a short fade',
        });
        pair.add_css_class('vitre-after-flow');
        group.add(pair);
    }
    return group;
}

export function build(ctx) {
    const page = newPage({name: id, title, icon});
    const iface = ctx.settings(S.INTERFACE, 'color-scheme');
    const accent = ctx.settings(S.INTERFACE, 'accent-color');
    const appearance = ctx.settings(S.APPEARANCE, 'mode', 'light-time', 'dark-time', 'status');

    ctx.group(page, {}, [
        iface && (appearance ? styleRow(ctx, iface, appearance) : toggleRow(ctx, iface, 'color-scheme', {
            title: 'Style',
            options: [
                {value: 'default', label: 'Light', aliases: ['prefer-light']},
                {value: 'prefer-dark', label: 'Dark'},
            ],
        })),
        accent && accentRow(ctx, accent),
    ]);

    // Auto: when the schedule switches (vitre-appearance). Shown only while Style is Auto.
    if (appearance) {
        const auto = ctx.group(page, {title: 'Automatic Style'}, [
            toggleRow(ctx, appearance, 'mode', {
                title: 'Switch',
                options: [
                    {value: 'sunset', label: 'Sunset to Sunrise', aliases: ['manual']},
                    {value: 'custom', label: 'Custom Times'},
                ],
            }),
        ]);
        const light = timeRow(ctx, appearance, 'light-time', {title: 'Light From'});
        const dark = timeRow(ctx, appearance, 'dark-time', {title: 'Dark From'});
        auto.add(light);
        auto.add(dark);
        showWhen(ctx, auto, appearance, ['mode'], () => appearance.get_string('mode') !== 'manual');
        // the times apply to Custom, and to Sunset while no location is known
        showWhen(ctx, light, appearance, ['mode', 'status'], () => appearance.get_string('mode') === 'custom' ||
            appearance.get_value('status').deepUnpack()[0] === 'none');
        showWhen(ctx, dark, appearance, ['mode', 'status'], () => light.visible);
        onKeys(ctx, appearance, ['status', 'mode'], () => {
            auto.description = scheduleNote(appearance);
        });
    }

    const wallpapers = wallpaperGroup(ctx);
    if (wallpapers) {
        page.add(wallpapers);
        page._vitreGroups = (page._vitreGroups ?? 0) + 1;
    }

    const themes = ctx.settings(S.INTERFACE, 'cursor-theme', 'icon-theme');
    ctx.group(page, {title: 'Themes'}, [
        themes && themeRow(ctx, themes, 'icon-theme', 'icons', 'Icons'),
        themes && themeRow(ctx, themes, 'cursor-theme', 'cursors', 'Pointer'),
    ]);

    return finish(page);
}

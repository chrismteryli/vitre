import {newPage, finish} from './context.js';
import {comboRow, scaleRow, showWhen, switchRow, toggleRow} from '../widgets/rows.js';
import * as S from '../backend/specs.js';

export const id = 'dock';
export const title = 'Dock';
export const icon = 'vitre-settings-dock-symbolic';

const px = v => `${Math.round(v)} px`;
const times = v => `${v.toFixed(1)}×`;
const percent = v => `${Math.round(v)} %`;

export function build(ctx) {
    // Vitre Dock in a release install, the upstream Dhruva on a development desktop: same keys, one page.
    const spec = ctx.registry.first(S.DOCKS, ['dock-position', 'icon-size']);
    const dock = spec && ctx.registry.settings(spec);
    if (!dock)
        return null;
    const has = key => ctx.registry.has(spec, key);
    const page = newPage({name: id, title, icon});

    ctx.group(page, {title: 'Position'}, [
        toggleRow(ctx, dock, 'dock-position', {
            title: 'Screen Edge',
            options: [
                {value: 'LEFT', label: 'Left'},
                {value: 'BOTTOM', label: 'Bottom'},
                {value: 'RIGHT', label: 'Right'},
            ],
        }),
        has('hide-mode') && comboRow(ctx, dock, 'hide-mode', {
            title: 'Hide Automatically',
            options: [
                {value: 'none', label: 'Never', hint: 'The Dock is always on screen'},
                {value: 'intelligent', label: 'Smart', hint: 'Hides when the window you use reaches the Dock'},
                {value: 'dodge-all', label: 'Any Window', hint: 'Hides when any window reaches the Dock'},
                {value: 'maximized', label: 'Maximized', hint: 'Hides while a window fills the screen'},
                {value: 'always', label: 'Always', hint: 'Shows when the pointer reaches the screen edge'},
            ],
        }),
    ]);

    const zoomRow = has('hover-zoom-factor') && scaleRow(ctx, dock, 'hover-zoom-factor', {
        title: 'Magnification Size', min: 1.1, max: 3, step: 0.1, format: times,
    });
    ctx.group(page, {title: 'Size'}, [
        scaleRow(ctx, dock, 'icon-size', {
            title: 'Icon Size', min: 16, max: 128, step: 2, format: px,
        }),
        has('hover-zoom') && switchRow(ctx, dock, 'hover-zoom', {
            title: 'Magnification',
            subtitle: 'Icons grow as the pointer passes over them',
        }),
        zoomRow,
    ]);
    if (zoomRow)
        showWhen(ctx, zoomRow, dock, ['hover-zoom'], () => dock.get_boolean('hover-zoom'));

    const peekRow = has('peek-effect') && switchRow(ctx, dock, 'peek-effect', {
        title: 'Peek',
        subtitle: 'Other windows fade while the pointer rests on a preview',
    });
    ctx.group(page, {title: 'Windows'}, [
        has('show-apps-preview') && switchRow(ctx, dock, 'show-apps-preview', {
            title: 'Window Previews',
            subtitle: 'Thumbnails of an app’s windows above its icon',
        }),
        peekRow,
        has('show-running-indicators') && switchRow(ctx, dock, 'show-running-indicators', {
            title: 'Open App Indicators',
            subtitle: 'A dot under each app that has a window open',
        }),
        has('show-notification-badges') && switchRow(ctx, dock, 'show-notification-badges', {
            title: 'Notification Badges',
            subtitle: 'A count on an app with unread notifications',
        }),
    ]);
    if (peekRow && has('show-apps-preview'))
        showWhen(ctx, peekRow, dock, ['show-apps-preview'], () => dock.get_boolean('show-apps-preview'));

    // B5: the Downloads stack (rows appear only when the Dock has the keys)
    const stackRows = [
        has('stack-view') && toggleRow(ctx, dock, 'stack-view', {
            title: 'Open As',
            options: [
                {value: 'auto', label: 'Automatic'},
                {value: 'fan', label: 'Fan'},
                {value: 'grid', label: 'Grid'},
            ],
        }),
        has('stack-sort') && toggleRow(ctx, dock, 'stack-sort', {
            title: 'Sort By',
            options: [
                {value: 'date-added', label: 'Date Added'},
                {value: 'name', label: 'Name'},
            ],
        }),
        has('stack-custom-folders') && switchRow(ctx, dock, 'stack-custom-folders', {
            title: 'Your Folders as Stacks',
            subtitle: 'Folders you add to the Dock open the same way',
        }),
    ];
    if (has('show-stack')) {
        ctx.group(page, {title: 'Downloads Stack'}, [
            switchRow(ctx, dock, 'show-stack', {
                title: 'Downloads Stack',
                subtitle: 'Your newest downloads in the Dock, opening as a fan or a grid',
            }),
            ...stackRows,
        ]);
        for (const row of stackRows.filter(Boolean))
            showWhen(ctx, row, dock, ['show-stack'], () => dock.get_boolean('show-stack'));
    }

    ctx.group(page, {title: 'Items'}, [
        has('show-trash') && switchRow(ctx, dock, 'show-trash', {
            title: 'Trash',
            subtitle: 'Drop files on it to move them to the trash',
        }),
        has('show-desktop-button') && switchRow(ctx, dock, 'show-desktop-button', {
            title: 'Show Desktop Button',
            subtitle: 'A thin bar at the end of the Dock that clears the screen',
        }),
        has('background-opacity') && scaleRow(ctx, dock, 'background-opacity', {
            title: 'Background', subtitle: 'How solid the Dock’s glass is', min: 0, max: 100, step: 5, format: percent,
        }),
    ]);

    return finish(page);
}

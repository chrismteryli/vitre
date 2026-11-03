import {newPage, finish} from './context.js';
import {comboRow, scaleRow, showWhen, switchRow} from '../widgets/rows.js';
import {plannedRow} from '../widgets/planned.js';
import * as S from '../backend/specs.js';

export const id = 'windows';
export const title = 'Windows';
export const icon = 'vitre-settings-windows-symbolic';

export function build(ctx) {
    const page = newPage({name: id, title, icon});

    // Rows that appear once their key exists (see specs.js): snapping motion and the window button style.
    ctx.group(page, {title: 'Windows'}, [
        plannedRow(ctx, S.PLANNED_SNAP_MOTION, {
            title: 'Snapping Motion',
            subtitle: 'Windows stretch into place when tiled, maximized or restored',
        }),
        plannedRow(ctx, S.PLANNED_BUTTON_STYLE, {title: 'Window Buttons'}),
    ]);

    const fullscreen = ctx.settings(S.FULLSCREEN, 'motion');
    const corner = ctx.settings(S.CORNER, 'enabled');
    const dwellRow = corner && ctx.registry.has(S.CORNER, 'dwell-ms') && scaleRow(ctx, corner, 'dwell-ms', {
        title: 'Corner Delay',
        subtitle: 'Rest time before it shows. A quick push shows it at once.',
        min: 0, max: 1000, step: 50, format: v => `${Math.round(v)} ms`,
    });
    ctx.group(page, {title: 'Full Screen'}, [
        fullscreen && comboRow(ctx, fullscreen, 'motion', {
            title: 'Entering Full Screen',
            options: [
                {value: 'vitre', label: 'Vitre', hint: 'The window grows to fill the screen as the desktop steps back'},
                {value: 'native', label: 'GNOME', hint: 'The standard GNOME resize and workspace slide'},
            ],
        }),
        corner && switchRow(ctx, corner, 'enabled', {
            title: 'Corner Capsule',
            subtitle: 'In full screen, the top-right corner shows the time, battery and Control Center',
        }),
        dwellRow,
    ]);
    if (dwellRow)
        showWhen(ctx, dwellRow, corner, ['enabled'], () => corner.get_boolean('enabled'));

    return finish(page);
}

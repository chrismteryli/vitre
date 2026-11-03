import {newPage, finish} from './context.js';
import {scaleRow, switchRow} from '../widgets/rows.js';
import {plannedRow} from '../widgets/planned.js';
import * as S from '../backend/specs.js';

export const id = 'glass';
export const title = 'Glass';
export const icon = 'vitre-settings-glass-symbolic';

// The glass surfaces Vitre turns on, and the tint keys that set how much colour each one carries.
const SURFACES = [
    ['enable-menu-glass', 'Calendar Menu'],
    ['enable-quick-settings-glass', 'Control Center'],
    ['enable-extra-menu-glass', 'Other Top Bar Menus'],
    ['enable-osd-glass', 'Volume and Brightness'],
    ['enable-notification-glass', 'Notification Banners'],
];
const TINT_KEYS = ['menu-tint-strength', 'panel-menu-tint-strength', 'quick-settings-tint-strength', 'osd-tint-strength'];

export function build(ctx) {
    const page = newPage({name: id, title, icon});

    // B9 (reduce transparency) lands here: one switch that makes every glass surface solid. Hidden until its key exists.
    ctx.group(page, {}, [
        plannedRow(ctx, S.PLANNED_REDUCE_TRANSPARENCY, {
            title: 'Reduce Transparency',
            subtitle: 'Glass surfaces become solid',
        }),
    ]);

    const glass = ctx.settings(S.LIQUID_GLASS);
    if (glass) {
        const has = key => ctx.registry.has(S.LIQUID_GLASS, key);
        const tintKeys = TINT_KEYS.filter(has);
        ctx.group(page, {
            title: 'Liquid Glass',
            description: 'Surfaces drawn as glass that bends the desktop behind it',
        }, [
            ...SURFACES.filter(([key]) => has(key)).map(([key, label]) => switchRow(ctx, glass, key, {title: label})),
            tintKeys.length > 0 && scaleRow(ctx, glass, tintKeys, {
                title: 'Tint',
                subtitle: 'Low is clearer, high is more solid',
                // Vitre's own defaults differ by 0.06 between menus; only a bigger spread is worth a note
                mixedNote: 'These menus have different tints now. Moving the slider gives them one tint.',
                mixedTolerance: 0.1,
                min: 0, max: 1, step: 0.02, format: v => `${Math.round(v * 100)} %`,
            }),
        ]);
    }

    const panel = ctx.settings(S.BLUR_PANEL, 'blur');
    const overview = ctx.settings(S.BLUR_OVERVIEW, 'blur');
    ctx.group(page, {title: 'Blur', description: 'The frosted background behind shell surfaces'}, [
        panel && switchRow(ctx, panel, 'blur', {title: 'Top Bar'}),
        overview && switchRow(ctx, overview, 'blur', {title: 'Overview'}),
    ]);

    return finish(page);
}

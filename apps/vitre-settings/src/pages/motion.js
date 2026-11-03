import {newPage, finish} from './context.js';
import {comboRow, onKeys, showWhen, spinRow, switchMapRow, switchRow, toggleRow} from '../widgets/rows.js';
import * as S from '../backend/specs.js';

export const id = 'motion';
export const title = 'Motion';
export const icon = 'vitre-settings-motion-symbolic';

export function build(ctx) {
    const page = newPage({name: id, title, icon});

    // ---- Motion: the two GNOME switches every Vitre motion reads ----
    const iface = ctx.settings(S.INTERFACE, 'enable-animations');
    const a11y = ctx.settings(S.A11Y_INTERFACE, 'reduced-motion');
    ctx.group(page, {}, [
        iface && switchRow(ctx, iface, 'enable-animations', {
            title: 'Animations',
            subtitle: 'Windows, menus and the overview move. When off, every change is instant.',
        }),
        a11y && switchMapRow(ctx, a11y, 'reduced-motion', {
            title: 'Reduce Motion',
            subtitle: 'Fades in place of stretching, sliding and zooming',
            on: 'reduce', off: 'no-preference',
        }),
    ]);

    // ---- Styles: each Vitre motion next to GNOME's own ----
    const menus = ctx.settings(S.MENUS, 'drip-style');
    const swipe = ctx.settings(S.SWIPE, 'style');
    const workspaces = ctx.settings(S.WORKSPACES, 'style');
    const styles = ctx.group(page, {
        title: 'Style',
        description: 'Vitre motion or the GNOME motion it replaces. Changes apply to the next animation.',
    }, [
        menus && comboRow(ctx, menus, 'drip-style', {
            title: 'Menus and Pop-outs',
            options: [
                {value: 'liquid', label: 'Liquid', hint: 'Menus and Control Center flow out of the top bar'},
                {value: 'classic', label: 'Classic', hint: 'The motion of earlier Vitre builds'},
            ],
        }),
        swipe && comboRow(ctx, swipe, 'style', {
            title: 'Overview',
            options: [
                {value: 'depth', label: 'Depth', hint: 'Windows step back with parallax as the overview opens'},
                {value: 'stock', label: 'GNOME', hint: 'The standard GNOME overview motion'},
            ],
        }),
        workspaces && comboRow(ctx, workspaces, 'style', {
            title: 'Workspace Switch',
            options: [
                {value: 'vitre', label: 'Glass Depth', hint: 'The workspace you leave steps back and dims'},
                {value: 'stock', label: 'Slide', hint: 'The standard GNOME slide'},
            ],
        }),
    ]);
    if (styles && iface) {
        onKeys(ctx, iface, ['enable-animations'], () => {
            styles.sensitive = iface.get_boolean('enable-animations');
        });
    }

    // ---- Stage ----
    const stage = ctx.settings(S.STAGE, 'enabled');
    const piles = ctx.settings(S.SWIPE, 'piles');
    if (stage) {
        const stageRows = [
            switchRow(ctx, stage, 'enabled', {
                title: 'Stage',
                subtitle: 'The app you use in the middle, recent apps as piles in a strip on the left',
            }),
        ];
        if (ctx.registry.has(S.STAGE, 'max-groups')) {
            const range = ctx.registry.range(S.STAGE, 'max-groups') ?? {min: 1, max: 8};
            stageRows.push(spinRow(ctx, stage, 'max-groups', {
                title: 'Apps in the Strip', subtitle: 'Most recent apps shown, as many as fit', min: range.min, max: range.max,
            }));
        }
        if (piles) {
            stageRows.push(toggleRow(ctx, piles, 'piles', {
                title: 'Piles in the Overview',
                subtitle: 'Stay keeps them fanned on the left; Join flies their windows into the grid',
                options: [{value: 'stay', label: 'Stay'}, {value: 'carry', label: 'Join'}],
            }));
        }
        const group = ctx.group(page, {title: 'Stage'}, stageRows);
        if (group) {
            for (const row of stageRows.slice(1))
                showWhen(ctx, row, stage, ['enabled'], () => stage.get_boolean('enabled'));
        }
    }

    return finish(page);
}

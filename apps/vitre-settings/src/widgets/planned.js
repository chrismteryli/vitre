// A row for a setting that is planned but has no key yet. It stays hidden (returns null) until one of the candidate
// schemas gains the key; then it is a switch for a boolean key or a list for a key with choices. Nothing is ever shown
// that would not work.
import {comboRow, switchRow} from './rows.js';

function label(value) {
    return String(value).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function plannedRow(ctx, candidates, {title, subtitle = null, labels = {}}) {
    for (const {key, ...spec} of candidates) {
        const settings = ctx.settings(spec, key);
        if (!settings)
            continue;
        const type = settings.settings_schema.get_key(key).get_value_type().dup_string();
        if (type === 'b')
            return switchRow(ctx, settings, key, {title, subtitle});
        const range = ctx.registry.range(spec, key);
        if (type === 's' && range?.type === 'enum') {
            return comboRow(ctx, settings, key, {
                title, subtitle,
                options: range.values.map(value => ({value, label: labels[value] ?? label(value)})),
            });
        }
        console.warn(`vitre-settings: ${spec.schema} ${key} has a type this row cannot show (${type})`);
    }
    return null;
}

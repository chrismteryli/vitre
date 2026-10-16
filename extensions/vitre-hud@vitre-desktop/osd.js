/* Which OSD calls become the menu-bar HUD. Pure module (node + gjs).
 *
 * GNOME 51 funnels every on-screen display through OsdWindowManager._showOsdWindow(monitor,
 * icon, label, level, maxLevel): volume keys (gsd-media-keys -> org.gnome.Shell.ShowOSD),
 * keyboard backlight (gsd-power -> ShowOSD), brightness (shell brightnessManager ->
 * osdWindowManager.show), scrolling over the volume indicator (status/volume.js -> showAll).
 * An OSD is a media HUD when its icon is a volume / brightness / keyboard-backlight icon AND it
 * carries a level. Everything else (caps lock, input source, microphone mute, airplane mode,
 * touchpad, a volume icon without a level, ...) keeps GNOME's own OSD.
 */

const RULES = [
    [/^audio-volume-(muted|low|medium|high|overamplified)(-symbolic)?$/, 'volume'],
    [/^display-brightness(-[a-z]+)?(-symbolic)?$/, 'brightness'],
    [/^keyboard-brightness(-[a-z]+)?(-symbolic)?$/, 'keyboard'],
];

export function classifyOsd(iconNames, level) {
    if (level === null || level === undefined || Number.isNaN(Number(level)))
        return null;
    for (const name of iconNames ?? []) {
        for (const [re, kind] of RULES) {
            if (re.test(name))
                return {kind, iconName: name.endsWith('-symbolic') ? name : `${name}-symbolic`};
        }
    }
    return null;
}

// Names of a Gio.Icon (ThemedIcon has get_names; anything else -> its string form).
export function iconNamesOf(icon) {
    if (!icon)
        return [];
    if (typeof icon.get_names === 'function')
        return icon.get_names() ?? [];
    if (typeof icon.to_string === 'function') {
        const s = icon.to_string();
        return s ? [s] : [];
    }
    return [];
}

export function levelFraction(level, maxLevel) {
    const max = Number(maxLevel) > 0 ? Number(maxLevel) : 1;
    return Math.min(1, Math.max(0, Number(level) / max));
}

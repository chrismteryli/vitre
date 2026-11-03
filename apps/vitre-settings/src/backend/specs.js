// Every schema the app writes to, in one place. `ext` is the extension whose code reads the schema: rows on a schema
// whose extension is missing or switched off are hidden.
//
// When Vitre Shell core (roadmap A2) merges the vitre-* extensions into one, only this file changes.

const vitre = name => ({schema: `org.gnome.shell.extensions.vitre-${name}`, ext: `vitre-${name}@vitre-desktop`});

export const INTERFACE = {schema: 'org.gnome.desktop.interface'};
export const A11Y_INTERFACE = {schema: 'org.gnome.desktop.a11y.interface'};
export const BACKGROUND = {schema: 'org.gnome.desktop.background'};

export const MENUS = vitre('menus');
export const SWIPE = vitre('swipe');
export const WORKSPACES = vitre('workspaces');
export const STAGE = vitre('stage');
export const FULLSCREEN = vitre('fullscreen-spaces');
export const CORNER = vitre('corner');
// B6: light and dark on a schedule, the wallpaper pair, the GTK 3 theme name (the accent itself is GNOME's own key)
export const APPEARANCE = vitre('appearance');

// The Dock: the release ships Vitre Dock; a development desktop may run the upstream Dhruva it is forked from. Both have
// the same keys. The first one that is installed and active is the one the Dock page writes to.
export const DOCKS = [
    vitre('dock'),
    {schema: 'org.gnome.shell.extensions.dhruva', ext: 'dhruva@narkagni'},
];

export const LIQUID_GLASS = {
    schema: 'org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com',
    ext: 'liquid-glass@thinkingcoding1231.gmail.com',
};
export const BLUR_PANEL = {schema: 'org.gnome.shell.extensions.blur-my-shell.panel', ext: 'blur-my-shell@aunetx'};
export const BLUR_OVERVIEW = {schema: 'org.gnome.shell.extensions.blur-my-shell.overview', ext: 'blur-my-shell@aunetx'};

// ---- Places kept for settings that have no key yet. Each row appears by itself once a schema below gains the key. ----
//
// B9 (reduce transparency): one switch that makes every glass surface solid. Expected in the merged Vitre Shell schema
// (A2) or, before that, in the menus extension that owns the shared glass code.
export const PLANNED_REDUCE_TRANSPARENCY = [
    {schema: 'org.gnome.shell.extensions.vitre-shell', ext: 'vitre-shell@vitre-desktop', key: 'reduce-transparency'},
    {...vitre('menus'), key: 'reduce-transparency'},
];
// Snapping motion on or off (vitre-window-open's snap part has no switch today).
export const PLANNED_SNAP_MOTION = [
    {schema: 'org.gnome.shell.extensions.vitre-shell', ext: 'vitre-shell@vitre-desktop', key: 'snap-motion'},
    {...vitre('window-open'), key: 'snap-motion'},
];
// Window button style (the capsule and bead proposals are not selectable today).
export const PLANNED_BUTTON_STYLE = [
    {schema: 'org.gnome.shell.extensions.vitre-shell', ext: 'vitre-shell@vitre-desktop', key: 'window-button-style'},
];

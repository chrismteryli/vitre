// The appearance controller: light and dark on a schedule, the wallpaper pair, and the GTK 3 theme name. No GNOME Shell
// imports, so the unit test drives it with real Gio.Settings (memory backend) and a simulated clock.
//
// deps = {
//   settings     Gio.Settings of org.gnome.shell.extensions.vitre-appearance
//   iface        Gio.Settings of org.gnome.desktop.interface   (color-scheme, accent-color, gtk-theme)
//   background   Gio.Settings of org.gnome.desktop.background  (picture-uri, picture-uri-dark)
//   clock        {now() -> ms, setTimeout(fn, ms) -> id, clearTimeout(id)}
//   tz           () -> GLib.TimeZone
//   location     () -> {lat, lon, source} | null
//   fileExists   (path) -> bool
//   themeExists  (name) -> bool
//   log          (msg)
// }
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {plan} from './schedule.js';

const RECHECK_MS = 10 * 60 * 1000;   // at most this long between checks: catches suspend and clock changes
const FAMILY = /^Vitre-Glass(-(Teal|Green|Yellow|Orange|Red|Pink|Purple|Slate|Brown))?(-Light)?$/;
const PAIR = /^(.*[-_])(light|dark|day|night)(\.[A-Za-z0-9]+)$/;
const OPPOSITE = {light: 'dark', dark: 'light', day: 'night', night: 'day'};
const IS_DARK = {dark: true, night: true, light: false, day: false};

export function legacyThemeName(accent, dark) {
    const a = accent && accent !== 'blue' ? `-${accent[0].toUpperCase()}${accent.slice(1)}` : '';
    return `Vitre-Glass${a}${dark ? '' : '-Light'}`;
}

export class AppearanceController {
    constructor(deps) {
        this._d = deps;
        this._timer = 0;
        this._expectScheme = null;      // the color-scheme value this controller wrote and has not seen come back yet
        this._handlers = [];
        this._lastPlan = null;
    }

    start() {
        const {settings, iface, background} = this._d;
        const on = (obj, sig, fn) => this._handlers.push([obj, obj.connect(sig, fn)]);
        on(settings, 'changed::mode', () => this._configChanged());
        on(settings, 'changed::light-time', () => this._configChanged());
        on(settings, 'changed::dark-time', () => this._configChanged());
        on(settings, 'changed::pair-wallpaper', () => this.syncWallpaper());
        on(settings, 'changed::follow-legacy-theme', () => this.syncLegacyTheme());
        on(iface, 'changed::color-scheme', () => this._schemeChanged());
        on(iface, 'changed::accent-color', () => this.syncLegacyTheme());
        on(iface, 'changed::gtk-theme', () => this.syncLegacyTheme());
        on(background, 'changed::picture-uri', () => this.syncWallpaper('picture-uri'));
        on(background, 'changed::picture-uri-dark', () => this.syncWallpaper('picture-uri-dark'));
        this.syncWallpaper();
        this.evaluate('start');
        this.syncLegacyTheme();
    }

    stop() {
        for (const [obj, id] of this._handlers)
            obj.disconnect(id);
        this._handlers = [];
        if (this._timer)
            this._d.clock.clearTimeout(this._timer);
        this._timer = 0;
    }

    get isDark() {
        return this._d.iface.get_string('color-scheme') === 'prefer-dark';
    }

    _config() {
        const s = this._d.settings;
        const loc = this._d.location();
        return {mode: s.get_string('mode'), lightTime: s.get_int('light-time'), darkTime: s.get_int('dark-time'),
            location: loc ? {lat: loc.lat, lon: loc.lon} : null, source: loc?.source ?? 'none'};
    }

    // Called when the location becomes known or changes.
    locationChanged() {
        this.evaluate('location');
    }

    _configChanged() {
        // a new schedule replaces any hold the user had on the old one
        this._setHold(0);
        this.evaluate('config');
    }

    _hold() {
        return this._d.settings.get_int64('hold-until') * 1000;
    }

    _setHold(ms) {
        const v = Math.floor(ms / 1000);
        if (this._d.settings.get_int64('hold-until') !== v)
            this._d.settings.set_int64('hold-until', v);
    }

    _writeStatus(cfg, p) {
        const s = this._d.settings;
        const status = new GLib.Variant('(sxxb)', [cfg.mode === 'sunset' ? cfg.source : cfg.mode,
            p?.last ? Math.floor(p.last.t / 1000) : 0, p?.next ? Math.floor(p.next.t / 1000) : 0, Boolean(p?.next?.dark)]);
        if (!s.get_value('status').equal(status))
            s.set_value('status', status);
    }

    // Applies the scheduled style unless the user holds a manual choice, and arms the timer for the next check.
    evaluate(reason = '') {
        const {clock, log} = this._d;
        if (this._timer)
            clock.clearTimeout(this._timer);
        this._timer = 0;
        const cfg = this._config();
        if (cfg.mode !== 'sunset' && cfg.mode !== 'custom') {
            this._setHold(0);
            this._writeStatus(cfg, null);
            this._lastPlan = null;
            return;
        }
        const now = clock.now();
        const p = plan(now, cfg, this._d.tz());
        this._lastPlan = p;
        this._writeStatus(cfg, p);
        const hold = this._hold();
        if (hold && now < hold) {
            log?.(`hold: keeping the manual ${this.isDark ? 'dark' : 'light'} style until ${new Date(hold).toISOString()} (${reason})`);
        } else {
            if (hold)
                this._setHold(0);
            if (p.dark !== this.isDark) {
                log?.(`switch to ${p.dark ? 'dark' : 'light'} (${reason})`);
                this.syncWallpaper();
                this._writeScheme(p.dark);
            }
        }
        const nextT = Math.min(p.next ? p.next.t : Infinity, hold > now ? hold : Infinity, now + RECHECK_MS);
        this._timer = clock.setTimeout(() => {
            this._timer = 0;
            this.evaluate('timer');
        }, Math.max(1000, nextT - now + 500));
    }

    _writeScheme(dark) {
        const value = dark ? 'prefer-dark' : 'default';
        this._expectScheme = value;
        this._d.iface.set_string('color-scheme', value);
    }

    _schemeChanged() {
        const value = this._d.iface.get_string('color-scheme');
        const ours = this._expectScheme !== null && value === this._expectScheme;
        this._expectScheme = null;
        if (!ours) {
            const cfg = this._config();
            if (cfg.mode === 'sunset' || cfg.mode === 'custom') {
                // the user flipped it by hand: hold that choice until the next scheduled switch
                const p = plan(this._d.clock.now(), cfg, this._d.tz());
                const wantsDark = value === 'prefer-dark';
                if (wantsDark === p.dark)
                    this._setHold(0);
                else if (p.next)
                    this._setHold(p.next.t);
                this._d.log?.(`manual ${wantsDark ? 'dark' : 'light'}: held until ${p.next ? new Date(p.next.t).toISOString() : 'never'}`);
                this.evaluate('manual');
            }
        }
        this.syncLegacyTheme();
    }

    // ---- wallpaper pair ----
    _pairOf(uri) {
        if (!uri)
            return null;
        let path;
        try {
            path = GLib.filename_from_uri(uri)[0];
        } catch {
            return null;
        }
        const m = PAIR.exec(path);
        if (!m)
            return null;
        const other = `${m[1]}${m[2] === m[2].toLowerCase() ? OPPOSITE[m[2]] : OPPOSITE[m[2].toLowerCase()]}${m[3]}`;
        if (!this._d.fileExists(other))
            return null;
        const [light, dark] = IS_DARK[m[2].toLowerCase()] ? [other, path] : [path, other];
        return {light: GLib.filename_to_uri(light, null), dark: GLib.filename_to_uri(dark, null)};
    }

    // pairing on: picture-uri is the light picture of the pair and picture-uri-dark the dark one, so GNOME swaps (and
    // cross-fades) them with the style. The picture just picked decides the pair (changedKey), else the one showing.
    // A picture with no pair is left as it was set. Off: both keys hold the picture showing now.
    syncWallpaper(changedKey = null) {
        if (this._syncingWallpaper)
            return;
        const bg = this._d.background;
        const light = bg.get_string('picture-uri');
        const dark = bg.get_string('picture-uri-dark');
        const showing = this.isDark && dark ? dark : light;
        let want;
        if (this._d.settings.get_boolean('pair-wallpaper')) {
            const pair = this._pairOf(changedKey ? bg.get_string(changedKey) : showing);
            if (!pair)
                return;
            want = [pair.light, pair.dark];
        } else {
            want = [showing, showing];
        }
        if (light === want[0] && dark === want[1])
            return;
        this._syncingWallpaper = true;
        try {
            bg.delay();
            bg.set_string('picture-uri', want[0]);
            bg.set_string('picture-uri-dark', want[1]);
            bg.apply();
        } finally {
            this._syncingWallpaper = false;
        }
    }

    // ---- GTK 3 apps: the theme name carries the accent and the style ----
    syncLegacyTheme() {
        const {iface, settings, themeExists} = this._d;
        if (!settings.get_boolean('follow-legacy-theme'))
            return;
        const current = iface.get_string('gtk-theme');
        if (!FAMILY.test(current))
            return;     // a theme the user chose by hand: leave it
        const want = legacyThemeName(iface.get_string('accent-color'), this.isDark);
        if (want !== current && themeExists(want))
            iface.set_string('gtk-theme', want);
    }
}

export function defaultThemeExists(name) {
    const dirs = [GLib.build_filenamev([GLib.get_home_dir(), '.themes']),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'themes']),
        ...GLib.get_system_data_dirs().map(d => GLib.build_filenamev([d, 'themes']))];
    return dirs.some(d => GLib.file_test(GLib.build_filenamev([d, name, 'gtk-3.0', 'gtk.css']), GLib.FileTest.EXISTS));
}

export function defaultFileExists(path) {
    return Gio.File.new_for_path(path).query_exists(null);
}

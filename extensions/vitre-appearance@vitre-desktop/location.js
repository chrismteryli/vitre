// Where the sun is: GNOME's location (GeoClue, through the same 'org.gnome.Shell' agent id the shell's weather code
// uses) when sunset scheduling and Location Services are both on, else the rough coordinates of the time zone from the
// system's zone1970.tab. This file makes no network request of its own; GeoClue is GNOME's location service.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import Geoclue from 'gi://Geoclue';   // the shell itself imports it (misc/weather.js), so it is always there

Gio._promisify(Geoclue.Simple, 'new');

// "+404251-0740023" (ISO 6709, degrees minutes [seconds]) -> {lat, lon}
export function parseIso6709(s) {
    const m = /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/.exec(s);
    if (!m)
        return null;
    const dms = (sign, d, mi, se) => (sign === '-' ? -1 : 1) * (Number(d) + Number(mi) / 60 + Number(se ?? 0) / 3600);
    return {lat: dms(m[1], m[2], m[3], m[4]), lon: dms(m[5], m[6], m[7], m[8])};
}

export function zoneId() {
    let id = GLib.TimeZone.new_local().get_identifier();
    if (!id || id === 'Local' || id === 'localtime') {
        try {
            const target = GLib.file_read_link('/etc/localtime');
            id = target.split('/zoneinfo/')[1] ?? id;
        } catch {
            try {
                id = new TextDecoder().decode(GLib.file_get_contents('/etc/timezone')[1]).trim();
            } catch {}
        }
    }
    return id;
}

export function zoneCoordinates(id, tables = ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab']) {
    for (const table of tables) {
        let text;
        try {
            text = new TextDecoder().decode(GLib.file_get_contents(table)[1]);
        } catch {
            continue;
        }
        for (const line of text.split('\n')) {
            if (line.startsWith('#'))
                continue;
            const cols = line.split('\t');
            if (cols[2] === id)
                return parseIso6709(cols[1]);
        }
    }
    return null;
}

export class LocationSource {
    // settings: the extension's settings (mode and last-coordinates cache); onChange: called when the answer changes
    constructor(settings, onChange) {
        this._settings = settings;
        this._onChange = onChange;
        this._gclue = null;
        this._gclueId = 0;
        this._cancel = null;
        this._generation = 0;
        this._destroyed = false;
        this._locSettings = new Gio.Settings({schema_id: 'org.gnome.system.location'});
        this._locId = this._locSettings.connect('changed::enabled', () => this._update());
        this._modeId = settings.connect('changed::mode', () => this._update());
        this._zone = zoneCoordinates(zoneId());
        this._update();
    }

    get enabled() {
        return this._locSettings.get_boolean('enabled');
    }

    _active() {
        return !this._destroyed && this._settings.get_string('mode') === 'sunset' && this.enabled;
    }

    // {lat, lon, source: 'location' | 'timezone'} or null
    current() {
        if (this._active()) {
            const [lat, lon] = this._settings.get_value('last-coordinates').deepUnpack();
            if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
                return {lat, lon, source: 'location'};
        }
        return this._zone ? {...this._zone, source: 'timezone'} : null;
    }

    _update() {
        if (!this._active())
            this._stopGeoclue();
        if (this._active() && !this._gclue && !this._cancel)
            this._startGeoclue();
        this._onChange();
    }

    async _startGeoclue() {
        const generation = this._generation;
        this._cancel = new Gio.Cancellable();
        try {
            const gclue = await Geoclue.Simple.new('org.gnome.Shell', Geoclue.AccuracyLevel.CITY, this._cancel);
            if (!this._active() || generation !== this._generation)
                return;
            this._gclue = gclue;
        } catch (e) {
            if (generation === this._generation && !this._destroyed) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.log(`vitre-appearance: GeoClue unavailable, using the time zone: ${e.message}`);
                this._gclue = null;
                this._cancel = null;
            }
            return;
        }
        this._cancel = null;
        this._gclueId = this._gclue.connect('notify::location', () => this._fromGeoclue());
        this._fromGeoclue();
    }

    _fromGeoclue() {
        if (!this._active())
            return;
        const loc = this._gclue?.location;
        if (!loc)
            return;
        // rounded to about 1 km: plenty for the sun, and the cached value says little about where someone is
        const v = new GLib.Variant('(dd)', [Math.round(loc.latitude * 100) / 100, Math.round(loc.longitude * 100) / 100]);
        if (!this._settings.get_value('last-coordinates').equal(v)) {
            this._settings.set_value('last-coordinates', v);
            this._onChange();
        }
    }

    _stopGeoclue() {
        this._generation++;
        this._cancel?.cancel();
        this._cancel = null;
        if (this._gclue && this._gclueId)
            this._gclue.disconnect(this._gclueId);
        this._gclueId = 0;
        this._gclue = null;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._stopGeoclue();
        if (this._locId)
            this._locSettings.disconnect(this._locId);
        this._locId = 0;
        if (this._modeId)
            this._settings.disconnect(this._modeId);
        this._modeId = 0;
    }
}

// When the style should be light and when dark. Pure functions (GLib only): the shell extension and the unit test both
// use them, the test with a simulated clock and a fixed time zone.
import GLib from 'gi://GLib';

const DAY_MS = 86400000;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

// Sunrise and sunset (ms since the epoch, UTC) for the local calendar day that contains `dayMs` at latitude `lat`,
// longitude `lon` (east positive), using the NOAA sunrise equation (about a minute of error at the latitudes people live
// at). Returns {sunrise, sunset}; {polar: 'day'} when the sun does not set that day, {polar: 'night'} when it does not rise.
export function sunTimes(dayMs, lat, lon, tz) {
    const local = GLib.DateTime.new_from_unix_utc(Math.floor(dayMs / 1000)).to_timezone(tz);
    const noon = GLib.DateTime.new(tz, local.get_year(), local.get_month(), local.get_day_of_month(), 12, 0, 0);
    const jNoon = noon.to_unix() / 86400 + 2440587.5;
    const n = Math.round(jNoon - 2451545.0 + lon / 360);   // the J2000 day whose solar noon is this local day's
    const jStar = n - lon / 360;
    const M = (357.5291 + 0.98560028 * jStar) % 360;
    const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
    const lambda = (M + C + 180 + 102.9372) % 360;
    const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * lambda));
    const sinDec = Math.sin(rad(lambda)) * Math.sin(rad(23.4397));
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosW = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * sinDec) / (Math.cos(rad(lat)) * cosDec);
    if (cosW > 1)
        return {polar: 'night'};
    if (cosW < -1)
        return {polar: 'day'};
    const w = deg(Math.acos(cosW));
    const toMs = j => Math.round((j - 2440587.5) * DAY_MS);
    return {sunrise: toMs(jTransit - w / 360), sunset: toMs(jTransit + w / 360)};
}

// Local midnight of the day `offset` days after the one containing nowMs.
function dayStart(nowMs, offset, tz) {
    const d = GLib.DateTime.new_from_unix_utc(Math.floor(nowMs / 1000)).to_timezone(tz);
    const m = GLib.DateTime.new(tz, d.get_year(), d.get_month(), d.get_day_of_month(), 0, 0, 0).add_days(offset);
    return m.to_unix() * 1000;
}

function atMinutes(startMs, minutes, tz) {
    const s = GLib.DateTime.new_from_unix_utc(startMs / 1000).to_timezone(tz);
    const t = GLib.DateTime.new(tz, s.get_year(), s.get_month(), s.get_day_of_month(),
        Math.floor(minutes / 60), minutes % 60, 0);
    return t.to_unix() * 1000;
}

// The switch points around nowMs (yesterday to the day after tomorrow), sorted: [{t, dark}]. In polar day or night the
// day has no switch and one event at its local midnight carries the state.
export function events(nowMs, cfg, tz) {
    const out = [];
    for (let i = -1; i <= 2; i++) {
        const start = dayStart(nowMs, i, tz);
        if (cfg.mode === 'custom' || !cfg.location) {
            out.push({t: atMinutes(start, cfg.lightTime, tz), dark: false});
            out.push({t: atMinutes(start, cfg.darkTime, tz), dark: true});
            continue;
        }
        const s = sunTimes(start + 12 * 3600000, cfg.location.lat, cfg.location.lon, tz);
        if (s.polar)
            out.push({t: start, dark: s.polar === 'night'});
        else
            out.push({t: s.sunrise, dark: false}, {t: s.sunset, dark: true});
    }
    out.sort((a, b) => a.t - b.t);
    // drop events that repeat the state before them (polar runs), so "next" is always a real change
    return out.filter((e, i) => i === 0 || e.dark !== out[i - 1].dark);
}

// {dark, last, next}: the state now, the switch that set it, and the next switch (null when none in the window).
export function plan(nowMs, cfg, tz) {
    const ev = events(nowMs, cfg, tz);
    let last = null, next = null;
    for (const e of ev) {
        if (e.t <= nowMs)
            last = e;
        else if (!next)
            next = e;
    }
    return {dark: last ? last.dark : !ev[0]?.dark, last, next};
}

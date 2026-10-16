/* Small widgets for the Notification Center column: an analog clock (one per configured
 * world clock) and a weather tile. Both read GNOME's own data sources (the date menu's
 * world-clocks section and weather client); they only draw. */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather?version=4.0';
import St from 'gi://St';

import {clockAngles} from './helpers.js';

// A short city name for a world-clock location: the city, never the airport/station name.
export function cityName(location) {
    try {
        let l = location;
        for (let i = 0; l && i < 6; i++) {
            // weather stations (airports) carry their own names: use the city above them
            if (l.get_level?.() === GWeather.LocationLevel.WEATHER_STATION && l.get_parent?.()) {
                l = l.get_parent();
                continue;
            }
            const city = l.get_city_name?.();
            if (city)
                return city === 'New York City' ? 'New York' : city;
            l = l.get_parent?.();
        }
        const name = location?.get_name?.() ?? '';
        return name.replace(/\s+(International\s+)?Airport.*$/i, '').split(',')[0];
    } catch {
        return '';
    }
}

function rgba(cr, r, g, b, a = 1) {
    cr.setSourceRGBA(r, g, b, a);
}

export const AnalogClockWidget = GObject.registerClass(
class AnalogClockWidget extends St.BoxLayout {
    // location: GWeather.Location with a timezone; null = local time
    _init(location) {
        super._init({
            style_class: 'nc-widget nc-small nc-clock-widget',
            orientation: Clutter.Orientation.VERTICAL, x_expand: false, y_expand: false,
        });
        this._location = location;
        const name = location ? cityName(location) : '';
        this._city = new St.Label({
            text: name, style_class: 'nc-clock-city', x_align: Clutter.ActorAlign.START, visible: name !== '',
        });
        this._city.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END
        this.add_child(this._city);
        this._face = new St.DrawingArea({x_expand: true, y_expand: true, style_class: 'nc-clock-face'});
        this._face.connect('repaint', area => this._draw(area));
        this.add_child(this._face);
    }

    now() {
        const tz = this._location?.get_timezone?.();
        return tz ? GLib.DateTime.new_now(tz) : GLib.DateTime.new_now_local();
    }

    tick() {
        this._face.queue_repaint();
    }

    _draw(area) {
        const [w, h] = area.get_surface_size();
        const cr = area.get_context();
        const dt = this.now();
        const a = clockAngles(dt.get_hour(), dt.get_minute(), dt.get_second() + dt.get_microsecond() / 1e6);
        const R = Math.min(w, h) / 2 - 8;
        const cx = w / 2;
        const cy = h / 2;
        // face
        cr.arc(cx, cy, R, 0, 2 * Math.PI);
        rgba(cr, 0.97, 0.97, 0.98);
        cr.fill();
        // ticks
        rgba(cr, 0.3, 0.3, 0.32);
        cr.setLineCap(1);
        for (let i = 0; i < 12; i++) {
            const ang = i * Math.PI / 6;
            const long = i % 3 === 0;
            cr.setLineWidth(long ? 3 : 2);
            cr.moveTo(cx + Math.sin(ang) * (R - (long ? 16 : 12)), cy - Math.cos(ang) * (R - (long ? 16 : 12)));
            cr.lineTo(cx + Math.sin(ang) * (R - 5), cy - Math.cos(ang) * (R - 5));
            cr.stroke();
        }
        // hour + minute hands
        rgba(cr, 0.1, 0.1, 0.11);
        cr.setLineCap(1);
        cr.setLineWidth(5);
        cr.moveTo(cx, cy);
        cr.lineTo(cx + Math.sin(a.hour) * R * 0.5, cy - Math.cos(a.hour) * R * 0.5);
        cr.stroke();
        cr.setLineWidth(3.5);
        cr.moveTo(cx, cy);
        cr.lineTo(cx + Math.sin(a.minute) * R * 0.78, cy - Math.cos(a.minute) * R * 0.78);
        cr.stroke();
        // second hand + hub (orange)
        rgba(cr, 1.0, 0.62, 0.04);
        cr.setLineWidth(1.6);
        cr.moveTo(cx - Math.sin(a.second) * 14, cy + Math.cos(a.second) * 14);
        cr.lineTo(cx + Math.sin(a.second) * R * 0.86, cy - Math.cos(a.second) * R * 0.86);
        cr.stroke();
        cr.arc(cx, cy, 4, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
});

export const WeatherWidget = GObject.registerClass(
class WeatherWidget extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'nc-widget nc-small nc-weather-widget',
            orientation: Clutter.Orientation.VERTICAL, x_expand: false, y_expand: false,
        });
        this._city = new St.Label({style_class: 'nc-weather-city', x_align: Clutter.ActorAlign.START});
        this._temp = new St.Label({style_class: 'nc-weather-temp', x_align: Clutter.ActorAlign.START});
        this._icon = new St.Icon({style_class: 'nc-weather-icon', x_align: Clutter.ActorAlign.START});
        this._cond = new St.Label({style_class: 'nc-weather-condition', x_align: Clutter.ActorAlign.START});
        this._range = new St.Label({style_class: 'nc-weather-range', x_align: Clutter.ActorAlign.START});
        this.add_child(this._city);
        this.add_child(this._temp);
        this.add_child(new St.Widget({y_expand: true}));
        this.add_child(this._icon);
        this.add_child(this._cond);
        this.add_child(this._range);
    }

    // data: {city, temp, condition, iconName, range} from NotificationCenter._weatherData()
    update(data) {
        this._city.text = data.city ?? '';
        this._temp.text = data.temp ?? '';
        this._cond.text = data.condition ?? '';
        this._range.text = data.range ?? '';
        if (data.iconName)
            this._icon.icon_name = data.iconName;
        this._icon.visible = Boolean(data.iconName);
    }
});

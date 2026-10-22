/* The battery as GNOME's own top bar shows it: UPower's DisplayDevice (the same object, the same D-Bus interface file
 * and the same icon and percentage rules as GNOME 51's power toggle in ui/status/system.js), read through our own proxy so
 * nothing of GNOME's indicator is touched. A machine without a battery (or without UPower) gives `info === null` and the
 * capsule shows no battery at all. What the capsule draws (batteryGlyph.js) is `level`, `power` and `low`. */
import Gio from 'gi://Gio';
import UPower from 'gi://UPowerGlib';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {LOW_PERCENT} from './batteryGlyph.js';

const BUS_NAME = 'org.freedesktop.UPower';
const OBJECT_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

let DeviceProxy = null;
let percentFormat = null;

export class Battery {
    constructor(onChange) {
        this._onChange = onChange;
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._ready = false;
        try {
            DeviceProxy ??= Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.UPower.Device'));
            percentFormat ??= new Intl.NumberFormat(undefined, {style: 'percent'});
            this._proxy = new DeviceProxy(Gio.DBus.system, BUS_NAME, OBJECT_PATH, (proxy, error) => {
                if (this._destroyed)
                    return;
                if (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Vitre Corner: no battery information (${error.message})`);
                    return;
                }
                this._ready = true;
                // the name can appear later (UPower restarted): the proxy reloads its properties and says so
                proxy.connectObject(
                    'g-properties-changed', () => this._changed(),
                    'notify::g-name-owner', () => this._changed(), this);
                this._changed();
            }, this._cancellable);
        } catch (e) {
            console.warn(`Vitre Corner: no battery information (${e.message})`);
            this._proxy = null;
        }
    }

    _changed() {
        try {
            this._onChange?.();
        } catch (e) {
            console.error(`Vitre Corner: battery update failed: ${e.message}`);
        }
    }

    /* null: no battery to show. Otherwise what the capsule draws: the level (0..1), whether it is on external power and how
     * (charging, charged, or plugged in but held: a charge limit or a pause), whether it is low, and the percentage formatted
     * for the locale ("76%"); GNOME's icon name for the same state (the rig compares it with the top bar's), and the state
     * for the accessible name. */
    get info() {
        const p = this._proxy;
        if (!this._ready || !p || !p.g_name_owner || !p.IsPresent)
            return null;
        const percent = Math.max(0, Math.min(100, p.Percentage ?? 0));
        let chargingState = '';
        if (p.State === UPower.DeviceState.CHARGING)
            chargingState = '-charging';
        else if (p.State === UPower.DeviceState.PENDING_CHARGE && p.ChargeThresholdEnabled)
            chargingState = '-plugged-in';
        const fillLevel = 10 * Math.floor(percent / 10);
        const charged = p.State === UPower.DeviceState.FULLY_CHARGED ||
            (p.State === UPower.DeviceState.CHARGING && fillLevel === 100);
        // on external power: charging, full, or plugged in and held (UPower's pending-charge: a charge limit reached)
        let power = null;
        if (p.State === UPower.DeviceState.FULLY_CHARGED)
            power = 'charged';
        else if (p.State === UPower.DeviceState.CHARGING)
            power = 'charging';
        else if (p.State === UPower.DeviceState.PENDING_CHARGE)
            power = 'plugged';
        return {
            percent,
            level: percent / 100,
            power,
            low: !power && percent < LOW_PERCENT,
            text: percentFormat.format(percent / 100),
            iconName: charged ? 'battery-level-100-charged-symbolic' : `battery-level-${fillLevel}${chargingState}-symbolic`,
            fallbackIconName: p.IconName || 'battery-symbolic',
            charging: p.State === UPower.DeviceState.CHARGING,
            charged,
            timeToEmpty: Number(p.TimeToEmpty ?? 0),
            timeToFull: Number(p.TimeToFull ?? 0),
        };
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        this._onChange = null;
    }
}

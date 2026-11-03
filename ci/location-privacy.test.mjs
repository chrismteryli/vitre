import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
};

async function loadLocation() {
    const calls = [];
    const pending = [];
    const locationSettings = {
        enabled: true,
        handlers: new Map(),
        nextId: 1,
        get_boolean(key) {
            assert.equal(key, 'enabled');
            return this.enabled;
        },
        connect(signal, callback) {
            const id = this.nextId++;
            this.handlers.set(id, callback);
            return id;
        },
        disconnect(id) {
            this.handlers.delete(id);
        },
        setEnabled(value) {
            this.enabled = value;
            for (const callback of this.handlers.values())
                callback();
        },
    };
    class Cancellable {
        constructor() {
            this.cancelled = false;
        }
        cancel() {
            this.cancelled = true;
        }
    }
    const Gio = {
        Settings: class {
            constructor({schema_id}) {
                assert.equal(schema_id, 'org.gnome.system.location');
                return locationSettings;
            }
        },
        Cancellable,
        IOErrorEnum: {CANCELLED: 1},
        _promisify() {},
    };
    const GLib = {
        TimeZone: {new_local: () => ({get_identifier: () => 'Etc/UTC'})},
        file_get_contents(path) {
            assert.equal(path, '/usr/share/zoneinfo/zone1970.tab');
            return [true, new TextEncoder().encode('XX\t+404251-0740023\tEtc/UTC\n')];
        },
        Variant: class {
            constructor(signature, value) {
                this.signature = signature;
                this.value = value;
            }
            equal(other) {
                return JSON.stringify(this.value) === JSON.stringify(other.value);
            }
        },
    };
    const Geoclue = {
        AccuracyLevel: {CITY: 4},
        Simple: {
            new(...args) {
                const request = deferred();
                calls.push({args, request});
                pending.push(request);
                return request.promise;
            },
        },
    };
    let source = await readFile(new URL('../extensions/vitre-appearance@vitre-desktop/location.js', import.meta.url), 'utf8');
    source = source
        .replace("import Gio from 'gi://Gio';", 'const Gio = globalThis.__testGio;')
        .replace("import GLib from 'gi://GLib';", 'const GLib = globalThis.__testGLib;')
        .replace("import Geoclue from 'gi://Geoclue';   // the shell itself imports it (misc/weather.js), so it is always there", 'const Geoclue = globalThis.__testGeoclue;');
    globalThis.__testGio = Gio;
    globalThis.__testGLib = GLib;
    globalThis.__testGeoclue = Geoclue;
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`;
    const module = await import(url);
    delete globalThis.__testGio;
    delete globalThis.__testGLib;
    delete globalThis.__testGeoclue;
    return {LocationSource: module.LocationSource, calls, locationSettings};
}

function extensionSettings(mode = 'manual') {
    return {
        mode,
        writes: [],
        coordinates: [0, 0],
        handlers: new Map(),
        nextId: 1,
        get_string(key) {
            assert.equal(key, 'mode');
            return this.mode;
        },
        get_value(key) {
            assert.equal(key, 'last-coordinates');
            return {deepUnpack: () => this.coordinates, equal: () => false};
        },
        set_value(key, value) {
            assert.equal(key, 'last-coordinates');
            this.writes.push(value.value);
            this.coordinates = value.value;
        },
        connect(signal, callback) {
            assert.equal(signal, 'changed::mode');
            const id = this.nextId++;
            this.handlers.set(id, callback);
            return id;
        },
        disconnect(id) {
            this.handlers.delete(id);
        },
        setMode(value) {
            this.mode = value;
            for (const callback of this.handlers.values())
                callback();
        },
    };
}

function client(latitude = 40.714, longitude = -74.006) {
    return {
        location: {latitude, longitude},
        handlers: new Map(),
        nextId: 1,
        connect(signal, callback) {
            assert.equal(signal, 'notify::location');
            const id = this.nextId++;
            this.handlers.set(id, callback);
            return id;
        },
        disconnect(id) {
            this.handlers.delete(id);
        },
    };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

for (const mode of ['manual', 'custom']) {
    test(`${mode} never requests or writes coordinates and retains timezone scheduling`, async () => {
        const {LocationSource, calls} = await loadLocation();
        const settings = extensionSettings(mode);
        const source = new LocationSource(settings, () => {});
        assert.equal(calls.length, 0);
        assert.deepEqual(settings.writes, []);
        const current = source.current();
        assert.equal(current.source, 'timezone');
        assert.ok(Math.abs(current.lat - 40.71416666666667) < 1e-12);
        assert.ok(Math.abs(current.lon + 74.00638888888889) < 1e-12);
        source.destroy();
    });
}

test('sunset starts GeoClue and caches its coordinates', async () => {
    const {LocationSource, calls} = await loadLocation();
    const settings = extensionSettings('sunset');
    const source = new LocationSource(settings, () => {});
    assert.equal(calls.length, 1);
    calls[0].request.resolve(client());
    await tick();
    assert.deepEqual(settings.writes, [[40.71, -74.01]]);
    assert.equal(source.current().source, 'location');
    source.destroy();
});

test('leaving sunset disconnects GeoClue and stops coordinate writes', async () => {
    const {LocationSource, calls} = await loadLocation();
    const settings = extensionSettings('sunset');
    const source = new LocationSource(settings, () => {});
    const gclue = client();
    calls[0].request.resolve(gclue);
    await tick();
    assert.equal(gclue.handlers.size, 1);
    settings.setMode('custom');
    assert.equal(gclue.handlers.size, 0);
    assert.equal(source.current().source, 'timezone');
    source._fromGeoclue();
    assert.equal(settings.writes.length, 1);
    source.destroy();
});

test('disabling location services in sunset tears down GeoClue', async () => {
    const {LocationSource, calls, locationSettings} = await loadLocation();
    const settings = extensionSettings('sunset');
    const source = new LocationSource(settings, () => {});
    const gclue = client();
    calls[0].request.resolve(gclue);
    await tick();
    locationSettings.setEnabled(false);
    assert.equal(gclue.handlers.size, 0);
    assert.equal(source.current().source, 'timezone');
    source.destroy();
});

for (const end of ['mode', 'destroy']) {
    test(`pending GeoClue cannot resurrect after ${end === 'mode' ? 'leaving sunset' : 'destroy'}`, async () => {
        const {LocationSource, calls} = await loadLocation();
        const settings = extensionSettings('sunset');
        const source = new LocationSource(settings, () => {});
        const request = calls[0].request;
        const gclue = client();
        if (end === 'mode')
            settings.setMode('manual');
        else
            source.destroy();
        request.resolve(gclue);
        await tick();
        assert.equal(gclue.handlers.size, 0);
        assert.deepEqual(settings.writes, []);
        assert.equal(source._gclue, null);
        source.destroy();
    });
}

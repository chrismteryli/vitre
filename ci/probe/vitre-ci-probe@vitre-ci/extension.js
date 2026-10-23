// Vitre CI probe. CI only: ci/smoke-test.sh copies this into the throwaway HOME next to the Vitre extensions and enables it first.
// It is not part of Vitre and install.sh never installs it. What it does:
//   1. exports org.vitre.CiProbe on the session bus:
//        Info()            -> JSON about the running shell (monitors, stage size, windows, extension states)
//        Screenshot(path)  -> writes a PNG of the stage (org.gnome.Shell.Screenshot only answers GNOME's own apps, so the screenshot
//                             is taken from inside the shell, the way GNOME's own screenshot tool does it)
//      A fresh GNOME session starts in the Overview, so Screenshot leaves it first: the picture shows the desktop a user sees.
//   2. only if trash:/// cannot be watched (no gvfs daemon), maps it to an empty folder, the way the private rig does. Vitre Dock watches the
//      trash while it starts, and a CI image without gvfs would otherwise make the Dock fail for a reason that has nothing to do with Vitre.
//      Info() reports trash_shim=true when that happened, and the smoke test prints it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `<node>
  <interface name="org.vitre.CiProbe">
    <method name="Info"><arg type="s" direction="out" name="json"/></method>
    <method name="Screenshot"><arg type="s" direction="in" name="path"/><arg type="b" direction="out" name="ok"/><arg type="s" direction="out" name="error"/></method>
  </interface>
</node>`;

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function trashCannotBeWatched() {
    try {
        const monitor = Gio.File.new_for_uri('trash:///').monitor_directory(Gio.FileMonitorFlags.NONE, null);
        monitor.cancel();
        return false;
    } catch (_e) {
        return true;
    }
}

export default class VitreCiProbe extends Extension {
    enable() {
        this._shim = false;
        this._origNewForUri = null;
        if (trashCannotBeWatched()) {
            const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'ci-fake-trash']);
            GLib.mkdir_with_parents(dir, 0o700);
            this._origNewForUri = Gio.File.new_for_uri;
            const orig = this._origNewForUri;
            Gio.File.new_for_uri = function (uri) {
                return uri === 'trash:///' ? Gio.File.new_for_path(dir) : orig.call(Gio.File, uri);
            };
            this._shim = true;
        }
        try {
            Gio._promisify(Shell.Screenshot.prototype, 'screenshot');
        } catch (_e) { /* already done */ }
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/vitre/CiProbe');
        this._owner = Gio.DBus.session.own_name('org.vitre.CiProbe', Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        if (this._owner) {
            Gio.DBus.session.unown_name(this._owner);
            this._owner = 0;
        }
        this._dbus?.unexport();
        this._dbus = null;
        if (this._origNewForUri) {
            Gio.File.new_for_uri = this._origNewForUri;
            this._origNewForUri = null;
        }
    }

    Info() {
        const manager = Main.extensionManager;
        const extensions = {};
        for (const uuid of manager.getUuids()) {
            const e = manager.lookup(uuid);
            extensions[uuid] = {state: e?.state ?? null, error: e?.error ?? null};
        }
        return JSON.stringify({
            gnome_shell: Config.PACKAGE_VERSION,
            session_mode: Main.sessionMode.currentMode,
            monitors: Main.layoutManager.monitors.length,
            stage: [Math.round(global.stage.width), Math.round(global.stage.height)],
            windows: global.get_window_actors().length,
            overview: Main.overview.visible,
            trash_shim: this._shim,
            extensions,
        });
    }

    async ScreenshotAsync(params, invocation) {
        const [path] = params;
        try {
            if (Main.overview.visible) {
                Main.overview.hide();
                for (let i = 0; i < 20 && Main.overview.visible; i++)
                    await sleep(250);
            }
            await sleep(1000);   // let the last frame land
            const file = Gio.File.new_for_path(path);
            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new Shell.Screenshot().screenshot(false, stream);
            stream.close(null);
            invocation.return_value(new GLib.Variant('(bs)', [true, '']));
        } catch (e) {
            invocation.return_value(new GLib.Variant('(bs)', [false, String(e)]));
        }
    }
}

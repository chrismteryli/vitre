import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {newPage, finish} from './context.js';
import {commandRow, linkRow, textRow} from '../widgets/rows.js';
import {APP_VERSION, REPO_URL} from '../config.js';

export const id = 'about';
export const title = 'About';
export const icon = 'vitre-settings-about-symbolic';

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes).trim() : null;
    } catch {
        return null;
    }
}

// How Vitre is installed here, and its version: the system packages write /usr/share/vitre/VERSION, the per-user
// installer keeps a backup folder in ~/.local/share/vitre-backup. A machine can have both.
export function detectInstall() {
    let version = null;
    for (const dir of GLib.get_system_data_dirs()) {
        version = readText(GLib.build_filenamev([dir, 'vitre', 'VERSION']));
        if (version)
            break;
    }
    const system = Boolean(version);
    const userVersion = readText(GLib.build_filenamev([GLib.get_user_data_dir(), 'vitre', 'VERSION']));
    const user = Boolean(userVersion) ||
        GLib.file_test(GLib.build_filenamev([GLib.get_user_data_dir(), 'vitre-backup']), GLib.FileTest.IS_DIR);
    let label = 'Not found';
    if (system && user)
        label = 'System packages and a per-user install';
    else if (system)
        label = 'System packages (apt)';
    else if (user)
        label = 'Per-user install';
    return {system, user, label, version: version ?? userVersion};
}

const UNINSTALL_USER = {
    title: 'Per-user Install',
    steps: 'Open a terminal in the Vitre folder you installed from and run:',
    command: './uninstall.sh',
    after: 'It puts back the files and settings it saved when Vitre was installed (in ~/.local/share/vitre-backup). ' +
        'Sign out and back in afterwards.',
};
const UNINSTALL_SYSTEM = {
    title: 'System Packages',
    steps: 'Sign out, choose Ubuntu with the gear button on the login screen and sign in. Then run:',
    command: 'sudo apt purge vitre-desktop vitre-session \\\n' +
        '    vitre-shell vitre-shell-extras vitre-theme \\\n' +
        '    vitre-icons vitre-icons-base vitre-cursor \\\n' +
        '    vitre-backgrounds vitre-system',
};

function header(install) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.CENTER, css_classes: ['vitre-about-header'],
    });
    box.append(new Gtk.Image({icon_name: 'org.vitre.Settings', pixel_size: 96, css_classes: ['icon-dropshadow']}));
    box.append(new Gtk.Label({label: 'Vitre', css_classes: ['title-1']}));
    box.append(new Gtk.Label({
        label: install.version ? `Version ${install.version}` : 'Glass desktop for GNOME',
        css_classes: ['dim-label'],
    }));
    const group = new Adw.PreferencesGroup();
    group.add(box);
    return group;
}

export function build(ctx) {
    const page = newPage({name: id, title, icon});
    const install = detectInstall();
    page.add(header(install));
    page._vitreGroups = 1;

    ctx.group(page, {}, [
        textRow({title: 'Installed As', subtitle: install.label}),
        ctx.extensions.shellVersion && textRow({title: 'GNOME Shell', subtitle: ctx.extensions.shellVersion}),
        textRow({title: 'Vitre Settings', subtitle: APP_VERSION}),
    ]);

    ctx.group(page, {}, [
        linkRow({title: 'Source Code', uri: REPO_URL}),
        linkRow({title: 'Report a Problem', uri: `${REPO_URL}/issues`}),
    ]);

    // both sets of steps when neither or both are found; only the one that applies otherwise
    const both = install.system === install.user;
    const rows = [
        (both || install.user) && commandRow(UNINSTALL_USER),
        (both || install.system) && commandRow(UNINSTALL_SYSTEM),
    ];
    ctx.group(page, {title: 'Uninstall', description: 'Nothing is removed from here. These are the steps.'}, rows);

    return finish(page);
}

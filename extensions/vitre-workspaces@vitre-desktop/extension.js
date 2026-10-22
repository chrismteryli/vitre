// SPDX-License-Identifier: GPL-3.0-or-later
// Vitre Workspaces: workspace switches as a glass depth slide.
//
// A key press (Ctrl+Alt+arrows), the three- or four-finger swipe, a click in the Dock or the top bar: the workspace you
// leave steps back and dims while the next one slides in and settles on the Vitre stretch spring, with a soft lit edge
// between the two. The fingers move it one to one, it reverses under them without a jump, and on lift-off it carries on
// at their speed. The top bar and the Dock stay where they are. depthMotion.js has the details and every hook.
// Inside the overview the scroll from one workspace to the next rides the same spring (overviewScroll.js).
//
// Setting: org.gnome.shell.extensions.vitre-workspaces style = 'vitre' (default) | 'stock'. 'stock' removes every hook,
// so switches (and the overview's scroll) are GNOME's own again; it takes effect at once.
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DepthMotion} from './depthMotion.js';
import {OverviewScroll} from './overviewScroll.js';

export default class VitreWorkspacesExtension extends Extension {
    enable() {
        this._motion = null;
        this._overview = null;
        this._settings = null;
        try {
            this._settings = this.getSettings();
            this._styleId = this._settings.connect('changed::style', () => this._sync());
        } catch (e) {
            console.warn(`Vitre Workspaces: no settings, using the vitre style (${e.message})`);
            this._settings = null;
        }
        this._sync();
    }

    disable() {
        if (this._settings && this._styleId)
            this._settings.disconnect(this._styleId);
        this._styleId = 0;
        this._settings = null;
        this._stop();
    }

    _sync() {
        const want = (this._settings?.get_string('style') ?? 'vitre') === 'vitre';
        if (want && !this._motion && !this._overview) {
            const motion = new DepthMotion();
            try {
                motion.install();
                this._motion = motion;
            } catch (e) {
                console.warn(`Vitre Workspaces: GNOME's own slide stays (${e.message})`);
                try {
                    motion.uninstall();
                } catch (_e) { /* nothing installed */ }
            }
            // the overview's own scroll: independent of the desktop part, so either one can stay GNOME's alone
            const overview = new OverviewScroll();
            try {
                overview.install();
                this._overview = overview;
            } catch (e) {
                console.warn(`Vitre Workspaces: the overview keeps GNOME's scroll (${e.message})`);
                try {
                    overview.uninstall();
                } catch (_e) { /* nothing installed */ }
            }
        } else if (!want && (this._motion || this._overview)) {
            this._stop();
        }
    }

    _stop() {
        const motion = this._motion;
        const overview = this._overview;
        this._motion = null;
        this._overview = null;
        try {
            overview?.uninstall();
        } catch (e) {
            console.error(`Vitre Workspaces: overview cleanup: ${e.message}`);
        }
        try {
            motion?.uninstall();
        } catch (e) {
            console.error(`Vitre Workspaces: cleanup: ${e.message}`);
        }
    }

    // rig: the state the harness samples (null while the style is stock or the extension is off)
    snapshot() {
        return this._motion?.snapshot() ?? null;
    }

    get motion() {
        return this._motion ?? null;
    }

    // rig: the overview scroll's state (null while the style is stock or the extension is off)
    get overview() {
        return this._overview ?? null;
    }
}

import 'gi://Gtk?version=4.0';
import 'gi://Gdk?version=4.0';
import 'gi://Adw?version=1';
import System from 'system';

import {VitreSettingsApplication} from './application.js';

export function main() {
    const app = new VitreSettingsApplication();
    return app.runAsync([System.programInvocationName, ...System.programArgs]);
}

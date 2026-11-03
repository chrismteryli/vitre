// The pages in sidebar order. A later page (accent colours, sounds, the first-run tour) is one module here: it exports
// id, title, icon and build(ctx), and build returns null when nothing on it applies to this machine.
import * as motion from './motion.js';
import * as dock from './dock.js';
import * as windows from './windows.js';
import * as glass from './glass.js';
import * as look from './look.js';
import * as about from './about.js';

export const PAGES = [motion, dock, windows, glass, look, about];

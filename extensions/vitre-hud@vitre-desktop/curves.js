/* The menu-bar HUD's motion constants (liquid v3). No traced tables any more: the classic capsule (drip-style classic) moves
 * on liquid.js springs, the liquid one pours (liquidDrip.js). Pure, no gi imports.
 *
 * Classic: the capsule's presence (its opacity) is a Fade spring, its scale about the top-centre a 'pour' spring from the
 * measured start pose (0.945 wide, 0.92 high, the top edge never moves) to 1; the glass layer follows the presence a little
 * behind it (it is turned on once the presence is past GLASS_FROM). Leaving: presence to 0 on the fade role's exit spring,
 * the scale to the measured end pose on the pour exit spring (never bouncing). A value that arrives while it leaves turns it
 * around from where it is, with its speed.
 * Level: the fill's width is a 'bead' spring (it sloshes a little past a new value and settles); every press jostles the
 * settled capsule's width with a bead kick (outward for up, inward for down).
 */

export const ENTER_FROM = {sx: 0.945, sy: 0.92};    // the measured start pose of the classic capsule
export const EXIT_TO = {sx: 0.95, sy: 0.92};        // ... and its end pose
export const GLASS_FROM = 0.15;                     // the glass layer comes in once the presence is past this

export const DWELL_MS = 900;      // measured 0.92 s and 0.88 s after the last value change
export const JOSTLE_PX = 35;      // a press kicks the capsule's half width by this many px per second (the lab's 70 x volume 0.5)

export const clamp01 = v => Math.min(1, Math.max(0, v));

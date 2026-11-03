/* Super-Tab motion constants (liquid v3). No traced table any more: the dismissal moves on liquid.js springs.
 *
 *   show delay   : the panel starts to pour in (extension.js: scale 0.92 -> 1 on the pour spring, opacity on the fade
 *                  role; lab 2) this long after the switcher key press.
 *                  the reference design: 167 ms (a reference clip, reference-era clip) to 200 ms (reference, A16). The rig stamps the first
 *                  full frame 3-12 ms after the reveal (next 120 Hz frame + paint), so 178 puts the visible
 *                  frame at ~181-190 ms, the middle of the the reference design range.
 *   fade out     : the panel's opacity on the fade role's exit spring (critically damped, never past 0) and its scale to
 *                  0.97 on the pour exit spring, while the chosen window is already coming forward.
 *   blur         : the icons smear while the panel fades: the blur radius on the fade role's spring, up to BLUR_MAX_RADIUS
 *                  (an estimate). Reduced motion: a 160 ms cross-fade, no smear.
 */
export const SHOW_DELAY_MS = 178;
export const BLUR_MAX_RADIUS = 10;      // estimate

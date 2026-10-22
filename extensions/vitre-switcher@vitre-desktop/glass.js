/* "Clear glass" for the switcher panel: the A9 recipe (vitre-controls@vitre-desktop glass.js), own copy.
 * A layer of Clutter.Clone copies of the wallpaper and window groups, blurred in ACTOR mode, cut to a rounded
 * rectangle by a shader that also adds the light tint and the specular rim. The layer is larger than the
 * panel by MARGIN on every side so the blur never samples past its own edge. It works inside offscreens and
 * under parent opacity, and reads no stage framebuffer.
 * Why not Shell.BlurEffect in BACKGROUND mode: no corner radius, cannot be masked (A9 probe 2026-10-10).
 *
 * Legible over any backdrop (2026-10-16): over a white window the clear glass was white too, and so was the
 * text on it. The same shader now keeps the blurred backdrop's luminance as it is up to a knee and eases it
 * toward a cap above that, per pixel and every frame. Dark backdrops look as before; a white window or a
 * bright streak of the wallpaper behind the panel reads as smoked glass under white text. It needs no readback
 * and no extra pass. Outside the shape it draws a contact line and a soft drop shadow (an analytic profile of
 * the same distance field, inside the layer's existing margin), and inside a soft light under the rim, so the
 * panel stands off a bright window.
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const MARGIN = 40;
export const BLUR_RADIUS = 16;

// Same finish as A9's clear glass (measured against the reference design guide images), plus the legibility
// terms (2026-10-16, tuned in the rig over a white window, a dark window and the wallpaper):
//   knee, cap   grey levels: backdrop luminance kept up to knee, eased toward cap above it (the white label
//               over the cap measured 8.4:1)
//   vibrance    saturation given back to a dimmed backdrop, so dimmed colour stays colour and not grey
//   glow, glowWidth   a soft light under the rim (px), weighted like the rim (top brightest)
//   line        a dark contact line just outside the edge (invisible on dark, crisp on white)
//   shadow, shadowY, shadowSoft   drop shadow opacity, downward offset and softness (px, Gaussian sigma)
export const GLASS_FINISH = {
    tint: 0.10, rimSide: 0.16, rimTop: 0.80, rimBottom: 0.70, rimWidth: 1.9,
    knee: 0.14, cap: 0.20, vibrance: 0.7,
    glow: 0.16, glowWidth: 10,
    line: 0.22,
    shadow: 0.30, shadowY: 6, shadowSoft: 9,
};

const FINISH_UNIFORMS = {
    tint: 'u_tint', rimSide: 'u_rs', rimTop: 'u_rt', rimBottom: 'u_rb', rimWidth: 'u_rw',
    knee: 'u_knee', cap: 'u_cap', vibrance: 'u_vib', glow: 'u_gl', glowWidth: 'u_glw', line: 'u_ln',
    shadow: 'u_sh', shadowY: 'u_shy', shadowSoft: 'u_shs',
};

// knee and cap are grey levels; the shader compares linear luminance, so every hue is held to the same cap
const uniformValue = (key, v) => key === 'knee' || key === 'cap' ? v ** 2.2 : v;

function float(v) {
    const g = new GObject.Value();
    g.init(GObject.TYPE_FLOAT);
    g.set_float(v);
    return g;
}

function createMask() {
    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
        `uniform float u_w; uniform float u_h; uniform float u_r; uniform float u_m;
         uniform float u_tint; uniform float u_rs; uniform float u_rt; uniform float u_rb; uniform float u_rw;
         uniform float u_knee; uniform float u_cap; uniform float u_vib; uniform float u_gl; uniform float u_glw;
         uniform float u_ln; uniform float u_sh; uniform float u_shy; uniform float u_shs;
         float sdPanel(vec2 p, vec2 hs, float r) {
             vec2 q = abs(p) - (hs - vec2(r));
             return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
         }`,
        `vec2 size = vec2(u_w - 2.0 * u_m, u_h - 2.0 * u_m);
         vec2 hs = size * 0.5;
         // the offscreen texture is the actor enlarged by about 2 px left/top (measured) and 3 px in size
         vec2 t = cogl_tex_coord_in[0].xy * vec2(u_w + 3.0, u_h + 3.0) - vec2(2.0);
         vec2 p = t - vec2(u_m) - hs;
         vec2 q = abs(p) - (hs - vec2(u_r));
         vec2 qp = max(q, vec2(0.0));
         float d = length(qp) + min(max(q.x, q.y), 0.0) - u_r;
         float cov = clamp(0.5 - d, 0.0, 1.0);
         vec2 n = (qp.x > 0.0 || qp.y > 0.0) ? normalize(qp) : ((q.x > q.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
         n = n * vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
         float vert = n.y * n.y;
         float edge = n.y < 0.0 ? u_rt : u_rb;
         float strength = mix(u_rs, edge, vert);
         float rim = clamp(strength * (1.0 - smoothstep(0.0, u_rw, -d)), 0.0, 1.0);
         float glow = clamp(u_gl * strength * (1.0 - smoothstep(0.0, u_glw, -d)), 0.0, 1.0);
         vec4 c = cogl_color_out;
         // legibility: luminance kept up to the knee, eased toward the cap above it (same hue, saturation given back)
         vec3 base = c.a > 0.0001 ? c.rgb / c.a : vec3(0.0);
         vec3 lin = pow(base, vec3(2.2));
         float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
         if (lum > u_knee) {
             float span = max(u_cap - u_knee, 0.00001);
             float lc = u_knee + span * (1.0 - exp((u_knee - lum) / span));
             float k = lc / lum;
             lin = max(mix(vec3(lc), lin * k, 1.0 + u_vib * (1.0 - k)), vec3(0.0));
             base = min(pow(lin, vec3(1.0 / 2.2)), vec3(1.0));
         }
         vec3 rgb = mix(base, vec3(1.0), u_tint);
         rgb = mix(rgb, vec3(1.0), clamp(rim + glow, 0.0, 1.0));
         vec4 glass = vec4(rgb, 1.0) * c.a * cov;
         // outside the shape: contact line and drop shadow, faded out before the layer's own edge
         float a = 0.0;
         if (d > -0.5) {
             float ds = sdPanel(p - vec2(0.0, u_shy), hs, u_r);
             float shadow = u_sh / (1.0 + exp(1.702 * ds / max(u_shs, 0.5)));
             float line = u_ln * (1.0 - smoothstep(0.0, 1.5, d));
             float border = min(min(t.x, t.y), min(u_w - t.x, u_h - t.y));
             a = (1.0 - (1.0 - shadow) * (1.0 - line)) * smoothstep(0.0, 8.0, border);
         }
         cogl_color_out = glass + vec4(0.0, 0.0, 0.0, a) * (1.0 - cov);`);
    return Clutter.ShaderEffect.new_with_snippet(snippet);
}

// Actor groups the desktop is made of, below every panel and menu.
export function backdropSources() {
    return [Main.layoutManager._backgroundGroup, global.window_group].filter(Boolean);
}

export class GlassLayer {
    constructor({radius = 0, blurRadius = BLUR_RADIUS, brightness = 1.0, finish = GLASS_FINISH} = {}) {
        this.actor = new Clutter.Actor({name: 'sg-glass-layer', reactive: false});
        Shell.util_set_hidden_from_pick(this.actor, true);
        this.actor.set_clip_to_allocation(true);
        this._clones = backdropSources().map(source => {
            const clone = new Clutter.Clone({source});
            this.actor.add_child(clone);
            return clone;
        });
        this._mask = createMask();
        this.setFinish(finish);
        this._blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR, radius: blurRadius, brightness,
        });
        // First added = outermost: the mask cuts the blurred result.
        this.actor.add_effect_with_name('sg-glass-mask', this._mask);
        this.actor.add_effect_with_name('sg-glass-blur', this._blur);
        this._radius = radius;
        this._size = [-1, -1];
        this._appliedR = -1;
        this._clonePos = [NaN, NaN];
    }

    // the finish uniforms; missing keys keep the default finish (the rig tries variants through this)
    setFinish(finish) {
        this._finish = {...GLASS_FINISH, ...finish};
        for (const [key, name] of Object.entries(FINISH_UNIFORMS))
            this._mask.set_uniform_value(name, float(uniformValue(key, this._finish[key])));
        this.actor.queue_redraw();
    }

    get finish() {
        return this._finish;
    }

    get radius() {
        return this._radius;
    }

    set radius(r) {
        if (r === this._radius)
            return;
        this._radius = r;
        this._size = [-1, -1]; // force uniform update
    }

    /* shapeW/H: the panel size; stageX/Y: the stage position of the layer's top-left corner
     * (panel position minus MARGIN), from which the clones are offset. */
    sync(shapeW, shapeH, stageX, stageY) {
        const lw = shapeW + 2 * MARGIN;
        const lh = shapeH + 2 * MARGIN;
        const r = Math.min(this._radius, shapeW / 2, shapeH / 2);
        if (this._size[0] !== lw || this._size[1] !== lh || this._appliedR !== r) {
            this._mask.set_uniform_value('u_w', float(lw));
            this._mask.set_uniform_value('u_h', float(lh));
            this._mask.set_uniform_value('u_r', float(r));
            this._mask.set_uniform_value('u_m', float(MARGIN));
            this._size = [lw, lh];
            this._appliedR = r;
            this.actor.queue_redraw();
        }
        // unallocated / unmapped ancestors report NaN: keep the last good offsets
        if (!Number.isFinite(stageX) || !Number.isFinite(stageY))
            return;
        if (this._clonePos[0] !== stageX || this._clonePos[1] !== stageY) {
            for (const clone of this._clones) {
                const src = clone.get_source();
                const [sx, sy] = src ? src.get_transformed_position() : [0, 0];
                if (Number.isFinite(sx) && Number.isFinite(sy))
                    clone.set_translation(sx - stageX, sy - stageY, 0);
            }
            this._clonePos = [stageX, stageY];
        }
    }

    destroy() {
        this._clones = [];
        try {
            this.actor.clear_effects();
            this.actor.destroy();
        } catch {
            // already destroyed with its parent (shell shutdown)
        }
    }
}

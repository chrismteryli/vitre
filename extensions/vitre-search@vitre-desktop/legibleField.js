/* The glass field of VitreSearch, legible over any backdrop (2026-10-16).
 *
 * Same field and same API as glassField.js (bar + panel + 4 buttons as one signed-distance field, smooth union
 * of rounded boxes, blurred desktop clones cut and finished by one shader that runs outermost). glassField.js
 * stays byte-identical to its copies in vitre-menus, vitre-controls, vitre-notices and vitre-hud. This file
 * differs from it in the finish, and in the early-out for the edge direction that dripField.js also has:
 *
 *   - legibility: over a white window the clear glass was white too, and so was the text on it. The blurred
 *     backdrop's luminance is now kept as it is up to a knee and eased toward a cap above it, per pixel and
 *     every frame. Dark backdrops (a dark window, the dark parts of the wallpaper) look as before; a white
 *     window or a bright streak of the wallpaper behind the bar reads as smoked glass under white text. The cap
 *     is in linear light, so every hue is held to it. Dimmed colour gets some saturation back so it stays
 *     colour. No readback and no extra pass: a few instructions in the shader that already runs.
 *   - edge: a soft light under the rim (weighted like the rim, top brightest), and outside the shape a dark
 *     contact line and a drop shadow, an analytic profile of the same field drawn inside the field's margin.
 *   - cost: the four extra field evaluations for the edge direction run only near the edge (as in
 *     dripField.js) and the shadow's one only in a band outside the shape, so an open panel evaluates the
 *     field about 1.4 times per pixel instead of 5.
 *
 * Shapes are rounded boxes {x, y, w, h, r} (centre and half sizes in field px). Up to N_SHAPES are unioned with
 * a polynomial smooth minimum of softness k (px). A shape with hw = hh = 0 and r = 0 is a point that only
 * matters when it is within k of another shape's surface.
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {MARGIN, BLUR_RADIUS, GLASS_FINISH, backdropSources} from './glass.js';

export const N_SHAPES = 5;
export {MARGIN, BLUR_RADIUS};

// The clear finish (glass.js, measured) plus the legibility terms, tuned in the rig over a white window, a dark
// window and the wallpaper:
//   knee, cap   grey levels: backdrop luminance kept up to knee, eased toward cap above it (over a white window
//               the rig measured 9.1:1 for white text and 4.8:1 or more for the small grey text)
//   vibrance    saturation given back to a dimmed backdrop
//   glow, glowWidth   soft light under the rim (px)
//   line        dark contact line just outside the edge (invisible on dark, crisp on white)
//   shadow, shadowY, shadowSoft   drop shadow opacity, downward offset and softness (px, Gaussian sigma)
export const LEGIBLE_FINISH = {
    ...GLASS_FINISH,
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

function declarations() {
    let u = `uniform float u_w; uniform float u_h; uniform float u_m; uniform float u_k;
         uniform float u_tint; uniform float u_rs; uniform float u_rt; uniform float u_rb; uniform float u_rw;
         uniform float u_knee; uniform float u_cap; uniform float u_vib; uniform float u_gl; uniform float u_glw;
         uniform float u_ln; uniform float u_sh; uniform float u_shy; uniform float u_shs;
         uniform float u_dbg;\n`;
    for (let i = 0; i < N_SHAPES; i++)
        u += `uniform float u_s${i}x; uniform float u_s${i}y; uniform float u_s${i}w; uniform float u_s${i}h; uniform float u_s${i}r;\n`;
    u += `
        float sdBox(vec2 p, vec2 c, vec2 hs, float r) {
            vec2 q = abs(p - c) - (hs - vec2(r));
            return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
        }
        float smin2(float a, float b, float k) {
            float h = max(k - abs(a - b), 0.0) / k;
            return min(a, b) - h * h * k * 0.25;
        }
        float field(vec2 p) {
            float k = max(u_k, 0.001);\n`;
    u += `            float d = sdBox(p, vec2(u_s0x, u_s0y), vec2(u_s0w, u_s0h), u_s0r);\n`;
    for (let i = 1; i < N_SHAPES; i++)
        u += `            d = smin2(d, sdBox(p, vec2(u_s${i}x, u_s${i}y), vec2(u_s${i}w, u_s${i}h), u_s${i}r), k);\n`;
    u += `            return d;
        }`;
    return u;
}

/* The fragment finish. The offscreen texture the effect receives is the actor enlarged by about 2 px left/top
 * and 3 px in size (measured for glass.js, see its createMask); the same mapping is used. d is the field value
 * in px; coverage is an anti-aliased step; rim and glow use the edge direction from the field gradient. */
function createMask() {
    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations(),
        `vec2 p = cogl_tex_coord_in[0].xy * vec2(u_w + 3.0, u_h + 3.0) - vec2(2.0);
         float d = field(p);
         float cov = clamp(0.5 - d, 0.0, 1.0);
         float rim = 0.0;
         float glow = 0.0;
         if (d < 1.0 && d > -(max(u_rw, u_glw) + 1.0)) {
             float e = 1.0;
             vec2 g = vec2(field(p + vec2(e, 0.0)) - field(p - vec2(e, 0.0)),
                           field(p + vec2(0.0, e)) - field(p - vec2(0.0, e)));
             vec2 n = length(g) > 0.0001 ? normalize(g) : vec2(0.0, 1.0);
             float vert = n.y * n.y;
             float edge = n.y < 0.0 ? u_rt : u_rb;
             float strength = mix(u_rs, edge, vert);
             rim = clamp(strength * (1.0 - smoothstep(0.0, u_rw, -d)), 0.0, 1.0);
             glow = clamp(u_gl * strength * (1.0 - smoothstep(0.0, u_glw, -d)), 0.0, 1.0);
         }
         vec4 c = cogl_color_out;
         // legibility: luminance kept up to the knee, eased toward the cap above it (same hue, saturation given back)
         vec3 base = c.a > 0.0001 ? c.rgb / c.a : vec3(0.0);
         vec3 lin = pow(base, vec3(2.2));
         float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
         if (lum > u_knee) {
             float span = max(u_cap - u_knee, 0.00001);
             float lc = u_knee + span * (1.0 - exp((u_knee - lum) / span));
             float kk = lc / lum;
             lin = max(mix(vec3(lc), lin * kk, 1.0 + u_vib * (1.0 - kk)), vec3(0.0));
             base = min(pow(lin, vec3(1.0 / 2.2)), vec3(1.0));
         }
         vec3 rgb = mix(base, vec3(1.0), u_tint);
         rgb = mix(rgb, vec3(1.0), clamp(rim + glow, 0.0, 1.0));
         vec4 glass = vec4(rgb, 1.0) * c.a * cov;
         // outside the shape: contact line and drop shadow, faded out before the field's own edge
         float a = 0.0;
         if (d > -0.5 && d < u_shy + 5.0 * u_shs) {
             float ds = field(p - vec2(0.0, u_shy));
             float shadow = u_sh / (1.0 + exp(1.702 * ds / max(u_shs, 0.5)));
             float line = u_ln * (1.0 - smoothstep(0.0, 1.5, d));
             float border = min(min(p.x, p.y), min(u_w - p.x, u_h - p.y));
             a = (1.0 - (1.0 - shadow) * (1.0 - line)) * smoothstep(0.0, 8.0, border);
         }
         vec4 outc = glass + vec4(0.0, 0.0, 0.0, a) * (1.0 - cov);
         // u_dbg > 0: paint the bare coverage (white on transparent) for the rig's silhouette measurements
         cogl_color_out = u_dbg > 0.5 ? vec4(cov, cov, cov, cov) * c.a : outc;`);
    return Clutter.ShaderEffect.new_with_snippet(snippet);
}

export class LegibleField {
    /* The field is a child of its parent at (0, 0) of its own coordinates; the caller positions `actor`, sizes it
     * (setFieldSize) and calls sync(stageX, stageY) when the field's stage origin moves. */
    constructor({finish = LEGIBLE_FINISH, blurRadius = BLUR_RADIUS} = {}) {
        this.actor = new Clutter.Actor({name: 'vitresearch-glass-field', reactive: false});
        Shell.util_set_hidden_from_pick(this.actor, true);
        this.actor.set_clip_to_allocation(true);
        this._clones = backdropSources().map(source => {
            const clone = new Clutter.Clone({source});
            this.actor.add_child(clone);
            return clone;
        });
        this._values = new Map();
        this._last = new Map();
        this._mask = createMask();
        this.setFinish(finish);
        this._set('u_m', MARGIN);
        this._set('u_k', 3);
        this._set('u_dbg', 0);
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: blurRadius, brightness: 1.0});
        this.actor.add_effect_with_name('sp-glass-mask', this._mask);
        this.actor.add_effect_with_name('sp-glass-blur', this._blur);
        this._clonePos = [NaN, NaN];
        this._size = [-1, -1];
    }

    _set(name, v) {
        if (this._last.get(name) === v)
            return;
        let value = this._values.get(name);
        if (!value) {
            value = new GObject.Value();
            value.init(GObject.TYPE_FLOAT);
            this._values.set(name, value);
        }
        value.set_float(v);
        this._mask.set_uniform_value(name, value);
        this._last.set(name, v);
    }

    // the finish uniforms; missing keys keep the default finish (the rig tries variants through this)
    setFinish(finish) {
        this._finish = {...LEGIBLE_FINISH, ...finish};
        for (const [key, name] of Object.entries(FINISH_UNIFORMS))
            this._set(name, uniformValue(key, this._finish[key]));
        this.actor.queue_redraw();
    }

    get finish() {
        return this._finish;
    }

    // Debug: bare white coverage instead of the glass look (rig silhouette measurements only).
    setDebugCoverage(on) {
        this._set('u_dbg', on ? 1 : 0);
        this.actor.queue_redraw();
    }

    setBlurRadius(r) {
        this._blur.radius = r;
    }

    get blurRadius() {
        return this._blur.radius;
    }

    setTint(v) {
        this._set('u_tint', v);
    }

    /* shapes: array of {x, y, w, h, r} in field px (centre, half sizes, corner radius); k: softness. */
    setShapes(shapes, k) {
        for (let i = 0; i < N_SHAPES; i++) {
            const s = shapes[i] ?? {x: -10000, y: -10000, w: 0, h: 0, r: 0};
            this._set(`u_s${i}x`, s.x);
            this._set(`u_s${i}y`, s.y);
            this._set(`u_s${i}w`, s.w);
            this._set(`u_s${i}h`, s.h);
            this._set(`u_s${i}r`, s.r);
        }
        this._set('u_k', Math.max(0.01, k));
        this.actor.queue_redraw();
    }

    /* Size of the field in logical px (the actor's own size is set by the caller). */
    setFieldSize(w, h) {
        if (this._size[0] === w && this._size[1] === h)
            return;
        this._size = [w, h];
        this._set('u_w', w);
        this._set('u_h', h);
    }

    /* Keep the cloned desktop aligned: the field's top-left is at stage (stageX, stageY). */
    sync(stageX, stageY) {
        if (!Number.isFinite(stageX) || !Number.isFinite(stageY))
            return;
        if (this._clonePos[0] === stageX && this._clonePos[1] === stageY)
            return;
        for (const clone of this._clones) {
            const src = clone.get_source();
            const [sx, sy] = src ? src.get_transformed_position() : [0, 0];
            if (Number.isFinite(sx) && Number.isFinite(sy))
                clone.set_translation(sx - stageX, sy - stageY, 0);
        }
        this._clonePos = [stageX, stageY];
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

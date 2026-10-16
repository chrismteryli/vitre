/* One piece of "clear glass" that can be several shapes at once: the VitreSearch bar / results panel
 * plus the four filter buttons are rendered as ONE signed-distance field (smooth union of rounded
 * boxes), so the buttons can grow out of the bar, stretch a neck and pinch off without ever being
 * separate actors (plan A11 section 2). Same recipe as glass.js (A9): the layer holds Clutter.Clone
 * copies of the wallpaper and window groups, blurred in ACTOR mode and cut/finished by a shader that
 * runs outermost. glass.js is copied unchanged from the Control Center extension; its constants
 * (margin, blur radius, glass finish) and backdrop helper are reused here.
 *
 * Shapes are rounded boxes {x, y, hw, hh, r} (centre and half sizes in field px). Up to N_SHAPES are
 * unioned with a polynomial smooth minimum of softness k (px). A shape with hw = hh = 0 and r = 0 is a
 * point that only matters when it is within k of another shape's surface.
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {MARGIN, BLUR_RADIUS, GLASS_FINISH, backdropSources} from './glass.js';

export const N_SHAPES = 5;
export {MARGIN, BLUR_RADIUS};

const SHAPE_UNIFORMS = ['x', 'y', 'w', 'h', 'r'];

function declarations() {
    let u = `uniform float u_w; uniform float u_h; uniform float u_m; uniform float u_k;
         uniform float u_tint; uniform float u_rs; uniform float u_rt; uniform float u_rb; uniform float u_rw;
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

/* The fragment finish. The offscreen texture the effect receives is the actor enlarged by about
 * 2 px left/top and 3 px in size (measured for glass.js, see its createMask); the same mapping is used.
 * d is the field value in px; coverage is an anti-aliased step; the rim is the edge-direction
 * gradient of glass.js (top brightest, sides faintest), the direction taken from the field gradient. */
function createMask() {
    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations(),
        `vec2 p = cogl_tex_coord_in[0].xy * vec2(u_w + 3.0, u_h + 3.0) - vec2(2.0);
         float d = field(p);
         float cov = clamp(0.5 - d, 0.0, 1.0);
         float e = 1.0;
         vec2 g = vec2(field(p + vec2(e, 0.0)) - field(p - vec2(e, 0.0)),
                       field(p + vec2(0.0, e)) - field(p - vec2(0.0, e)));
         vec2 n = length(g) > 0.0001 ? normalize(g) : vec2(0.0, 1.0);
         float vert = n.y * n.y;
         float edge = n.y < 0.0 ? u_rt : u_rb;
         float strength = mix(u_rs, edge, vert);
         float rim = clamp(strength * (1.0 - smoothstep(0.0, u_rw, -d)), 0.0, 1.0);
         vec4 c = cogl_color_out;
         vec3 rgb = mix(c.rgb, vec3(c.a), u_tint);
         rgb = mix(rgb, vec3(c.a), rim);
         vec4 outc = vec4(rgb, c.a) * cov;
         // u_dbg > 0: paint the bare coverage (white on transparent) for the rig's silhouette measurements
         cogl_color_out = u_dbg > 0.5 ? vec4(cov, cov, cov, cov) * c.a : outc;`);
    return Clutter.ShaderEffect.new_with_snippet(snippet);
}

export class GlassField {
    /* `sizeW` x `sizeH` is the maximum field (shapes live inside it, at least MARGIN from its edges).
     * The field is a child of its parent at (0, 0) of its own coordinates; the caller positions
     * `actor` and calls sync(stageX, stageY) when the field's stage origin moves. */
    constructor({finish = GLASS_FINISH, blurRadius = BLUR_RADIUS} = {}) {
        this.actor = new Clutter.Actor({name: 'vitresearch-glass-field', reactive: false});
        Shell.util_set_hidden_from_pick(this.actor, true);
        this.actor.set_clip_to_allocation(true);
        this._clones = backdropSources().map(source => {
            const clone = new Clutter.Clone({source});
            this.actor.add_child(clone);
            return clone;
        });
        this._values = new Map();
        this._mask = createMask();
        this._finish = finish;
        this._set('u_tint', finish.tint);
        this._set('u_rs', finish.rimSide);
        this._set('u_rt', finish.rimTop);
        this._set('u_rb', finish.rimBottom);
        this._set('u_rw', finish.rimWidth);
        this._set('u_m', MARGIN);
        this._set('u_k', 3);
        this._set('u_dbg', 0);
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: blurRadius, brightness: 1.0});
        this.actor.add_effect_with_name('sp-glass-mask', this._mask);
        this.actor.add_effect_with_name('sp-glass-blur', this._blur);
        this._clonePos = [NaN, NaN];
        this._size = [-1, -1];
        this._shapes = null;
        this._last = new Map();
    }

    _set(name, v) {
        if (this._last?.get(name) === v)
            return;
        let value = this._values.get(name);
        if (!value) {
            value = new GObject.Value();
            value.init(GObject.TYPE_FLOAT);
            this._values.set(name, value);
        }
        value.set_float(v);
        this._mask.set_uniform_value(name, value);
        this._last?.set(name, v);
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

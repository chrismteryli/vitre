/* The same "clear glass" field as glassField.js (A11: one signed-distance field, smooth union of rounded boxes,
 * blurred desktop clones cut and finished by one shader that runs outermost), with the number of shapes
 * chosen at construction instead of the fixed 5 of glassField.js. glassField.js is shipped byte-identical to
 * the VitreSearch extension's copy and is used for the surfaces that need at most 5 shapes (menus, the volume
 * capsule); this class serves Control Center and Notification Center, whose drip has the source pill, the
 * thread and one shape per module / card (plan A17 section 2). The finish and the glass recipe are identical;
 * two things differ and nothing else: the shape count, and an early-out in the fragment code that skips the
 * four extra field evaluations for the rim gradient where there is no rim (outside the shape and deeper
 * than the rim inside it), which is what makes 20 shapes affordable.
 *
 * Shapes are rounded boxes {x, y, w, h, r} (centre and half sizes in field px). A shape with w = h = r = 0 is a
 * point that only matters within the softness k of another shape's surface.
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MARGIN, BLUR_RADIUS, GLASS_FINISH, backdropSources} from './glass.js';

export {MARGIN, BLUR_RADIUS};

export function fieldDeclarations(n, extra = '') {
    let u = `uniform float u_k;\n${extra}`;
    for (let i = 0; i < n; i++)
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
    for (let i = 1; i < n; i++)
        u += `            d = smin2(d, sdBox(p, vec2(u_s${i}x, u_s${i}y), vec2(u_s${i}w, u_s${i}h), u_s${i}r), k);\n`;
    u += `            return d;
        }`;
    return u;
}

function createMask(n) {
    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
        fieldDeclarations(n, `uniform float u_w; uniform float u_h; uniform float u_m;
         uniform float u_tint; uniform float u_rs; uniform float u_rt; uniform float u_rb; uniform float u_rw;
         uniform float u_dbg; uniform float u_tcr; uniform float u_tcg; uniform float u_tcb; uniform float u_sat;\n`),
        `vec2 p = cogl_tex_coord_in[0].xy * vec2(u_w + 3.0, u_h + 3.0) - vec2(2.0);
         float d = field(p);
         float cov = clamp(0.5 - d, 0.0, 1.0);
         float rim = 0.0;
         if (d < 1.0 && d > -(u_rw + 1.0)) {
             float e = 1.0;
             vec2 g = vec2(field(p + vec2(e, 0.0)) - field(p - vec2(e, 0.0)),
                           field(p + vec2(0.0, e)) - field(p - vec2(0.0, e)));
             vec2 n = length(g) > 0.0001 ? normalize(g) : vec2(0.0, 1.0);
             float vert = n.y * n.y;
             float edge = n.y < 0.0 ? u_rt : u_rb;
             float strength = mix(u_rs, edge, vert);
             rim = clamp(strength * (1.0 - smoothstep(0.0, u_rw, -d)), 0.0, 1.0);
         }
         vec4 c = cogl_color_out;
         vec3 base = c.rgb;
         if (u_sat != 1.0) {
             float lum = dot(base, vec3(0.299, 0.587, 0.114));
             base = max(vec3(0.0), mix(vec3(lum), base, u_sat));
         }
         vec3 rgb = mix(base, vec3(u_tcr, u_tcg, u_tcb) * c.a, u_tint);
         rgb = mix(rgb, vec3(c.a), rim);
         vec4 outc = vec4(rgb, c.a) * cov;
         cogl_color_out = u_dbg > 0.5 ? vec4(cov, cov, cov, cov) * c.a : outc;`);
    return Clutter.ShaderEffect.new_with_snippet(snippet);
}

export class DripField {
    constructor({shapes = 12, finish = GLASS_FINISH, blurRadius = BLUR_RADIUS, name = 'drip-glass-field'} = {}) {
        this.nShapes = shapes;
        this.actor = new Clutter.Actor({name, reactive: false});
        Shell.util_set_hidden_from_pick(this.actor, true);
        this.actor.set_clip_to_allocation(true);
        this._clones = backdropSources().map(source => {
            const clone = new Clutter.Clone({source});
            this.actor.add_child(clone);
            return clone;
        });
        this._values = new Map();
        this._last = new Map();
        this._mask = createMask(shapes);
        this._finish = finish;
        this._set('u_tint', finish.tint);
        this._set('u_rs', finish.rimSide);
        this._set('u_rt', finish.rimTop);
        this._set('u_rb', finish.rimBottom);
        this._set('u_rw', finish.rimWidth);
        this._set('u_m', MARGIN);
        this._set('u_k', 3);
        this._set('u_dbg', 0);
        // the tint colour (white by default: the clear glass) and the saturation of the blurred backdrop (1 = as is)
        const tc = finish.tintColor ?? [1, 1, 1];
        this._set('u_tcr', tc[0]);
        this._set('u_tcg', tc[1]);
        this._set('u_tcb', tc[2]);
        this._set('u_sat', finish.saturation ?? 1);
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: blurRadius, brightness: 1.0});
        this.actor.add_effect_with_name('drip-glass-mask', this._mask);
        this.actor.add_effect_with_name('drip-glass-blur', this._blur);
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
        for (let i = 0; i < this.nShapes; i++) {
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

    setFieldSize(w, h) {
        if (this._size[0] === w && this._size[1] === h)
            return;
        this._size = [w, h];
        this._set('u_w', w);
        this._set('u_h', h);
    }

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

/* The content of a pop-out may only be seen where its glass is. This effect goes on the container that holds
 * the content (outermost) while a drip runs and multiplies it by the coverage of the same signed-distance field
 * as the glass, so the content is revealed exactly by the liquid shape: a text, a disc or a slider is cut by the
 * glass edge itself, never by a rectangle. Shapes are in stage px; the offscreen texture is mapped to the
 * actor's paint box (stage px) each frame, which makes the mapping exact whatever the actor's size or margins. */
// The content mask is the field's shape grown by this many (logical) px. The surface's own glass draws its rim in the outermost pixel
// row of its edge: cut exactly at the field's edge, that rim lost about half its light (a stack's peeking card lost it all) until the
// mask was removed at the end, one visible step. Content never lies within a pixel of the glass edge, so growing the mask costs nothing.
const MASK_GROW = '1.0';
const TEX_PAD_BEFORE = 2;
const TEX_PAD_AFTER = 1;

export class ContentMask {
    constructor(n) {
        this.nShapes = n;
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
            fieldDeclarations(n, 'uniform float u_bx; uniform float u_by; uniform float u_bw; uniform float u_bh;\n'),
            `vec2 p = vec2(u_bx, u_by) + cogl_tex_coord_in[0].xy * vec2(u_bw, u_bh);
             float d = field(p);
             cogl_color_out = cogl_color_out * clamp(${MASK_GROW} + 0.5 - d, 0.0, 1.0);`);
        this.effect = Clutter.ShaderEffect.new_with_snippet(snippet);
        this._values = new Map();
        this._last = new Map();
        this._set('u_k', 3);
        this._actor = null;
        this._clipWas = null;
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
        this.effect.set_uniform_value(name, value);
        this._last.set(name, v);
    }

    attach(actor) {
        this.detach();
        this._actor = actor;
        this._dead = false;
        this._deadId = actor.connect('destroy', () => {
            this._dead = true;
            this._actor = null;
        });
        this._clipWas = actor.clip_to_allocation;
        actor.set_clip_to_allocation(true);
        actor.add_effect_with_name('drip-content-mask', this.effect);
    }

    detach() {
        const actor = this._actor;
        this._actor = null;
        if (!actor || this._dead)
            return;
        try {
            if (this._deadId)
                actor.disconnect(this._deadId);
            this._deadId = 0;
            actor.remove_effect(this.effect);
            actor.set_clip_to_allocation(Boolean(this._clipWas));
        } catch (_e) {
            // the actor is already gone
        }
    }

    // shapes: stage px {x, y, w, h, r} (centre, half sizes); k: softness; fallback: the actor's rectangle in stage px {x, y, w, h}
    // (only for a surface that knows it: used while the actor has no paint volume)
    update(shapes, k, fallback = null) {
        const actor = this._actor;
        if (!actor)
            return;
        let [ok, box] = actor.get_paint_box();
        if (!ok && !fallback) {
            // no surface-supplied rectangle: the actor's own allocation (always there) is the same box
            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_transformed_size();
            if ([ax, ay, aw, ah].every(Number.isFinite) && aw > 0 && ah > 0)
                fallback = {x: ax, y: ay, w: aw, h: ah};
        }
        if (!ok && fallback) {
            // No paint volume while a relayout of the actor is pending (a slider that is easing its width, an icon that was
            // swapped): without a box the uniforms stay unset and the mask covers nothing, so the content of the very first
            // frame of a drip (the HUD's exit) was blank. The content is clipped to the allocation (attach), which is the
            // paint box once the layout is done: the surface's own rectangle is that box.
            box = {x1: fallback.x, y1: fallback.y, x2: fallback.x + fallback.w, y2: fallback.y + fallback.h};
            ok = true;
        }
        if (ok) {
            // The offscreen texture is not the paint box: it is the box grown by TEX_PAD_BEFORE px above / left and TEX_PAD_AFTER px
            // below / right (a 381 x 846 box gave a 768 x 1698 texture = 2 x (381 + 3) x 2 x (846 + 3), measured in the rig; the glass
            // mask in createMask uses the same u_w + 3 and - 2). Mapping the texture to the bare box (or its device-pixel rounding)
            // moved the whole mask up by 1.4 px at the top of a tall surface, falling to 0 at its bottom: a card's bottom rim was cut.
            this._set('u_bx', box.x1 - TEX_PAD_BEFORE);
            this._set('u_by', box.y1 - TEX_PAD_BEFORE);
            this._set('u_bw', box.x2 - box.x1 + TEX_PAD_BEFORE + TEX_PAD_AFTER);
            this._set('u_bh', box.y2 - box.y1 + TEX_PAD_BEFORE + TEX_PAD_AFTER);
        }
        for (let i = 0; i < this.nShapes; i++) {
            const s = shapes[i] ?? {x: -10000, y: -10000, w: 0, h: 0, r: 0};
            this._set(`u_s${i}x`, s.x);
            this._set(`u_s${i}y`, s.y);
            this._set(`u_s${i}w`, s.w);
            this._set(`u_s${i}h`, s.h);
            this._set(`u_s${i}r`, s.r);
        }
        this._set('u_k', Math.max(0.01, k));
        actor.queue_redraw();
    }
}

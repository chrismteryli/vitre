/* "Clear glass" for the switcher panel: the A9 recipe (vitre-controls@vitre-desktop glass.js), own copy.
 * A layer of Clutter.Clone copies of the wallpaper and window groups, blurred in ACTOR mode, cut to a rounded
 * rectangle by a shader that also adds the light tint and the specular rim. The layer is larger than the
 * panel by MARGIN on every side so the blur never samples past its own edge. It works inside offscreens and
 * under parent opacity, and reads no stage framebuffer.
 * Why not Shell.BlurEffect in BACKGROUND mode: no corner radius, cannot be masked (A9 probe 2026-10-10).
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const MARGIN = 40;
export const BLUR_RADIUS = 16;

// Same finish as A9's clear glass (measured against the the reference design guide images).
export const GLASS_FINISH = {tint: 0.10, rimSide: 0.16, rimTop: 0.80, rimBottom: 0.70, rimWidth: 1.9};

function float(v) {
    const g = new GObject.Value();
    g.init(GObject.TYPE_FLOAT);
    g.set_float(v);
    return g;
}

function createMask() {
    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
        `uniform float u_w; uniform float u_h; uniform float u_r; uniform float u_m;
         uniform float u_tint; uniform float u_rs; uniform float u_rt; uniform float u_rb; uniform float u_rw;`,
        `vec2 size = vec2(u_w - 2.0 * u_m, u_h - 2.0 * u_m);
         vec2 hs = size * 0.5;
         // the offscreen texture is the actor enlarged by about 2 px left/top (measured) and 3 px in size
         vec2 p = cogl_tex_coord_in[0].xy * vec2(u_w + 3.0, u_h + 3.0) - vec2(2.0) - vec2(u_m) - hs;
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
         vec4 c = cogl_color_out;
         vec3 rgb = mix(c.rgb, vec3(c.a), u_tint);
         rgb = mix(rgb, vec3(c.a), rim);
         cogl_color_out = vec4(rgb, c.a) * cov;`);
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
        this._mask.set_uniform_value('u_tint', float(finish.tint));
        this._mask.set_uniform_value('u_rs', float(finish.rimSide));
        this._mask.set_uniform_value('u_rt', float(finish.rimTop));
        this._mask.set_uniform_value('u_rb', float(finish.rimBottom));
        this._mask.set_uniform_value('u_rw', float(finish.rimWidth));
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

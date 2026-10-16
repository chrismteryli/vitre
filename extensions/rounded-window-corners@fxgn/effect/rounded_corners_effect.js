/** @file Binds the actual corner rounding shader to the windows. */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import { readShader } from '../utils/file.js';
import { getPref } from '../utils/settings.js';
const [declarations, code] = await readShader(import.meta.url, 'shader/rounded_corners.frag');
export const RoundedCornersEffect = GObject.registerClass({}, class Effect extends Clutter.ShaderEffect {
    // No constructor/uniform-location cache: Clutter.ShaderEffect has no
    // get_uniform_location(); uniforms are addressed by name.
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, code);
    }
    updateUniforms(config, windowBounds) {
        const borderWidth = getPref('border-width');
        const borderColor = config.borderColor;
        const outerRadius = config.borderRadius;
        const { padding, smoothing } = config;
        const bounds = [
            windowBounds.x1 + padding.left,
            windowBounds.y1 + padding.top,
            windowBounds.x2 - padding.right,
            windowBounds.y2 - padding.bottom,
        ];
        const borderedAreaBounds = [
            bounds[0] + borderWidth,
            bounds[1] + borderWidth,
            bounds[2] - borderWidth,
            bounds[3] - borderWidth,
        ];
        let borderedAreaRadius = outerRadius - borderWidth;
        if (borderedAreaRadius < 0.001) {
            borderedAreaRadius = 0.0;
        }
        const pixelStep = [
            1 / this.actor.get_width(),
            1 / this.actor.get_height(),
        ];
        // This is needed for squircle corners
        let exponent = smoothing * 10 + 2;
        let radius = outerRadius * 0.5 * exponent;
        const maxRadius = Math.min(bounds[3] - bounds[0], bounds[4] - bounds[1]);
        if (radius > maxRadius) {
            exponent *= maxRadius / radius;
            radius = maxRadius;
        }
        borderedAreaRadius *= radius / outerRadius;
        this.#setUniforms(bounds, radius, borderWidth, borderColor, borderedAreaBounds, borderedAreaRadius, pixelStep, exponent);
    }
    #setUniforms(bounds, radius, borderWidth, borderColor, borderedAreaBounds, borderedAreaRadius, pixelStep, exponent) {
        // Names must match the `uniform` declarations in shader/rounded_corners.frag
        this.set_uniform_float('bounds', 4, bounds);
        this.set_uniform_float('clipRadius', 1, [radius]);
        this.set_uniform_float('borderWidth', 1, [borderWidth]);
        this.set_uniform_float('borderColor', 4, borderColor);
        this.set_uniform_float('borderedAreaBounds', 4, borderedAreaBounds);
        this.set_uniform_float('borderedAreaClipRadius', 1, [borderedAreaRadius]);
        this.set_uniform_float('pixelStep', 2, pixelStep);
        this.set_uniform_float('exponent', 1, [exponent]);
        this.queue_repaint();
    }
});

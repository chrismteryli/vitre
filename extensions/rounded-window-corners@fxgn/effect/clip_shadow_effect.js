/**
 * @file Clips shadows for windows.
 *
 * Needed because of this issue:
 * https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4474
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import { readShader } from '../utils/file.js';
const [declarations, code] = await readShader(import.meta.url, 'shader/clip_shadow.frag');
export const ClipShadowEffect = GObject.registerClass({}, class extends Clutter.ShaderEffect {
    // GNOME 51: Shell.GLSLEffect is gone. The snippet is the 3rd arg of
    // Cogl.Snippet.new, which is the POST section (same as GNOME's own
    // RecolorEffect in ui/screenshot.js). Equivalent to the old
    // add_glsl_snippet(hook, decl, code, /*replace*/ false).
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, code);
    }
});

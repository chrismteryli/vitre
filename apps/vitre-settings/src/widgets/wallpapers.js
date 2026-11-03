// The wallpaper chooser: one tile per light and dark pair, the light picture on the left half and the dark one on the
// right, as GNOME's own background panel shows pairs. Thumbnails load asynchronously and are cached, so the full-size
// pictures (about 7 MB each) are decoded once.
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

const THUMB_W = 152;
const THUMB_H = 95;
const RADIUS = 10;

function cachePath(path) {
    const info = Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
    const stamp = info.get_attribute_uint64('time::modified');
    const name = `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, `${path}:${stamp}`, -1)}.png`;
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'vitre-settings', 'thumbnails', name]);
}

// Resolves with a GdkPixbuf at twice the tile size (sharp at 1.5x and 2x scale).
function loadThumb(path) {
    return new Promise(resolve => {
        let cached = null;
        try {
            cached = cachePath(path);
            if (GLib.file_test(cached, GLib.FileTest.EXISTS)) {
                resolve(GdkPixbuf.Pixbuf.new_from_file(cached));
                return;
            }
        } catch {
            cached = null;
        }
        const file = Gio.File.new_for_path(path);
        file.read_async(GLib.PRIORITY_LOW, null, (f, res) => {
            let stream;
            try {
                stream = f.read_finish(res);
            } catch {
                resolve(null);
                return;
            }
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, THUMB_W * 2, -1, true, null, (_s, r) => {
                let pixbuf = null;
                try {
                    pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(r);
                    if (cached) {
                        GLib.mkdir_with_parents(GLib.path_get_dirname(cached), 0o755);
                        pixbuf.savev(cached, 'png', [], []);
                    }
                } catch {
                    // unreadable picture: the tile stays a plain placeholder
                }
                stream.close(null);
                resolve(pixbuf);
            });
        });
    });
}

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function paintCover(cr, pixbuf, x, y, w, h) {
    // fill w x h with the picture, cropped to keep its aspect (like the desktop's zoom option)
    const s = Math.max(w / pixbuf.width, h / pixbuf.height);
    cr.save();
    cr.rectangle(x, y, w, h);
    cr.clip();
    cr.translate(x + (w - pixbuf.width * s) / 2, y + (h - pixbuf.height * s) / 2);
    cr.scale(s, s);
    Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
    cr.paint();
    cr.restore();
}

export class WallpaperTile {
    constructor(pair) {
        this.pair = pair;
        this._light = null;
        this._dark = null;
        this.area = new Gtk.DrawingArea({content_width: THUMB_W, content_height: THUMB_H});
        this.area.set_draw_func((_a, cr, w, h) => {
            this._draw(cr, w, h);
            cr.$dispose();
        });
        const frame = new Gtk.Box({css_classes: ['vitre-wallpaper-frame'], halign: Gtk.Align.CENTER});
        frame.append(this.area);
        const label = new Gtk.Label({label: pair.name, css_classes: ['caption']});
        this.widget = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, css_classes: ['vitre-wallpaper']});
        this.widget.append(frame);
        this.widget.append(label);
        this.widget.update_property([Gtk.AccessibleProperty.LABEL], [`${pair.name} wallpaper`]);
        this.ready = Promise.all([loadThumb(pair.light), loadThumb(pair.dark)]).then(([l, d]) => {
            this._light = l;
            this._dark = d;
            this.area.queue_draw();
        });
    }

    _draw(cr, w, h) {
        roundedRect(cr, 0, 0, w, h, RADIUS);
        cr.clip();
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.2);
        cr.paint();
        if (this._light)
            paintCover(cr, this._light, 0, 0, w, h);
        if (this._dark) {
            // the dark picture on the right half, split on a slight diagonal
            cr.save();
            cr.moveTo(w * 0.5 + h * 0.12, 0);
            cr.lineTo(w, 0);
            cr.lineTo(w, h);
            cr.lineTo(w * 0.5 - h * 0.12, h);
            cr.closePath();
            cr.clip();
            paintCover(cr, this._dark, 0, 0, w, h);
            cr.restore();
        }
    }
}

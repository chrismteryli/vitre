/*
* Dhruva GNOME Extension
* Copyright (C) 2026 NarkAgni
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Vitre (B5): what the fan, the grid and the stack icon share: a file's picture, opening a file or the folder, and dragging
// a file out of a stack (onto the Trash or onto an app in the Dock).

import St from 'gi://St';
import Gio from 'gi://Gio';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import cairo from 'gi://cairo';
import Pango from 'gi://Pango';
import Clutter from 'gi://Clutter';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { isActorAlive } from '../../core/Utils.js';


// images small enough to be drawn from the file itself when no thumbnail exists yet
const DIRECT_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const DIRECT_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml|x-icon|tiff|avif)$/;

export function fileGicon(entry) {
    if (entry.thumb) return Gio.FileIcon.new(Gio.File.new_for_path(entry.thumb));
    if (!entry.isDir && DIRECT_IMAGE_TYPES.test(entry.contentType) && entry.size > 0 && entry.size <= DIRECT_IMAGE_MAX_BYTES) {
        return Gio.FileIcon.new(entry.file);
    }
    if (entry.gicon) return entry.gicon;
    return Gio.content_type_get_icon(entry.contentType || 'application/octet-stream');
}

export function isPicture(entry) {
    return Boolean(entry.thumb) || (!entry.isDir && DIRECT_IMAGE_TYPES.test(entry.contentType));
}

// pictures keep their shape (St.Icon would square them): decoded off the main thread at the size they are drawn,
// shown in a thin light frame once loaded; the file type's icon stands in until then
const PIX_CACHE_MAX = 96;
const _pixCache = new Map();

function loadPixbuf(path, px, done) {
    const key = `${path}|${px}`;
    const hit = _pixCache.get(key);
    if (hit) {
        _pixCache.delete(key);
        _pixCache.set(key, hit);
        done(hit);
        return;
    }
    Gio.File.new_for_path(path).read_async(GLib.PRIORITY_LOW, null, (f, res) => {
        let stream;
        try {
            stream = f.read_finish(res);
        } catch (_e) {
            done(null);
            return;
        }
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, px, px, true, null, (_s, r) => {
            let pixbuf = null;
            try {
                pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(r);
            } catch (_e) {
                pixbuf = null;
            }
            stream.close_async(GLib.PRIORITY_LOW, null, () => {});
            if (pixbuf) {
                _pixCache.set(key, pixbuf);
                while (_pixCache.size > PIX_CACHE_MAX) _pixCache.delete(_pixCache.keys().next().value);
            }
            done(pixbuf);
        });
    });
}

function pictureIcon(entry, size, renderSize) {
    const box = new St.Widget({ layout_manager: new Clutter.BinLayout(), width: size, height: size, style_class: 'dhruva-stack-picture-box' });
    const stand = new St.Icon({
        gicon: entry.gicon || Gio.content_type_get_icon(entry.contentType || 'image/png'),
        icon_size: Math.round(renderSize),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    stand.set_size(size, size);
    box.add_child(stand);
    let scale = 1;
    try {
        scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) { /* no stage yet */ }
    const frame = 2;
    const px = Math.ceil((renderSize - 2 * frame) * scale);
    loadPixbuf(entry.thumb || entry.path, px, pixbuf => {
        if (!pixbuf || !isActorAlive(box)) return;
        const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
        content.set_bytes(global.stage.context.get_backend().get_cogl_context(), pixbuf.read_pixel_bytes(),
            pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888, pixbuf.width, pixbuf.height, pixbuf.rowstride);
        // the picture fits the square (renderSize may be larger than size: the Dock draws its icons ahead of the magnifier)
        const fit = (size - 2 * frame) / Math.max(pixbuf.width, pixbuf.height);
        const w = Math.max(1, Math.round(pixbuf.width * fit));
        const h = Math.max(1, Math.round(pixbuf.height * fit));
        const image = new Clutter.Actor({ content, width: w, height: h });
        image.set_content_scaling_filters(Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
        const framed = new St.Bin({
            child: image,
            style_class: 'dhruva-stack-picture-frame',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.remove_all_children();
        box.add_child(framed);
    });
    return box;
}

export function fileIcon(entry, size, renderSize = size) {
    if (isPicture(entry) && (entry.thumb || entry.size <= DIRECT_IMAGE_MAX_BYTES)) return pictureIcon(entry, size, renderSize);
    const icon = new St.Icon({
        gicon: fileGicon(entry),
        icon_size: Math.round(renderSize),
        style_class: 'dhruva-stack-file-icon',
        fallback_icon_name: entry.isDir ? 'folder' : 'text-x-generic',
    });
    icon.set_size(size, size);
    return icon;
}

function launchContext() {
    try {
        return global.create_app_launch_context(0, -1);
    } catch (_e) {
        return null;
    }
}

export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri_async(uri, launchContext(), null, (_o, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
            } catch (e) {
                console.warn(`[Dhruva] could not open ${uri}: ${e.message}`);
            }
        });
    } catch (e) {
        console.warn(`[Dhruva] could not open ${uri}: ${e.message}`);
    }
}

export function openEntry(entry) {
    openUri(entry.uri);
}

export function openFolder(path) {
    openUri(Gio.File.new_for_path(path).get_uri());
}

// an app in the Dock opens the dropped file
export function openEntryWith(app, entry) {
    const info = app && app.get_app_info ? app.get_app_info() : null;
    if (!info) return false;
    try {
        info.launch([entry.file], launchContext());
        return true;
    } catch (e) {
        console.warn(`[Dhruva] ${app.get_name()} could not open ${entry.uri}: ${e.message}`);
        return false;
    }
}

export function isStackFileSource(source) {
    return Boolean(source && source.isStackFile && source.entry);
}

function roundedRect(cr, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
    cr.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
    cr.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
    cr.arc(x + rr, y + rr, rr, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// a name pill drawn by cairo (anti-aliased edges even when the fan tilts it): fill = the widget's css `color`,
// stroke = `-dhruva-pill-stroke`; the text is an St.Label on top
export function namePill(text, maxWidth, styleClass = 'dhruva-stack-label') {
    const bin = new St.Widget({ layout_manager: new Clutter.BinLayout(), style_class: `${styleClass}-bin` });
    const area = new St.DrawingArea({ style_class: styleClass, x_expand: true, y_expand: true });
    const label = new St.Label({
        text,
        style_class: `${styleClass}-text`,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
    label.set_style(`max-width: ${Math.round(maxWidth)}px;`);
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const node = a.get_theme_node();
        const fill = node.get_foreground_color();
        const [hasStroke, stroke] = node.lookup_color('-dhruva-pill-stroke', false);
        const m = 1.0;
        cr.save();
        cr.setOperator(cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();
        roundedRect(cr, m, m, w - 2 * m, h - 2 * m, Math.min(9, (h - 2 * m) / 2));
        cr.setSourceRGBA(fill.red / 255, fill.green / 255, fill.blue / 255, fill.alpha / 255);
        cr.fillPreserve();
        if (hasStroke) {
            cr.setSourceRGBA(stroke.red / 255, stroke.green / 255, stroke.blue / 255, stroke.alpha / 255);
            cr.setLineWidth(1);
            cr.stroke();
        }
        cr.$dispose();
    });
    bin.add_child(area);
    bin.add_child(label);
    bin._area = area;
    bin._label = label;
    return bin;
}

// make `actor` a drag source for `entry`; the picture under the pointer is a fresh icon, a drop nobody takes flies back
// into `homeActor()` (the stack icon in the Dock)
export function makeFileDraggable(actor, entry, { iconSize, homeActor, onBegin, onEnd }) {
    actor._delegate = {
        isStackFile: true,
        entry,
        getDragActor: () => {
            const icon = fileIcon(entry, iconSize, iconSize);
            icon.reactive = false;
            return icon;
        },
        getDragActorSource: () => {
            const home = homeActor ? homeActor() : null;
            return isActorAlive(home) && home.visible ? home : actor;
        },
    };
    const draggable = DND.makeDraggable(actor, { restoreOnSuccess: false, dragActorOpacity: 235 });
    draggable.connect('drag-begin', () => {
        if (onBegin) onBegin(draggable);
    });
    draggable.connect('drag-end', (_d, _time, accepted) => {
        if (onEnd) onEnd(accepted);
    });
    draggable.connect('drag-cancelled', () => {
        if (onEnd) onEnd(false);
    });
    return draggable;
}

export function monitorOf(actor) {
    try {
        const idx = Main.layoutManager.findIndexForActor(actor);
        return Main.layoutManager.monitors[idx] || Main.layoutManager.primaryMonitor;
    } catch (_e) {
        return Main.layoutManager.primaryMonitor;
    }
}

// the button's rest rectangle in stage coordinates (its slot in the Dock, without the magnifier's scale or lift)
export function restRect(btn) {
    const parent = btn.get_parent();
    if (!parent) {
        const [x, y] = btn.get_transformed_position();
        const [w, h] = btn.get_transformed_size();
        return { x, y, w, h };
    }
    const [px, py] = parent.get_transformed_position();
    const box = btn.get_allocation_box();
    return { x: px + box.x1, y: py + box.y1, w: box.x2 - box.x1, h: box.y2 - box.y1 };
}

export function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

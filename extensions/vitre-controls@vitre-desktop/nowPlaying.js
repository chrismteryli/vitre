/* The 2x2 "Now Playing" tile (the reference's top-right module): artwork square, track line and
 * previous / play-pause / next, driven by GNOME's own MPRIS source (ui/mpris.js). */
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {MprisSource} from 'resource:///org/gnome/shell/ui/mpris.js';

const ICON_PREV = 'prev';
const ICON_NEXT = 'next';
const ICON_PLAY = 'play';
const ICON_PAUSE = 'pause';

// the reference's transport glyphs are solid shapes (the icon themes here only have outlines), so they
// are drawn: solid triangles with slightly rounded corners, in the widget's CSS colour.
const Glyph = GObject.registerClass(
class Glyph extends St.DrawingArea {
    _init(kind) {
        super._init({style_class: 'cc-np-glyph', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._kind = kind;
        this.connect('repaint', () => this._draw());
        this.connect('style-changed', () => this.queue_repaint());
    }

    set kind(kind) {
        if (kind === this._kind)
            return;
        this._kind = kind;
        this.queue_repaint();
    }

    _draw() {
        const [w, h] = this.get_surface_size();
        const cr = this.get_context();
        const c = this.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
        cr.setLineJoin(1); // round
        cr.setLineWidth(2);
        const tri = (x0, x1, up) => {
            // pointing right when up, left otherwise; vertical extent h - 4, inset by the stroke
            const cy = h / 2;
            const half = (h - 4) / 2;
            if (up) {
                cr.moveTo(x0, cy - half); cr.lineTo(x1, cy); cr.lineTo(x0, cy + half);
            } else {
                cr.moveTo(x1, cy - half); cr.lineTo(x0, cy); cr.lineTo(x1, cy + half);
            }
            cr.closePath();
            cr.fillPreserve();
            cr.stroke();
        };
        if (this._kind === 'pause') {
            cr.rectangle(w * 0.25, 2, w * 0.18, h - 4);
            cr.rectangle(w * 0.57, 2, w * 0.18, h - 4);
            cr.fill();
        } else if (this._kind === 'play') {
            tri(w * 0.22, w * 0.82, true);
        } else if (this._kind === 'next') {
            tri(w * 0.04, w * 0.50, true);
            tri(w * 0.46, w * 0.92, true);
        } else {
            tri(w * 0.08, w * 0.54, false);
            tri(w * 0.50, w * 0.96, false);
        }
        cr.$dispose();
    }
});

function controlButton(kind, cls) {
    return new St.Button({
        style_class: `cc-np-button ${cls}`, can_focus: true, reactive: true, track_hover: true,
        x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        child: new Glyph(kind),
    });
}

export const NowPlayingTile = GObject.registerClass(
class NowPlayingTile extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'cc-module cc-tile cc-nowplaying',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false, can_focus: false, x_expand: true, y_expand: true,
        });
        this._source = new MprisSource();
        this._player = null;

        // blank rounded square until a player supplies cover art
        this._art = new St.Bin({
            style_class: 'cc-np-art', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START,
        });
        this.add_child(this._art);
        this.add_child(new St.Widget({y_expand: true}));
        this._title = new St.Label({style_class: 'cc-np-title', text: 'Not Playing', x_align: Clutter.ActorAlign.START});
        this._title.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END
        this._subtitle = new St.Label({style_class: 'cc-np-subtitle', text: '', visible: false, x_align: Clutter.ActorAlign.START});
        this._subtitle.clutter_text.ellipsize = 3;
        this.add_child(this._title);
        this.add_child(this._subtitle);
        const row = new St.BoxLayout({style_class: 'cc-np-controls', x_expand: true});
        this._prev = controlButton(ICON_PREV, 'cc-np-prev');
        this._play = controlButton(ICON_PLAY, 'cc-np-play');
        this._next = controlButton(ICON_NEXT, 'cc-np-next');
        for (const b of [this._prev, this._play, this._next])
            row.add_child(b);
        this.add_child(row);
        this._prev.connect('clicked', () => this._player?.previous());
        this._play.connect('clicked', () => this._player?.playPause());
        this._next.connect('clicked', () => this._player?.next());

        this._source.connectObject(
            'player-added', () => this._pick(),
            'player-removed', () => this._pick(), this);
        this._pick();
    }

    _pick() {
        const players = this._source.players;
        const playing = players.find(p => p.status === 'Playing');
        const player = playing ?? players[0] ?? null;
        if (player === this._player) {
            this._sync();
            return;
        }
        this._player?.disconnectObject(this);
        this._player = player;
        this._player?.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const p = this._player;
        if (!p) {
            this._title.text = 'Not Playing';
            this._subtitle.visible = false;
            this._play.child.kind = ICON_PLAY;
            this._setArt('');
            for (const b of [this._prev, this._play, this._next])
                b.reactive = false;
            this.add_style_pseudo_class('idle');
            return;
        }
        this.remove_style_pseudo_class('idle');
        this._title.text = p.trackTitle || 'Unknown title';
        this._subtitle.text = (p.trackArtists ?? []).join(', ');
        this._subtitle.visible = this._subtitle.text !== '';
        this._play.child.kind = p.status === 'Playing' ? ICON_PAUSE : ICON_PLAY;
        this._prev.reactive = p.canGoPrevious !== false;
        this._next.reactive = p.canGoNext !== false;
        this._play.reactive = true;
        this._setArt(p.trackCoverUrl);
    }

    _setArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        if (url?.startsWith('file://')) {
            // St clips a CSS background image to the border radius
            this._art.set_style(`background-image: url("${url}"); background-size: 44px 44px;`);
            this._art.add_style_class_name('has-art');
        } else {
            this._art.set_style('');
            this._art.remove_style_class_name('has-art');
        }
    }

    destroyTile() {
        this._source.disconnectObject(this);
        this._player?.disconnectObject(this);
        this._player = null;
        this.destroy();
    }
});

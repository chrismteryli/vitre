/* Turns a GNOME QuickSlider (icon button | slider | menu button in one row) into the reference's
 * slider tile: a title on top, and under it  small icon | track | large icon | (round
 * output button for Sound). Every original actor is moved, not copied, and moved back by
 * the journal on disable. */
import Clutter from 'gi://Clutter';
import St from 'gi://St';

const TITLES = {display: 'Display', sound: 'Sound', mic: 'Microphone'};
const BIG_ICONS = {
    display: 'display-brightness-symbolic',
    sound: 'audio-volume-high-symbolic',
    mic: 'audio-input-microphone-symbolic',
};

export function buildSliderTile(item, role, journal) {
    const box = item.get_child();
    const children = box?.get_children() ?? [];
    if (children.length !== 3)
        return false;
    const [iconButton, sliderBin, menuButton] = children;

    const column = new St.BoxLayout({
        style_class: 'cc-slider-column', orientation: Clutter.Orientation.VERTICAL,
        x_expand: true, y_expand: true,
    });
    journal.add(() => column.destroy());
    const title = new St.Label({
        text: TITLES[role] ?? 'Slider', style_class: 'cc-slider-title', x_align: Clutter.ActorAlign.START,
    });
    const row = new St.BoxLayout({style_class: 'cc-slider-row', x_expand: true, y_expand: true,
        y_align: Clutter.ActorAlign.CENTER});
    column.add_child(title);
    column.add_child(row);
    const bigIcon = new St.Icon({icon_name: BIG_ICONS[role] ?? 'display-brightness-symbolic',
        style_class: 'cc-slider-big-icon', y_align: Clutter.ActorAlign.CENTER});

    // swap the item's child first so the undo (reverse order) puts the box back last
    const savedChild = item.get_child();
    journal.add(() => item.set_child(savedChild));
    item.set_child(column);
    journal.move(iconButton, row);
    journal.move(sliderBin, row);
    row.add_child(bigIcon);
    journal.move(menuButton, row);
    iconButton.add_style_class_name('cc-slider-small-button');
    journal.add(() => iconButton.remove_style_class_name('cc-slider-small-button'));
    menuButton.add_style_class_name('cc-slider-round');
    journal.add(() => menuButton.remove_style_class_name('cc-slider-round'));
    return {title, row, bigIcon};
}

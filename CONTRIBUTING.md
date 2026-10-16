# Contributing

Vitre is a set of GNOME Shell extensions (`extensions/vitre-*`), a theme, icons, a cursor and wallpapers. It is one person's
project, so please keep changes small and say what you tested.

## Reporting a problem

Open an issue and fill in the template. The most useful thing you can add is the output of:

```bash
./vitre-info.sh
```

It prints your GNOME version, distro, CPU, session type and the last Vitre lines from the system log. It changes nothing.

If your desktop will not start after installing, press Ctrl+Alt+F3, log in, run `./uninstall.sh` from the Vitre folder and
reboot. That puts your settings back.

## Changing code

- GNOME loads extension code when you sign in, so sign out and back in to see a change.
- Match the style of the file you are in. Comments say why, not what.
- The extensions turn themselves off cleanly. If you add something, make `disable()` put it back.
- Test with animations on and off (GNOME Settings, Accessibility, Reduce animation).

This repository is the packaged release, generated from the author's working folders. A pull request is applied there by
hand and credited to you.

## Be decent

Be kind to the person on the other end of the issue. Disagree about the code, not the person.

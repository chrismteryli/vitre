Vitre login screen and boot splash (optional)

These two are the only parts of Vitre that need root, so the normal installer leaves them out. Run them only if you want
the Vitre login screen and boot splash too.

  ./system/install-system.sh --check     looks at your system and changes nothing
  sudo ./system/install-system.sh        installs both (it asks you to type yes first)
  sudo ./system/uninstall-system.sh      puts Ubuntu's login screen and splash back

What it does: it copies the Vitre login theme and splash into /usr/share, registers them with update-alternatives at a higher
priority than Ubuntu's, and rebuilds the initramfs for the running kernel (the splash lives there). If a step fails, the
installer puts everything back by itself. A note of what was set before goes to /var/backups/vitre-system-<date>/.

Needs: Ubuntu or a Debian based system, GNOME Shell 51 (it refuses other versions unless you add --force), Plymouth.
The login screen shows the next time you sign out. The splash shows at the next boot.

If something looks wrong at the login screen: press Ctrl+Alt+F3, sign in on the text console, and run
sudo ./system/uninstall-system.sh, then reboot.

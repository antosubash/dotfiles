# Keyboard setup (GNOME)

`scripts/setup-keyboard.sh` sets up a keyboard-driven GNOME desktop. `setup-ubuntu.sh` runs it as its
`keyboard` section; run it alone with `bash scripts/setup-keyboard.sh`. It runs only inside a GNOME
session (it needs `DBUS_SESSION_BUS_ADDRESS` and `XDG_CURRENT_DESKTOP` containing `GNOME`), and is
safe to re-run: custom shortcuts live at fixed paths, so a re-run never adds duplicates.

## Shortcuts

| Keys | Action | Set by | GNOME default (to undo) |
|---|---|---|---|
| Alt+Space | Ulauncher (app launcher) | custom shortcut `dotfiles-ulauncher` → `ulauncher-toggle` | Alt+Space opened the window menu (`activate-window-menu`) |
| Super+Space | Switch input source (de ↔ us) | unchanged | `switch-input-source` is `['<Super>space', 'XF86Keyboard']` |
| Caps Lock (tap) | Esc | keyd, `/etc/keyd/default.conf` | Caps Lock |
| Caps Lock (hold) | Ctrl | keyd, `/etc/keyd/default.conf` | Caps Lock |
| Super+1..6 | Switch to workspace 1..6 (Super+Home still goes to 1) | `switch-to-workspace-N` | Super+N launched the Nth dock app; workspace 1 was Super+Home only |
| Super+Shift+1..6 | Move the window to workspace 1..6 (Super+Shift+Home still moves to 1) | `move-to-workspace-N` | Super+Shift+N opened a new window of the Nth dock app; move to 1 was Super+Shift+Home only |
| Super+Return | Alacritty | custom shortcut `dotfiles-terminal` → `alacritty` | unbound |
| Super+B | Web browser | media-keys `www` | unbound |
| Super+E | Files (home folder) | media-keys `home` | unbound |
| Super+Q | Close window | wm `close` (Alt+F4 still works) | Super+Q showed the dock's app-number overlay |
| Super+V | Clipboard history (GPaste) | `org.gnome.GPaste show-history` | Super+V opened the notification list |
| Super+M | Notification list | `toggle-message-tray` | Super+V and Super+M |
| Super+N | Focus the newest notification | unchanged | `focus-active-notification` is `['<Super>n']` |

Workspaces are fixed at 6 instead of dynamic.

### Text expansion (espanso)

Type a trigger anywhere and espanso replaces it. The matches live in `config/espanso/match/base.yml`,
which `install.sh` links to `~/.config/espanso/match/base.yml`.

| Trigger | Expands to |
|---|---|
| `:date` | today as `16.10.2026` |
| `:isodate` | today as `2026-10-16` |
| `:time` | the time as `14:05` |
| `:mail` | `git config --global user.email` |
| `:shrug` | `¯\_(ツ)_/¯` |

espanso follows the active GNOME input source: it reads `org.gnome.desktop.input-sources mru-sources`
and reloads when you switch with Super+Space, so triggers match on both `de` and `us`. The script
doesn't set a layout. Only if detection fails (triggers don't fire, or the wrong characters come out),
set one by hand in `~/.config/espanso/config/default.yml` and run `espanso restart`:

```yaml
keyboard_layout:
  layout: "de"
```

That fixes espanso to the one layout, so leave it out unless you need it.

## What the script changes, and how to undo it

Every `gsettings` key it sets, with the value this machine had before (also GNOME's/Ubuntu's stock
value). Undo one with `gsettings reset <schema> <key>`.

| Schema | Key | Set to | Default |
|---|---|---|---|
| `org.gnome.desktop.wm.keybindings` | `switch-input-source` | not changed | `['<Super>space', 'XF86Keyboard']` |
| `org.gnome.desktop.wm.keybindings` | `activate-window-menu` | `[]` | `['<Alt>space']` |
| `org.gnome.desktop.wm.keybindings` | `close` | `['<Super>q', '<Alt>F4']` | `['<Alt>F4']` |
| `org.gnome.desktop.wm.keybindings` | `switch-to-workspace-1` | `['<Super>1', '<Super>Home']` | `['<Super>Home']` |
| `org.gnome.desktop.wm.keybindings` | `switch-to-workspace-2`..`6` | `['<Super>N']` | `@as []` |
| `org.gnome.desktop.wm.keybindings` | `move-to-workspace-1` | `['<Super><Shift>1', '<Super><Shift>Home']` | `['<Super><Shift>Home']` |
| `org.gnome.desktop.wm.keybindings` | `move-to-workspace-2`..`6` | `['<Super><Shift>N']` | `@as []` |
| `org.gnome.desktop.wm.preferences` | `num-workspaces` | `6` | `4` |
| `org.gnome.mutter` | `dynamic-workspaces` | `false` | `true` |
| `org.gnome.shell.keybindings` | `toggle-message-tray` | `['<Super>m']` | `['<Super>v', '<Super>m']` |
| `org.gnome.shell.keybindings` | `switch-to-application-1`..`6` | `[]` | `['<Super>N']` |
| `org.gnome.shell.extensions.dash-to-dock` | `hot-keys` | `false` | `true` |
| `org.gnome.settings-daemon.plugins.media-keys` | `www` | `['<Super>b']` | `['']` |
| `org.gnome.settings-daemon.plugins.media-keys` | `home` | `['<Super>e']` | `['']` |
| `org.gnome.settings-daemon.plugins.media-keys` | `custom-keybindings` | adds the two paths below | `@as []` |
| `org.gnome.GPaste` | `show-history` | `'<Super>v'` | `'<Ctrl><Alt>H'` |

Turning off the dock's `hot-keys` also frees the dock's Super+Shift+N and Super+Q (`shortcut`)
bindings, which only apply while `hot-keys` is on.

To undo everything at once:

```bash
wm=org.gnome.desktop.wm.keybindings
mk=org.gnome.settings-daemon.plugins.media-keys
for k in activate-window-menu close; do gsettings reset $wm $k; done
for i in 1 2 3 4 5 6; do
    gsettings reset $wm switch-to-workspace-$i
    gsettings reset $wm move-to-workspace-$i
    gsettings reset org.gnome.shell.keybindings switch-to-application-$i
done
gsettings reset org.gnome.desktop.wm.preferences num-workspaces
gsettings reset org.gnome.mutter dynamic-workspaces
gsettings reset org.gnome.shell.keybindings toggle-message-tray
gsettings reset org.gnome.shell.extensions.dash-to-dock hot-keys
gsettings reset $mk www
gsettings reset $mk home
gsettings reset org.gnome.GPaste show-history
for id in dotfiles-terminal dotfiles-ulauncher; do
    gsettings reset-recursively "$mk.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/$id/"
done
```

`gsettings reset $mk custom-keybindings` empties the whole custom-shortcut list. That matches this
machine's default, but if you've added your own shortcuts since, remove just the two `dotfiles-*`
paths with `gsettings set $mk custom-keybindings "[...]"` instead.

### Outside gsettings

| Change | Undo |
|---|---|
| keyd installed, `/etc/keyd/default.conf` written, `keyd.service` enabled | `sudo rm /etc/keyd/default.conf && sudo systemctl restart keyd` (or `sudo apt remove keyd`) |
| Ulauncher 5.16.2 `.deb` (pinned and verified) | `sudo apt remove ulauncher` |
| `~/.config/autostart/ulauncher.desktop` (starts Ulauncher hidden, under XWayland; the only launcher, the packaged `ulauncher.service` user unit stays disabled) | delete the file |
| `gpaste-2` and `gnome-shell-extension-gpaste` installed, extension enabled | `gnome-extensions disable GPaste@gnome-shell-extensions.gnome.org`, then `sudo apt remove gpaste-2 gnome-shell-extension-gpaste` |
| espanso 2.4.1 Wayland `.deb` (pinned and verified), with `cap_dac_override+p` set on `/usr/bin/espanso` | `espanso service unregister && sudo apt remove espanso` |
| `~/.config/espanso/match/base.yml` symlink (from `install.sh`) | delete the symlink |

On Debian and Ubuntu the keyd binary is named `keyd.rvaiya` (it clashes with another package's `keyd`),
so use `keyd.rvaiya monitor` or `keyd.rvaiya reload`. The service is still `keyd`.

## Notes

- Ulauncher's own hotkey setting is ignored under Wayland; Alt+Space works through the GNOME custom
  shortcut. On first start it may show a notification asking you to bind `ulauncher-toggle`, which is
  already done. Ulauncher runs under XWayland (`GDK_BACKEND=x11`) so its window is placed correctly,
  and it starts at login from `~/.config/autostart/ulauncher.desktop` only; the packaged
  `ulauncher.service` user unit isn't enabled.
- The GPaste extension only appears after you log out and back in. The script sets Super+V on its
  first run, but it can enable the extension only once the extension is visible, so re-run the script
  after the next login.

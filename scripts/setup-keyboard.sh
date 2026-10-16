#!/usr/bin/env bash
# Keyboard-driven GNOME setup. Everything it changes, with GNOME's defaults
# for undoing it, is listed in docs/keyboard.md.
#   Alt+Space        Ulauncher            Caps Lock   Esc on tap, Ctrl on hold (keyd)
#   Super+1..6       workspace 1..6       Super+Shift+1..6  move window there
#   Super+Return     Alacritty            Super+B / Super+E  browser / files
#   Super+Q          close window         Super+V      clipboard history (GPaste)
#   espanso          :date :isodate :time :mail :shrug
# Super+Space stays GNOME's input-source switch.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/setup-common.sh
. "$HERE/lib/setup-common.sh"
# shellcheck source=lib/installers.sh
. "$HERE/lib/installers.sh"

MEDIA_KEYS=org.gnome.settings-daemon.plugins.media-keys
CUSTOM_BASE=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings
WM_KEYS=org.gnome.desktop.wm.keybindings
KEYD_CONF="${KEYD_CONF:-/etc/keyd/default.conf}"

# set_custom_shortcut ID NAME COMMAND BINDING: creates or updates the custom
# shortcut at a fixed path named after ID, so re-runs never add duplicates.
set_custom_shortcut() {
    local id="$1" name="$2" command="$3" binding="$4" list path
    path="$CUSTOM_BASE/$id/"
    list="$(gsettings get "$MEDIA_KEYS" custom-keybindings)"
    if [[ "$list" != *"'$path'"* ]]; then
        case "$list" in
            "@as []"|"[]") list="['$path']" ;;
            *) list="${list%]}, '$path']" ;;
        esac
        gsettings set "$MEDIA_KEYS" custom-keybindings "$list"
    fi
    local schema="$MEDIA_KEYS.custom-keybinding:$path"
    gsettings set "$schema" name "$name"
    gsettings set "$schema" command "$command"
    gsettings set "$schema" binding "$binding"
}

configure_shortcuts() {
    gsettings set "$WM_KEYS" activate-window-menu "[]"          # frees Alt+Space for Ulauncher
    gsettings set "$WM_KEYS" close "['<Super>q', '<Alt>F4']"
    gsettings set "$MEDIA_KEYS" www "['<Super>b']"
    gsettings set "$MEDIA_KEYS" home "['<Super>e']"
    # Frees Super+V for GPaste. Super+N stays focus-active-notification.
    gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"
    set_custom_shortcut dotfiles-terminal "Terminal" alacritty "<Super>Return"
    set_custom_shortcut dotfiles-ulauncher "Ulauncher" ulauncher-toggle "<Alt>space"
}

configure_workspaces() {
    local i
    gsettings set org.gnome.mutter dynamic-workspaces false
    gsettings set org.gnome.desktop.wm.preferences num-workspaces 6
    # The Ubuntu dock binds Super+1..9 (and Super+Shift+N, and Super+Q for its
    # number overlay) to dock apps while hot-keys is on; hand them back.
    if gsettings list-keys org.gnome.shell.extensions.dash-to-dock > /dev/null 2>&1; then
        gsettings set org.gnome.shell.extensions.dash-to-dock hot-keys false
    fi
    for i in 1 2 3 4 5 6; do
        gsettings set org.gnome.shell.keybindings "switch-to-application-$i" "[]"
        gsettings set "$WM_KEYS" "switch-to-workspace-$i" "['<Super>$i']"
        gsettings set "$WM_KEYS" "move-to-workspace-$i" "['<Super><Shift>$i']"
    done
}

configure_keyd() {
    apt_install_missing keyd || return 1
    if ! cmp -s "$DOTFILES_DIR/config/keyd/default.conf" "$KEYD_CONF"; then
        sudo install -D -m 0644 "$DOTFILES_DIR/config/keyd/default.conf" "$KEYD_CONF" || return 1
        # Debian names the binary keyd.rvaiya, so restart the unit rather than `keyd reload`.
        if has_systemd; then
            sudo systemctl enable keyd && sudo systemctl restart keyd
        fi
    fi
}

install_ulauncher() {
    if needs_install ulauncher "$ULAUNCHER_VERSION"; then
        install_verified_deb "$ULAUNCHER_URL" "$ULAUNCHER_SHA256" || return 1
    fi
    # Start hidden at login. Ulauncher 5 positions its window correctly only under XWayland.
    mkdir -p "$HOME/.config/autostart"
    cat > "$HOME/.config/autostart/ulauncher.desktop" <<'EOF'
[Desktop Entry]
Name=Ulauncher
Exec=env GDK_BACKEND=x11 /usr/bin/ulauncher --hide-window
Icon=ulauncher
Type=Application
X-GNOME-Autostart-enabled=true
EOF
    pgrep -x ulauncher > /dev/null || (GDK_BACKEND=x11 setsid ulauncher --hide-window > /dev/null 2>&1 &)
}

install_gpaste() {
    apt_install_missing gpaste-2 gnome-shell-extension-gpaste || return 1
    # Set the shortcut first: the schema comes with gpaste-2, while the shell
    # extension only becomes visible after the next login.
    if gsettings list-keys org.gnome.GPaste > /dev/null 2>&1; then
        gsettings set org.gnome.GPaste show-history '<Super>v'
    else
        echo "WARNING: the org.gnome.GPaste settings schema isn't installed; Super+V is not set."
    fi
    local uuid
    uuid="$(gnome-extensions list 2>/dev/null | grep -i gpaste | head -1)"
    if [ -z "$uuid" ]; then
        echo "WARNING: the GPaste shell extension isn't visible yet; log out and in, then re-run."
        return 0
    fi
    gnome-extensions enable "$uuid" || echo "WARNING: could not enable $uuid on this GNOME version."
}

# configure_espanso_layout: espanso on Wayland assumes a US layout unless told
# otherwise, so a ":" typed on a German keyboard never matches a trigger. Sets
# keyboard_layout from the first xkb input source, once, if it isn't us.
configure_espanso_layout() {
    local conf="$HOME/.config/espanso/config/default.yml" src layout variant
    grep -q '^keyboard_layout:' "$conf" 2>/dev/null && return 0
    src="$(gsettings get org.gnome.desktop.input-sources sources 2>/dev/null \
        | grep -o "('xkb', '[^']*')" | head -1 | cut -d"'" -f4)"
    layout="${src%%+*}"
    [ -n "$layout" ] && [ "$layout" != us ] || return 0
    variant=""
    [[ "$src" == *+* ]] && variant="${src#*+}"
    mkdir -p "$(dirname "$conf")"
    {
        echo "# Added by scripts/setup-keyboard.sh: the first GNOME input source."
        echo "keyboard_layout:"
        echo "  layout: \"$layout\""
        [ -n "$variant" ] && echo "  variant: \"$variant\""
    } >> "$conf"
    echo "espanso: set keyboard_layout to $src in $conf"
}

install_espanso() {
    if needs_install espanso "$ESPANSO_VERSION"; then
        install_verified_deb "$ESPANSO_URL" "$ESPANSO_SHA256" || return 1
    fi
    local bin
    bin="$(command -v espanso)" || { echo "ERROR: espanso is not on PATH." >&2; return 1; }
    # The Wayland build reads input devices directly and needs this capability.
    getcap "$bin" 2>/dev/null | grep -q cap_dac_override || sudo setcap "cap_dac_override+p" "$bin" || return 1
    configure_espanso_layout
    espanso service register > /dev/null 2>&1 || true
    espanso status > /dev/null 2>&1 || espanso start
}

main() {
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [[ "${XDG_CURRENT_DESKTOP:-}" != *GNOME* ]]; then
        echo "Not in a GNOME session; skipping the keyboard setup."
        return 0
    fi
    local status=0
    configure_keyd || status=1
    install_ulauncher || status=1
    configure_shortcuts || status=1
    configure_workspaces || status=1
    install_gpaste || status=1
    install_espanso || status=1
    echo ""
    echo "Keyboard shortcuts: see docs/keyboard.md"
    return "$status"
}

[ "${SETUP_KEYBOARD_SOURCE_ONLY:-}" = 1 ] || main "$@"

#!/usr/bin/env bash
# Tests for scripts/setup-keyboard.sh against a fake gsettings, sudo and apt
# (nothing touches the real desktop or system).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SCRIPT="$REPO/scripts/setup-keyboard.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

ORIG_HOME="$HOME"

fake() {  # fake NAME BODY
    printf '#!/usr/bin/env bash\n%s\n' "$2" > "$FAKE_BIN/$1"; chmod +x "$FAKE_BIN/$1"
}

# A gsettings backed by $TMPDIR_ROOT/gs, with lines "schema[:path] key value".
# list-keys fails for a schema named in $TMPDIR_ROOT/missing-schemas.
setup_fakes() {
    export TMPDIR_ROOT CALLS="$TMPDIR_ROOT/calls"
    : > "$CALLS"
    fake gsettings '
db="$TMPDIR_ROOT/gs"; touch "$db"
cmd="$1"; schema="$2"; key="${3:-}"
case "$cmd" in
  get) v="$(grep -F "$schema $key " "$db" | tail -1 | cut -d" " -f3-)"; [ -n "$v" ] && echo "$v" || echo "@as []" ;;
  set) grep -vF "$schema $key " "$db" > "$db.tmp"; mv "$db.tmp" "$db"; echo "$schema $key $4" >> "$db" ;;
  list-keys) ! grep -qxF "$schema" "$TMPDIR_ROOT/missing-schemas" 2>/dev/null ;;
  list-schemas) exit 0 ;;
esac'
    fake sudo 'echo "sudo $*" >> "$CALLS"'
    # keyd's unit is enabled/active when $TMPDIR_ROOT/keyd-enabled / keyd-active exist.
    fake systemctl 'case "$1" in
  is-enabled) [ -e "$TMPDIR_ROOT/keyd-enabled" ] ;;
  is-active) [ -e "$TMPDIR_ROOT/keyd-active" ] ;;
  *) echo "systemctl $*" >> "$CALLS" ;;
esac'
    fake dpkg-query 'printf "install ok installed"'
    export HOME="$TMPDIR_ROOT/home"
    mkdir -p "$HOME"
    # shellcheck disable=SC1090
    SETUP_KEYBOARD_SOURCE_ONLY=1 . "$SCRIPT"
}

end_test() {
    export HOME="$ORIG_HOME"
    teardown_test
}

gs_get() { gsettings get "$1" "$2"; }

CUSTOM=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings
MK=org.gnome.settings-daemon.plugins.media-keys

test_custom_shortcut_is_not_duplicated() {
    setup_test "custom shortcut re-run"
    setup_fakes
    set_custom_shortcut dotfiles-ulauncher Ulauncher ulauncher-toggle '<Alt>space'
    set_custom_shortcut dotfiles-ulauncher Ulauncher ulauncher-toggle '<Alt>space'
    local list
    list="$(gs_get $MK custom-keybindings)"
    assert_eq 1 "$(grep -o "dotfiles-ulauncher/" <<< "$list" | wc -l | tr -d ' ')" "listed once"
    assert_eq "<Alt>space" "$(gs_get "$MK.custom-keybinding:$CUSTOM/dotfiles-ulauncher/" binding)" "binding"
    assert_eq "ulauncher-toggle" "$(gs_get "$MK.custom-keybinding:$CUSTOM/dotfiles-ulauncher/" command)" "command"
    end_test
}

test_custom_shortcut_appends_to_existing_list() {
    setup_test "custom shortcut keeps existing ones"
    setup_fakes
    echo "$MK custom-keybindings ['/x/custom0/']" > "$TMPDIR_ROOT/gs"
    set_custom_shortcut dotfiles-terminal Terminal alacritty '<Super>Return'
    local list
    list="$(gs_get $MK custom-keybindings)"
    assert_contains "$list" "'/x/custom0/'" "keeps the existing one"
    assert_contains "$list" "'$CUSTOM/dotfiles-terminal/'" "adds the new one"
    end_test
}

test_workspaces() {
    setup_test "workspaces"
    setup_fakes
    configure_workspaces
    assert_eq false "$(gs_get org.gnome.mutter dynamic-workspaces)" "fixed workspaces"
    assert_eq 6 "$(gs_get org.gnome.desktop.wm.preferences num-workspaces)" "six of them"
    assert_eq "['<Super>3']" "$(gs_get org.gnome.desktop.wm.keybindings switch-to-workspace-3)" "switch"
    assert_eq "['<Super>1', '<Super>Home']" "$(gs_get org.gnome.desktop.wm.keybindings switch-to-workspace-1)" "switch 1 keeps Super+Home"
    assert_eq "['<Super><Shift>1', '<Super><Shift>Home']" "$(gs_get org.gnome.desktop.wm.keybindings move-to-workspace-1)" "move 1 keeps Super+Shift+Home"
    assert_eq "['<Super><Shift>6']" "$(gs_get org.gnome.desktop.wm.keybindings move-to-workspace-6)" "move"
    assert_eq "[]" "$(gs_get org.gnome.shell.keybindings switch-to-application-1)" "dash shortcuts freed"
    assert_eq false "$(gs_get org.gnome.shell.extensions.dash-to-dock hot-keys)" "dock hot keys off"
    end_test
}

test_shortcuts() {
    setup_test "shortcuts"
    setup_fakes
    configure_shortcuts
    assert_eq "[]" "$(gs_get org.gnome.desktop.wm.keybindings activate-window-menu)" "Alt+Space freed"
    assert_eq "['<Super>q', '<Alt>F4']" "$(gs_get org.gnome.desktop.wm.keybindings close)" "close"
    assert_eq "['<Super>b']" "$(gs_get $MK www)" "browser"
    assert_eq "['<Super>e']" "$(gs_get $MK home)" "files"
    assert_eq "['<Super>m']" "$(gs_get org.gnome.shell.keybindings toggle-message-tray)" "message tray"
    assert_contains "$(gs_get $MK custom-keybindings)" "$CUSTOM/dotfiles-terminal/" "terminal listed"
    assert_eq "<Super>Return" "$(gs_get "$MK.custom-keybinding:$CUSTOM/dotfiles-terminal/" binding)" "terminal binding"
    assert_eq "alacritty" "$(gs_get "$MK.custom-keybinding:$CUSTOM/dotfiles-terminal/" command)" "terminal command"
    end_test
}

test_skips_without_gnome() {
    setup_test "no GNOME session"
    setup_fakes  # so a broken guard would hit fakes, not the real system
    local out status
    out="$(env -u DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP=KDE bash "$SCRIPT" 2>&1)"
    status=$?
    assert_eq 0 "$status" "exit status"
    assert_contains "$out" "GNOME" "says why"
    assert_eq "" "$(cat "$CALLS")" "no sudo calls"
    end_test
}

test_keyd_config_maps_capslock() {
    setup_test "keyd config"
    local conf="$REPO/config/keyd/default.conf"
    assert_contains "$(cat "$conf")" "capslock = overload(control, esc)" "caps mapping"
    assert_eq "*" "$(grep -A1 -x '\[ids\]' "$conf" | tail -1)" "every keyboard"
    teardown_test
}

# Debian ships keyd's binary as keyd.rvaiya, so a config change restarts the
# unit instead of calling `keyd reload`; an unchanged config does nothing.
test_keyd_installs_config_and_restarts_unit() {
    setup_test "keyd install"
    setup_fakes
    mkdir -p "$TMPDIR_ROOT/systemd"
    KEYD_CONF="$TMPDIR_ROOT/etc/keyd/default.conf" SYSTEMD_RUN_DIR="$TMPDIR_ROOT/systemd" configure_keyd > /dev/null
    assert_eq 0 $? "status"
    assert_contains "$(cat "$CALLS")" "install -D -m 0644 $REPO/config/keyd/default.conf $TMPDIR_ROOT/etc/keyd/default.conf" "installs the config"
    assert_contains "$(cat "$CALLS")" "systemctl restart keyd" "restarts keyd"
    assert_not_contains "$(cat "$CALLS")" "keyd reload" "no keyd reload"
    assert_contains "$(cat "$CALLS")" "sudo systemctl enable keyd" "enables keyd"
    # Same config in place and the unit enabled and running: no sudo at all.
    mkdir -p "$TMPDIR_ROOT/etc/keyd"; cp "$REPO/config/keyd/default.conf" "$TMPDIR_ROOT/etc/keyd/default.conf"
    touch "$TMPDIR_ROOT/keyd-enabled" "$TMPDIR_ROOT/keyd-active"
    : > "$CALLS"
    KEYD_CONF="$TMPDIR_ROOT/etc/keyd/default.conf" SYSTEMD_RUN_DIR="$TMPDIR_ROOT/systemd" configure_keyd > /dev/null
    assert_eq "" "$(cat "$CALLS")" "nothing on a re-run"
    end_test
}

# A run whose enable/restart failed leaves the config in place; the next run
# must still enable and start the unit, without a restart.
test_keyd_retries_service_when_config_unchanged() {
    setup_test "keyd service retry"
    setup_fakes
    mkdir -p "$TMPDIR_ROOT/systemd" "$TMPDIR_ROOT/etc/keyd"
    cp "$REPO/config/keyd/default.conf" "$TMPDIR_ROOT/etc/keyd/default.conf"
    KEYD_CONF="$TMPDIR_ROOT/etc/keyd/default.conf" SYSTEMD_RUN_DIR="$TMPDIR_ROOT/systemd" configure_keyd > /dev/null
    assert_eq 0 $? "status"
    assert_not_contains "$(cat "$CALLS")" "sudo install" "config left alone"
    assert_contains "$(cat "$CALLS")" "sudo systemctl enable keyd" "enables keyd"
    assert_contains "$(cat "$CALLS")" "sudo systemctl start keyd" "starts keyd"
    assert_not_contains "$(cat "$CALLS")" "restart" "no restart"
    end_test
}

test_keyd_without_systemd_succeeds() {
    setup_test "keyd without systemd"
    setup_fakes
    KEYD_CONF="$TMPDIR_ROOT/etc/keyd/default.conf" SYSTEMD_RUN_DIR="$TMPDIR_ROOT/none" configure_keyd > /dev/null
    assert_eq 0 $? "status"
    assert_not_contains "$(cat "$CALLS")" "systemctl" "no systemctl"
    end_test
}

test_gpaste_without_schema_warns() {
    setup_test "GPaste schema missing"
    setup_fakes
    fake gnome-extensions 'echo "gnome-extensions $*" >> "$CALLS"; [ "$1" = list ] && echo GPaste@gnome-shell-extensions.gnome.org; exit 0'
    echo org.gnome.GPaste > "$TMPDIR_ROOT/missing-schemas"
    local out
    out="$(install_gpaste 2>&1)"
    assert_eq 0 $? "status"
    assert_contains "$out" "WARNING" "warns"
    assert_not_contains "$(cat "$TMPDIR_ROOT/gs")" "show-history" "sets nothing"
    end_test
}

test_gpaste_sets_super_v_before_extension_is_visible() {
    setup_test "GPaste shortcut"
    setup_fakes
    fake gnome-extensions 'echo "gnome-extensions $*" >> "$CALLS"; exit 0'
    install_gpaste > /dev/null 2>&1
    assert_eq 0 $? "status"
    assert_eq "<Super>v" "$(gs_get org.gnome.GPaste show-history)" "Super+V"
    end_test
}

test_custom_shortcut_is_not_duplicated
test_custom_shortcut_appends_to_existing_list
test_workspaces
test_shortcuts
test_skips_without_gnome
test_keyd_config_maps_capslock
test_keyd_installs_config_and_restarts_unit
test_keyd_retries_service_when_config_unchanged
test_keyd_without_systemd_succeeds
test_gpaste_without_schema_warns
test_gpaste_sets_super_v_before_extension_is_visible
summary

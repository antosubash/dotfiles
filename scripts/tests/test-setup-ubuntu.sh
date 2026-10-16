#!/usr/bin/env bash
# Tests for scripts/setup-ubuntu.sh's section layout (no real installs).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/setup-ubuntu.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

EXPECTED="base editor languages dotnet cli security ssh-firewall vpn shell git-tools docker node python k8s db-gis ollama apps keyboard fonts nvidia apt-hygiene"

# Source the script's functions without running it.
load_setup_ubuntu() {
    # shellcheck disable=SC1090
    SETUP_UBUNTU_SOURCE_ONLY=1 . "$SCRIPT"
}

# Fake sudo (records its calls in $CALLS) and a dpkg-query that reports every package installed.
fake_installed_system() {
    export CALLS="$TMPDIR_ROOT/calls"; : > "$CALLS"
    printf '#!/bin/sh\necho "sudo $*" >> "%s"\n' "$CALLS" > "$FAKE_BIN/sudo"
    printf '#!/bin/sh\nprintf "install ok installed"\n' > "$FAKE_BIN/dpkg-query"
}

test_list_names_every_section() {
    setup_test "--list"
    assert_eq "$EXPECTED" "$(bash "$SCRIPT" --list | tr '\n' ' ' | sed 's/ $//')" "sections"
    teardown_test
}

test_every_section_has_a_function() {
    setup_test "section functions exist"
    load_setup_ubuntu
    local s
    for s in $EXPECTED; do
        assert_eq function "$(type -t "section_${s//-/_}")" "section_$s"
    done
    teardown_test
}

test_unknown_option_fails() {
    setup_test "unknown section"
    bash "$SCRIPT" --only nope > /dev/null 2>&1
    assert_eq 2 $? "exit status"
    teardown_test
}

test_nvidia_section_skips_without_gpu() {
    setup_test "nvidia section without GPU"
    load_setup_ubuntu
    SYSFS_PCI_DEVICES="$TMPDIR_ROOT/none" run_sections nvidia > "$TMPDIR_ROOT/out" 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "nvidia|skipped" "skipped"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "No NVIDIA GPU" "reason"
    teardown_test
}

test_sections_are_idempotent_under_fakes() {
    setup_test "cli section with everything installed"
    # Everything reports installed and at its pin, so the section must make no install calls.
    fake_installed_system
    for t in yq curlie bat; do printf '#!/bin/sh\necho "%s version 4.54.1"\n' "$t" > "$FAKE_BIN/$t"; done
    chmod +x "$FAKE_BIN"/*
    load_setup_ubuntu
    PINNED_BIN_DIR="$FAKE_BIN" SETUP_MACHINE=x86_64 run_sections cli > /dev/null 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "cli|ok" "cli ok"
    assert_not_contains "$(cat "$CALLS")" "install" "no install calls"
    teardown_test
}

# Without Go (arm64, or --only cli on a fresh machine) the cli section skips
# curlie instead of failing.
test_cli_section_without_go_skips_curlie() {
    setup_test "cli section without Go"
    fake_installed_system
    for t in yq bat; do printf '#!/bin/sh\necho "%s version 4.54.1"\n' "$t" > "$FAKE_BIN/$t"; done
    chmod +x "$FAKE_BIN"/*
    # Only the fakes and what the runner itself needs: no go, no curlie.
    local sys="$TMPDIR_ROOT/sys" t
    mkdir -p "$sys"
    for t in mktemp rm; do ln -s "$(command -v "$t")" "$sys/$t"; done
    load_setup_ubuntu
    PATH="$FAKE_BIN:$sys" PINNED_BIN_DIR="$FAKE_BIN" SETUP_MACHINE=x86_64 run_sections cli > "$TMPDIR_ROOT/out" 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "cli|ok" "cli ok"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "skipping curlie" "says curlie was skipped"
    teardown_test
}

# One package missing from the archive, or a broken source failing apt update,
# must not stop curl, ca-certificates and gnupg (add_apt_source needs them).
test_base_section_installs_apt_source_prereqs_first() {
    setup_test "base section with a broken apt"
    export CALLS="$TMPDIR_ROOT/calls"; : > "$CALLS"
    {
        printf '#!/bin/sh\necho "sudo $*" >> "%s"\n' "$CALLS"
        printf '[ "$1 $2" = "apt update" ] && exit 100\n'
        printf 'case "$*" in *fastfetch*) exit 100 ;; esac\n'
    } > "$FAKE_BIN/sudo"
    printf '#!/bin/sh\nexit 1\n' > "$FAKE_BIN/dpkg-query"
    printf '#!/bin/sh\nexit 0\n' > "$FAKE_BIN/apt-cache"
    chmod +x "$FAKE_BIN"/*
    load_setup_ubuntu
    run_sections base > "$TMPDIR_ROOT/out" 2>&1
    assert_contains "$(cat "$CALLS")" "apt-get install -y curl ca-certificates gnupg" "prereqs in their own call"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "WARNING: apt update" "a failed update is a warning"
    assert_contains "$(cat "$CALLS")" "fastfetch" "went on to the rest after the failed update"
    teardown_test
}

# update-all.sh runs these sections with SETUP_UPGRADE_ONLY=1 on every machine,
# servers included: on one that never had the tools, they must install nothing.
test_update_sections_install_nothing_new_in_upgrade_only_mode() {
    setup_test "upgrade-only sections on a bare machine"
    export CALLS="$TMPDIR_ROOT/calls"; : > "$CALLS"
    local t
    for t in sudo curl npm go apt-cache; do
        printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 1\n' "$t" "$CALLS" > "$FAKE_BIN/$t"
    done
    printf '#!/bin/sh\nexit 1\n' > "$FAKE_BIN/dpkg-query"
    chmod +x "$FAKE_BIN"/*
    # Only the fakes and what the runner itself needs: no node, curlie, pnpm or rustup.
    local sys="$TMPDIR_ROOT/sys"
    mkdir -p "$sys" "$TMPDIR_ROOT/home" "$TMPDIR_ROOT/pinned"
    for t in mktemp rm; do ln -s "$(command -v "$t")" "$sys/$t"; done
    load_setup_ubuntu
    HOME="$TMPDIR_ROOT/home" PATH="$FAKE_BIN:$sys" PINNED_BIN_DIR="$TMPDIR_ROOT/pinned" SETUP_MACHINE=x86_64 \
        SETUP_UPGRADE_ONLY=1 run_sections cli git-tools k8s node > "$TMPDIR_ROOT/out" 2>&1
    for t in cli git-tools k8s node; do
        assert_contains "${SECTION_RESULTS[*]}" "$t|ok" "$t ok"
    done
    assert_eq "" "$(grep -v '^apt-cache' "$CALLS")" "no sudo, downloads, npm or go install"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "Skipping curlie: not installed" "curlie skipped"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "Skipping Node.js: not installed" "Node.js skipped"
    teardown_test
}

# setup-keyboard.sh does nothing outside a GNOME session, so the section must
# say it skipped rather than report ok.
test_keyboard_section_skips_outside_gnome() {
    setup_test "keyboard section outside GNOME"
    load_setup_ubuntu
    DBUS_SESSION_BUS_ADDRESS="" XDG_CURRENT_DESKTOP=GNOME run_sections keyboard > "$TMPDIR_ROOT/out" 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "keyboard|skipped" "no D-Bus session: skipped"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "not in a GNOME session" "reason"
    SECTION_RESULTS=()
    DBUS_SESSION_BUS_ADDRESS=unix:path=/x XDG_CURRENT_DESKTOP=KDE run_sections keyboard > "$TMPDIR_ROOT/out" 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "keyboard|skipped" "KDE: skipped"
    teardown_test
}

# Only the snaps need systemd: the apt apps (Chrome, Claude Desktop...) install anyway.
test_apps_section_without_systemd_skips_only_the_snaps() {
    setup_test "apps section without systemd"
    export CALLS="$TMPDIR_ROOT/calls"; : > "$CALLS"
    printf '#!/bin/sh\necho "sudo $*" >> "%s"\n' "$CALLS" > "$FAKE_BIN/sudo"
    printf '#!/bin/sh\nexit 1\n' > "$FAKE_BIN/dpkg-query"
    printf '#!/bin/sh\nexit 1\n' > "$FAKE_BIN/snap"
    printf '#!/bin/sh\nexit 0\n' > "$FAKE_BIN/apt-cache"
    chmod +x "$FAKE_BIN"/*
    export APT_SOURCES_DIR="$TMPDIR_ROOT/sources" CLAUDE_DESKTOP_DEFAULT_FILE="$TMPDIR_ROOT/claude-desktop"
    mkdir -p "$APT_SOURCES_DIR" "$TMPDIR_ROOT/run-systemd"
    : > "$APT_SOURCES_DIR/google-chrome.sources"
    load_setup_ubuntu
    add_apt_source() { echo "add_apt_source $1" >> "$CALLS"; }
    SYSTEMD_RUN_DIR="$TMPDIR_ROOT/missing" run_sections apps > "$TMPDIR_ROOT/out" 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "apps|ok" "recorded ok, not skipped"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "No systemd; skipping snaps" "says why"
    assert_not_contains "$(cat "$CALLS")" "snap install" "no snap installs"
    assert_contains "$(cat "$CALLS")" "vlc thunderbird" "apt apps attempted"
    assert_contains "$(cat "$CALLS")" "google-chrome-stable" "Chrome attempted"
    assert_contains "$(cat "$CALLS")" "claude-desktop" "Claude Desktop attempted"
    : > "$CALLS"; SECTION_RESULTS=()
    SYSTEMD_RUN_DIR="$TMPDIR_ROOT/run-systemd" run_sections apps > "$TMPDIR_ROOT/out" 2>&1
    for s in slack discord zoom-client brave; do
        assert_contains "$(cat "$CALLS")" "snap install $s" "$s installed with systemd"
    done
    unset APT_SOURCES_DIR CLAUDE_DESKTOP_DEFAULT_FILE
    teardown_test
}

# Ubuntu's keyd package installs the binary as keyd.rvaiya.
test_tool_versions_find_ubuntus_keyd() {
    setup_test "print_tool_versions finds keyd.rvaiya"
    printf '#!/bin/sh\necho "keyd v2.5.0"\n' > "$FAKE_BIN/keyd.rvaiya"; chmod +x "$FAKE_BIN/keyd.rvaiya"
    local sys="$TMPDIR_ROOT/sys"
    mkdir -p "$sys"; ln -s "$(command -v head)" "$sys/head"
    load_setup_ubuntu
    local out
    out="$(PATH="$FAKE_BIN:$sys" print_tool_versions)"
    assert_contains "$out" "keyd        keyd v2.5.0" "keyd row shows keyd.rvaiya's version"
    assert_contains "$out" "jq          missing" "absent tools still listed as missing"
    teardown_test
}

test_apps_section_without_systemd_skips_only_the_snaps
test_list_names_every_section
test_keyboard_section_skips_outside_gnome
test_tool_versions_find_ubuntus_keyd
test_update_sections_install_nothing_new_in_upgrade_only_mode
test_every_section_has_a_function
test_unknown_option_fails
test_nvidia_section_skips_without_gpu
test_sections_are_idempotent_under_fakes
test_cli_section_without_go_skips_curlie
test_base_section_installs_apt_source_prereqs_first
summary

#!/usr/bin/env bash
# Tests for scripts/setup-ubuntu.sh's section layout (no real installs).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/setup-ubuntu.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

EXPECTED="base editor languages dotnet cli security ssh-firewall vpn shell git-tools docker node python k8s db-gis ollama apps keyboard fonts nvidia apt-hygiene"

test_list_names_every_section() {
    setup_test "--list"
    assert_eq "$EXPECTED" "$(bash "$SCRIPT" --list | tr '\n' ' ' | sed 's/ $//')" "sections"
    teardown_test
}

test_every_section_has_a_function() {
    setup_test "section functions exist"
    # shellcheck disable=SC1090
    SETUP_UBUNTU_SOURCE_ONLY=1 . "$SCRIPT"
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
    # shellcheck disable=SC1090
    SETUP_UBUNTU_SOURCE_ONLY=1 . "$SCRIPT"
    SYSFS_PCI_DEVICES="$TMPDIR_ROOT/none" run_sections nvidia > "$TMPDIR_ROOT/out" 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "nvidia|skipped" "skipped"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "No NVIDIA GPU" "reason"
    teardown_test
}

test_sections_are_idempotent_under_fakes() {
    setup_test "cli section with everything installed"
    # Everything reports installed and at its pin, so the section must make no install calls.
    export CALLS="$TMPDIR_ROOT/calls"; : > "$CALLS"
    printf '#!/bin/sh\necho "sudo $*" >> "%s"\n' "$CALLS" > "$FAKE_BIN/sudo"
    printf '#!/bin/sh\nprintf "install ok installed"\n' > "$FAKE_BIN/dpkg-query"
    for t in yq curlie bat; do printf '#!/bin/sh\necho "%s version 4.54.1"\n' "$t" > "$FAKE_BIN/$t"; done
    chmod +x "$FAKE_BIN"/*
    # shellcheck disable=SC1090
    SETUP_UBUNTU_SOURCE_ONLY=1 . "$SCRIPT"
    SETUP_MACHINE=x86_64 run_sections cli > /dev/null 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "cli|ok" "cli ok"
    assert_not_contains "$(cat "$CALLS")" "install" "no install calls"
    teardown_test
}

test_list_names_every_section
test_every_section_has_a_function
test_unknown_option_fails
test_nvidia_section_skips_without_gpu
test_sections_are_idempotent_under_fakes
summary

#!/usr/bin/env bash
# Tests for the section runner and guards in scripts/lib/setup-common.sh.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/lib/setup-common.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

load_lib() {
    # shellcheck disable=SC1090
    . "$SCRIPT"
    # shellcheck disable=SC2034  # read by the library
    SECTIONS=(one two three)
    section_one() { echo "ran one" >> "$TMPDIR_ROOT/ran"; }
    section_two() { false; echo "after false" >> "$TMPDIR_ROOT/ran"; }
    section_three() { skip_section "not today"; }
}

test_list_prints_sections_in_order() {
    setup_test "--list prints sections"
    load_lib
    assert_eq "$(printf 'one\ntwo\nthree')" "$(parse_section_args --list)" "list output"
    teardown_test
}

test_only_and_skip_select_sections() {
    setup_test "--only / --skip"
    load_lib
    parse_section_args --only one,three
    assert_eq "one three" "${SELECTED_SECTIONS[*]}" "--only"
    parse_section_args --skip two
    assert_eq "one three" "${SELECTED_SECTIONS[*]}" "--skip"
    parse_section_args --only=two
    assert_eq "two" "${SELECTED_SECTIONS[*]}" "--only="
    teardown_test
}

test_unknown_section_is_an_error() {
    setup_test "unknown section"
    load_lib
    local out status
    out="$(parse_section_args --only nope 2>&1)"; status=$?
    assert_eq 2 "$status" "exit status"
    assert_contains "$out" "unknown section: nope" "message"
    teardown_test
}

test_failing_command_stops_its_section() {
    setup_test "failing command stops its section"
    load_lib
    local status
    # Called as a plain command (not in an if/&&/|| list, where bash ignores
    # set -e all the way down), from a caller that uses errexit.
    (
        set -e  # the runner must work whether or not the caller uses errexit
        trap 'printf "%s\n" "${SECTION_RESULTS[@]}" > "$TMPDIR_ROOT/results"' EXIT
        run_sections one two three > "$TMPDIR_ROOT/out" 2>&1
    )
    status=$?
    assert_eq 1 "$status" "run_sections status"
    assert_eq "ran one" "$(cat "$TMPDIR_ROOT/ran")" "two stopped at false"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "two" "summary lists two"
    assert_contains "$(cat "$TMPDIR_ROOT/results")" "one|ok" "one ok"
    assert_contains "$(cat "$TMPDIR_ROOT/results")" "two|failed" "two failed"
    assert_contains "$(cat "$TMPDIR_ROOT/results")" "three|skipped" "three skipped"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "not today" "skip reason printed"
    teardown_test
}

test_run_sections_refuses_a_context_that_ignores_errexit() {
    setup_test "run_sections refuses an if/&&/|| context"
    load_lib
    local out status
    out="$(run_sections one two three 2>&1 && echo "returned 0")"; status=$?
    assert_eq 2 "$status" "status"
    assert_contains "$out" "set -e" "explains why"
    assert_eq no "$([ -e "$TMPDIR_ROOT/ran" ] && echo yes || echo no)" "no section ran"
    teardown_test
}

test_has_nvidia_gpu_reads_sysfs() {
    setup_test "has_nvidia_gpu"
    load_lib
    local root="$TMPDIR_ROOT/pci" r
    mkdir -p "$root/0000:00:02.0" "$root/0000:01:00.1"
    echo 0x8086 > "$root/0000:00:02.0/vendor"; echo 0x030000 > "$root/0000:00:02.0/class"
    echo 0x10de > "$root/0000:01:00.1/vendor"; echo 0x040300 > "$root/0000:01:00.1/class"
    SYSFS_PCI_DEVICES="$root" has_nvidia_gpu && r=yes || r=no
    assert_eq no "$r" "Intel GPU + NVIDIA audio function only"
    mkdir -p "$root/0000:01:00.0"
    echo 0x10de > "$root/0000:01:00.0/vendor"; echo 0x030000 > "$root/0000:01:00.0/class"
    SYSFS_PCI_DEVICES="$root" has_nvidia_gpu && r=yes || r=no
    assert_eq yes "$r" "NVIDIA VGA"
    SYSFS_PCI_DEVICES="$TMPDIR_ROOT/empty" has_nvidia_gpu && r=yes || r=no
    assert_eq no "$r" "no PCI tree"
    teardown_test
}

test_needs_install() {
    setup_test "needs_install"
    load_lib
    local r
    printf '#!/bin/sh\necho "tool version 1.2.3"\n' > "$FAKE_BIN/tool"; chmod +x "$FAKE_BIN/tool"
    needs_install tool 1.2.3 && r=yes || r=no; assert_eq no "$r" "pinned version installed"
    needs_install tool 1.2.4 && r=yes || r=no; assert_eq yes "$r" "other version installed"
    needs_install no-such-tool 1.0 && r=yes || r=no; assert_eq yes "$r" "missing"
    printf '#!/bin/sh\n[ "$1" = version ] && echo "go1.27.2"\n' > "$FAKE_BIN/gofake"; chmod +x "$FAKE_BIN/gofake"
    needs_install gofake 1.27.2 version && r=yes || r=no; assert_eq no "$r" "custom version args"
    teardown_test
}

test_guards_honour_overrides() {
    setup_test "has_systemd / is_amd64"
    load_lib
    local r
    SYSTEMD_RUN_DIR="$TMPDIR_ROOT/nope" has_systemd && r=yes || r=no; assert_eq no "$r" "no systemd dir"
    mkdir -p "$TMPDIR_ROOT/sd"
    SYSTEMD_RUN_DIR="$TMPDIR_ROOT/sd" has_systemd && r=yes || r=no; assert_eq yes "$r" "systemd dir"
    SETUP_MACHINE=aarch64 is_amd64 && r=yes || r=no; assert_eq no "$r" "aarch64"
    SETUP_MACHINE=x86_64 is_amd64 && r=yes || r=no; assert_eq yes "$r" "x86_64"
    teardown_test
}

test_list_prints_sections_in_order
test_only_and_skip_select_sections
test_unknown_section_is_an_error
test_failing_command_stops_its_section
test_run_sections_refuses_a_context_that_ignores_errexit
test_has_nvidia_gpu_reads_sysfs
test_needs_install
test_guards_honour_overrides
summary

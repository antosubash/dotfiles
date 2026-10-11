#!/usr/bin/env bash
# Tests for scripts/nvidia-kernel-guard.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/nvidia-kernel-guard.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

# Fake system: kernels in $TMPDIR_ROOT/boot, modules in $TMPDIR_ROOT/modules,
# dpkg-query reports $FAKE_DRIVER, apt-cache knows $FAKE_PUBLISHED, and
# sudo apt-get install drops an nvidia.ko into the matching kernel's tree.
setup_fake_system() {
    export NVIDIA_GUARD_BOOT_DIR="$TMPDIR_ROOT/boot"
    export NVIDIA_GUARD_MODULES_DIR="$TMPDIR_ROOT/modules"
    export FAKE_DRIVER="${1:-}" FAKE_PUBLISHED="${2:-}"
    export APT_LOG="$TMPDIR_ROOT/apt.log"
    mkdir -p "$NVIDIA_GUARD_BOOT_DIR" "$NVIDIA_GUARD_MODULES_DIR"
    : > "$APT_LOG"

    cat > "$FAKE_BIN/dpkg-query" <<'EOF'
#!/usr/bin/env bash
[ -n "$FAKE_DRIVER" ] && printf 'install ok installed %s\n' "$FAKE_DRIVER"
exit 0
EOF
    cat > "$FAKE_BIN/apt-cache" <<'EOF'
#!/usr/bin/env bash
[ "$2" = "$FAKE_PUBLISHED" ]
EOF
    cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
"$@"
EOF
    cat > "$FAKE_BIN/apt-get" <<'EOF'
#!/usr/bin/env bash
pkg="${!#}"
printf '%s\n' "$*" >> "$APT_LOG"
kver="${pkg##*-open-}"
mkdir -p "$NVIDIA_GUARD_MODULES_DIR/$kver/kernel/nvidia"
: > "$NVIDIA_GUARD_MODULES_DIR/$kver/kernel/nvidia/nvidia.ko"
EOF
    cat > "$FAKE_BIN/logger" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$FAKE_BIN"/*
}

add_kernel() {
    : > "$NVIDIA_GUARD_BOOT_DIR/vmlinuz-$1"
    mkdir -p "$NVIDIA_GUARD_MODULES_DIR/$1/kernel"
    if [ "${2:-}" = with-nvidia ]; then
        mkdir -p "$NVIDIA_GUARD_MODULES_DIR/$1/kernel/nvidia-595-open"
        : > "$NVIDIA_GUARD_MODULES_DIR/$1/kernel/nvidia-595-open/nvidia.ko"
    fi
}

run_guard() {
    OUTPUT="$(bash "$SCRIPT" "$@" 2>&1)"
    STATUS=$?
}

test_ok_when_newest_kernel_has_module() {
    setup_test "newest kernel has module"
    setup_fake_system nvidia-driver-595-open
    add_kernel 7.0.0-9-generic
    add_kernel 7.0.0-38-generic with-nvidia
    run_guard
    assert_eq 0 "$STATUS" "exit status"
    assert_contains "$OUTPUT" "present for kernel 7.0.0-38-generic" "ok message"
    run_guard -q
    assert_eq "" "$OUTPUT" "quiet output"
    teardown_test
}

test_fails_when_newest_kernel_lacks_module() {
    # Reproduces 2026-10-09: apt upgrade installed 7.0.0-38 but held back its module
    setup_test "newest kernel lacks module"
    setup_fake_system nvidia-driver-595-open linux-modules-nvidia-595-open-7.0.0-38-generic
    add_kernel 7.0.0-34-generic with-nvidia
    add_kernel 7.0.0-38-generic
    run_guard -q
    assert_eq 1 "$STATUS" "exit status"
    assert_contains "$OUTPUT" "Kernel 7.0.0-38-generic has no NVIDIA module" "warning"
    assert_contains "$OUTPUT" "sudo apt full-upgrade" "fix hint"
    assert_eq "" "$(cat "$APT_LOG")" "no install without --fix"
    teardown_test
}

test_fix_installs_missing_module_package() {
    setup_test "--fix installs module package"
    setup_fake_system nvidia-driver-595-open linux-modules-nvidia-595-open-7.0.0-38-generic
    add_kernel 7.0.0-34-generic with-nvidia
    add_kernel 7.0.0-38-generic
    run_guard --fix
    assert_eq 0 "$STATUS" "exit status"
    assert_contains "$(cat "$APT_LOG")" "install -y linux-modules-nvidia-595-open-7.0.0-38-generic" "apt-get call"
    teardown_test
}

test_fix_fails_when_module_not_published() {
    setup_test "--fix with unpublished module"
    setup_fake_system nvidia-driver-595-open
    add_kernel 7.0.0-38-generic
    run_guard --fix
    assert_eq 1 "$STATUS" "exit status"
    assert_contains "$OUTPUT" "isn't published yet" "unpublished hint"
    assert_eq "" "$(cat "$APT_LOG")" "no install attempted"
    teardown_test
}

test_noop_without_nvidia_driver() {
    setup_test "no NVIDIA driver"
    setup_fake_system ""
    add_kernel 7.0.0-38-generic
    run_guard
    assert_eq 0 "$STATUS" "exit status"
    assert_eq "" "$OUTPUT" "no output"
    teardown_test
}

test_ok_when_newest_kernel_has_module
test_fails_when_newest_kernel_lacks_module
test_fix_installs_missing_module_package
test_fix_fails_when_module_not_published
test_noop_without_nvidia_driver
summary

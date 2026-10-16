#!/usr/bin/env bash
# Tests for scripts/setup-dev-tuning.sh (boot-chain step)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/setup-dev-tuning.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

# The script reads the host (fstab, RAPL sysfs, docker/jq on PATH), so every
# input is pinned here: fstab and RAPL point at fixtures, and docker and jq are
# fakes, so results do not depend on the machine running the tests.
#
# Fakes: sudo only logs (and drains stdin for tee), systemctl reports
# NetworkManager-wait-online as $WAIT_ONLINE_STATE, systemd-analyze prints a
# chain. sudo and systemd-analyze calls share $CALLS so order can be checked.
setup_fake_system() {
    export DEV_TUNING_CHASSIS_FILE="$TMPDIR_ROOT/chassis_type"
    export DEV_TUNING_FSTAB="$TMPDIR_ROOT/fstab"
    export DEV_TUNING_RAPL_DIR="$TMPDIR_ROOT/no-rapl"
    export CALLS="$TMPDIR_ROOT/calls"
    printf '%s\n' 'UUID=abc / ext4 defaults 0 1' > "$DEV_TUNING_FSTAB"
    export WAIT_ONLINE_STATE="$2"
    printf '%s\n' "$1" > "$DEV_TUNING_CHASSIS_FILE"
    : > "$CALLS"

    cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$CALLS"
[ "$1" = tee ] && cat > /dev/null
exit 0
EOF
    cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
    *is-enabled*NetworkManager-wait-online*) [ "$WAIT_ONLINE_STATE" = enabled ] ;;
    *is-active*) exit 1 ;;
    *) exit 0 ;;
esac
EOF
    cat > "$FAKE_BIN/systemd-analyze" <<'EOF'
#!/usr/bin/env bash
printf 'systemd-analyze %s\n' "$*" >> "$CALLS"
echo "docker.service +2.021s"
echo "└─network-online.target @11.199s"
echo "  └─NetworkManager-wait-online.service @3.510s +7.688s"
EOF
    cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat > "$FAKE_BIN/jq" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
echo '{}'
EOF
    cat > "$FAKE_BIN/dpkg" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$FAKE_BIN"/*
}

run_tuning() {
    OUTPUT="$(bash "$SCRIPT" "$@" 2>&1)"
    STATUS=$?
}

DISABLE="sudo systemctl disable NetworkManager-wait-online.service"

test_desktop_disables_wait_online() {
    setup_test "desktop chassis disables wait-online"
    setup_fake_system 3 enabled
    run_tuning
    assert_eq 0 "$STATUS" "exit status"
    assert_contains "$(cat "$CALLS")" "$DISABLE" "disable called"
    assert_contains "$OUTPUT" "NetworkManager-wait-online.service @3.510s +7.688s" "critical chain printed"
    assert_contains "$OUTPUT" "sudo systemctl enable NetworkManager-wait-online.service" "revert note"
    local chain_line disable_line
    chain_line="$(grep -n 'critical-chain docker.service' "$CALLS" | cut -d: -f1)"
    disable_line="$(grep -nF "$DISABLE" "$CALLS" | cut -d: -f1)"
    assert_eq 1 "$([ -n "$chain_line" ] && [ -n "$disable_line" ] && [ "$chain_line" -lt "$disable_line" ] && echo 1)" "chain recorded before the change"
    teardown_test
}

test_laptop_keeps_wait_online() {
    setup_test "laptop chassis keeps wait-online"
    setup_fake_system 10 enabled
    run_tuning
    assert_eq 0 "$STATUS" "exit status"
    assert_not_contains "$(cat "$CALLS")" "$DISABLE" "disable not called"
    teardown_test
}

test_desktop_flag_overrides_chassis() {
    setup_test "--desktop flag on a non-desktop chassis"
    setup_fake_system 10 enabled
    run_tuning --desktop
    assert_eq 0 "$STATUS" "exit status"
    assert_contains "$(cat "$CALLS")" "$DISABLE" "disable called"
    teardown_test
}

test_already_disabled_is_left_alone() {
    setup_test "wait-online already disabled"
    setup_fake_system 3 disabled
    run_tuning
    assert_eq 0 "$STATUS" "exit status"
    assert_not_contains "$(cat "$CALLS")" "$DISABLE" "disable not called again"
    assert_contains "$OUTPUT" "already disabled" "says so"
    teardown_test
}

test_network_mount_keeps_wait_online() {
    setup_test "network mount in fstab keeps wait-online"
    setup_fake_system 3 enabled
    printf '%s\n' '//server/share /mnt cifs credentials=/root/.smb 0 0' >> "$DEV_TUNING_FSTAB"
    run_tuning
    assert_eq 0 "$STATUS" "exit status"
    assert_not_contains "$(cat "$CALLS")" "$DISABLE" "disable not called"
    assert_contains "$OUTPUT" "Network mounts in fstab" "says so"
    teardown_test
}

test_desktop_disables_wait_online
test_laptop_keeps_wait_online
test_desktop_flag_overrides_chassis
test_already_disabled_is_left_alone
test_network_mount_keeps_wait_online
summary

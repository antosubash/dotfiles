#!/usr/bin/env bash
# Tests for scripts/rgb-off.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/rgb-off.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

# Fake openrgb. Detection pass N prints $RGB_FAKE/list.N (or $RGB_FAKE/list).
# Apply call N reads the device count line N of $RGB_FAKE/counts (or its last
# line) and, like OpenRGB, rejects the whole call with "Empty device ID" when
# any --device index is out of range. Successful calls log each device to
# $RGB_FAKE/applied; every call is logged to $RGB_FAKE/calls.
setup_fake_openrgb() {
    export RGB_FAKE="$TMPDIR_ROOT/openrgb"
    export RGB_OFF_RETRY_SLEEP=0
    mkdir -p "$RGB_FAKE"
    : > "$RGB_FAKE/calls"
    : > "$RGB_FAKE/applied"

    cat > "$FAKE_BIN/openrgb" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RGB_FAKE/calls"
next() {
    local n=$(( $(cat "$RGB_FAKE/$1.n" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$RGB_FAKE/$1.n"
    echo "$n"
}
case " $* " in
    *" --list-devices "*)
        n="$(next list)"
        f="$RGB_FAKE/list.$n"
        [ -f "$f" ] || f="$RGB_FAKE/list"
        cat "$f"
        exit 0
        ;;
esac
n="$(next apply)"
count="$(sed -n "${n}p" "$RGB_FAKE/counts")"
[ -n "$count" ] || count="$(tail -n 1 "$RGB_FAKE/counts")"
devices=()
prev=""
for a in "$@"; do
    [ "$prev" = --device ] && devices+=("$a")
    prev="$a"
done
for d in "${devices[@]}"; do
    if [ "$d" -ge "$count" ]; then
        echo "Error: Empty device ID"
        echo 'Run `OpenRGB --help` for syntax'
        exit 255
    fi
done
printf '%s\n' "${devices[@]}" >> "$RGB_FAKE/applied"
EOF
    chmod +x "$FAKE_BIN/openrgb"
}

# write_list FILE N: a device list with N devices (0..N-1, at most 4), shaped
# like real OpenRGB output, with the I2C HTML warning on stdout ahead of it.
write_list() {
    local file="$1" n="$2"
    {
        printf '%s' "<h2>Some internal devices may not be detected:</h2><p>One or more I2C or SMBus interfaces failed to initialize.</p>"
        [ "$n" -gt 0 ] && cat <<'EOF'
0: MSI GeForce RTX 4080 Gaming X Trio
  Type:           GPU
  Modes: [Off] Direct 'Rainbow Wave' Breathing
  Zones: GPU

EOF
        [ "$n" -gt 1 ] && cat <<'EOF'
1: ASUS ROG STRIX Z790-F GAMING WIFI
  Type:           Motherboard
  Modes: [Direct] Off Static Breathing 'Spectrum Cycle'
  Zones: 'Aura Mainboard'

EOF
        [ "$n" -gt 2 ] && cat <<'EOF'
2: ENE DRAM
  Type:           DRAM
  Modes: [Direct] Breathing 'Color Cycle'
  Zones: DRAM

EOF
        [ "$n" -gt 3 ] && cat <<'EOF'
3: Generic Strip
  Type:           LEDStrip
  Modes: [Static] Breathing
  Zones: Strip

EOF
        [ "$n" -eq 0 ] && echo
    } > "$file"
}

set_counts() {
    printf '%s\n' "$@" > "$RGB_FAKE/counts"
}

run_rgb_off() {
    OUTPUT="$(bash "$SCRIPT" 2>&1)"
    STATUS=$?
    APPLY_CALLS="$(grep -vc -- --list-devices "$RGB_FAKE/calls")"
    LIST_CALLS="$(grep -c -- --list-devices "$RGB_FAKE/calls")"
    APPLIED="$(sort -n "$RGB_FAKE/applied" | tr '\n' ' ')"
}

test_stable_devices_use_one_call() {
    setup_test "stable device list: one apply call"
    setup_fake_openrgb
    write_list "$RGB_FAKE/list" 4
    set_counts 4
    run_rgb_off
    assert_eq 0 "$STATUS" "exit status"
    assert_eq 1 "$LIST_CALLS" "detection passes"
    assert_eq 1 "$APPLY_CALLS" "apply calls"
    assert_eq "0 1 2 3 " "$APPLIED" "devices turned off"
    assert_contains "$(grep -v -- --list-devices "$RGB_FAKE/calls")" \
        "--noautoconnect --device 0 --mode off --device 1 --mode off --device 2 --mode direct --color 000000 --device 3 --mode static --color 000000" \
        "mode chosen per device"
    teardown_test
}

test_retry_redetects_after_count_drop() {
    # Reproduces 2026-10-16: args from a 6-device pass, I2C timed out in the
    # apply pass, fewer devices showed up, OpenRGB failed with Empty device ID.
    setup_test "count drops between passes: retry re-detects"
    setup_fake_openrgb
    write_list "$RGB_FAKE/list.1" 4
    write_list "$RGB_FAKE/list" 3
    set_counts 3
    run_rgb_off
    assert_eq 0 "$STATUS" "exit status"
    assert_eq 2 "$LIST_CALLS" "detection passes"
    assert_eq 2 "$APPLY_CALLS" "apply calls"
    assert_eq "0 1 2 " "$APPLIED" "devices turned off"
    assert_not_contains "$(tail -n 1 "$RGB_FAKE/calls")" "--device 3" "retry uses fresh detection"
    teardown_test
}

test_per_device_fallback_after_combined_calls_fail() {
    setup_test "every combined call fails: per-device fallback"
    setup_fake_openrgb
    write_list "$RGB_FAKE/list" 4
    set_counts 2
    run_rgb_off
    assert_eq 0 "$STATUS" "exit status"
    assert_eq 3 "$LIST_CALLS" "detection passes"
    assert_eq 7 "$APPLY_CALLS" "3 combined + 4 per-device calls"
    assert_eq "0 1 " "$APPLIED" "devices turned off"
    assert_contains "$OUTPUT" "2 of 4" "failure count reported"
    teardown_test
}

test_fails_when_no_device_turned_off() {
    setup_test "per-device fallback turns nothing off"
    setup_fake_openrgb
    write_list "$RGB_FAKE/list" 2
    set_counts 0
    run_rgb_off
    assert_eq 1 "$STATUS" "exit status"
    assert_eq 5 "$APPLY_CALLS" "3 combined + 2 per-device calls"
    assert_contains "$OUTPUT" "0: MSI GeForce RTX 4080 Gaming X Trio" "device list printed"
    teardown_test
}

test_fails_when_no_devices_detected() {
    setup_test "no devices detected"
    setup_fake_openrgb
    write_list "$RGB_FAKE/list" 0
    set_counts 0
    run_rgb_off
    assert_eq 1 "$STATUS" "exit status"
    assert_eq 3 "$LIST_CALLS" "detection passes"
    assert_eq 0 "$APPLY_CALLS" "apply calls"
    assert_contains "$OUTPUT" "found no RGB devices" "error message"
    assert_contains "$OUTPUT" "One or more I2C or SMBus interfaces failed" "device list printed"
    teardown_test
}

test_fallback_uses_last_detected_devices() {
    # Tries 1-2 see devices and fail; try 3 detects nothing. The per-device
    # fallback must still run with the devices from the last detection that found any.
    setup_test "last detection empty: fallback uses the earlier devices"
    setup_fake_openrgb
    write_list "$RGB_FAKE/list.1" 2
    write_list "$RGB_FAKE/list.2" 2
    write_list "$RGB_FAKE/list" 0
    set_counts 1
    run_rgb_off
    assert_eq 0 "$STATUS" "exit status"
    assert_eq 3 "$LIST_CALLS" "detection passes"
    assert_eq 4 "$APPLY_CALLS" "2 combined + 2 per-device calls"
    assert_eq "0 " "$APPLIED" "devices turned off"
    assert_contains "$OUTPUT" "1 of 2" "failure count reported"
    teardown_test
}

test_openrgb_calls_are_killed_after_their_timeout() {
    # A hung openrgb that ignores SIGTERM must still end, so every call gets -k.
    setup_test "every openrgb call has a kill timeout"
    setup_fake_openrgb
    cat > "$FAKE_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RGB_FAKE/timeouts"
while [[ "$1" == -* ]]; do if [ "$1" = -k ]; then shift 2; else shift; fi; done
shift
exec "$@"
EOF
    chmod +x "$FAKE_BIN/timeout"
    write_list "$RGB_FAKE/list" 2
    set_counts 1
    run_rgb_off
    assert_eq 0 "$STATUS" "exit status"
    assert_eq 8 "$(wc -l < "$RGB_FAKE/timeouts")" "3 detections, 3 combined and 2 per-device calls"
    assert_eq "" "$(grep -v '^-k 5 [0-9]* openrgb ' "$RGB_FAKE/timeouts")" "each starts with -k 5"
    teardown_test
}

test_stable_devices_use_one_call
test_fallback_uses_last_detected_devices
test_openrgb_calls_are_killed_after_their_timeout
test_retry_redetects_after_count_drop
test_per_device_fallback_after_combined_calls_fail
test_fails_when_no_device_turned_off
test_fails_when_no_devices_detected
summary

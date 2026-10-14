#!/usr/bin/env bash
# Tests for scripts/bt-own-address.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/bt-own-address.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

# Fake btmgmt keeps the adapter address and power state in $BT_STATE and logs
# every call. public-addr is rejected while powered, like the kernel does, and
# it hangs when stdin is /dev/null, like the real btmgmt under systemd.
setup_fake_adapter() {
    export BT_STATE="$TMPDIR_ROOT/bt"
    export BT_LOG="$TMPDIR_ROOT/btmgmt.log"
    export BT_OWN_ADDRESS_CONF="$TMPDIR_ROOT/bt-own-address.conf"
    export BT_OWN_ADDRESS_MARKER="$TMPDIR_ROOT/bt-own-address.failed"
    export BT_OWN_ADDRESS_WAIT=5
    mkdir -p "$BT_STATE"
    printf '%s\n' "$1" > "$BT_STATE/addr"
    printf '%s\n' "$1" > "$BT_STATE/factory"
    : > "$BT_STATE/stuck"
    printf '%s\n' "${2:-on}" > "$BT_STATE/power"
    : > "$BT_LOG"

    cat > "$FAKE_BIN/btmgmt" <<'EOF'
#!/usr/bin/env bash
[ "$(readlink /proc/self/fd/0)" = /dev/null ] && exec sleep 30
shift 2  # --index N
printf '%s\n' "$*" >> "$BT_LOG"
case "$1" in
    info)
        [ -n "$(cat "$BT_STATE/addr")" ] || exit 1
        settings="bondable ssp br/edr le"
        [ "$(cat "$BT_STATE/power")" = on ] && settings="powered $settings"
        printf 'hci0:\tPrimary controller\n'
        printf '\taddr %s version 13 manufacturer 2 class 0x7c0104\n' "$(cat "$BT_STATE/addr")"
        printf '\tsupported settings: powered connectable bondable\n'
        printf '\tcurrent settings: %s\n' "$settings"
        ;;
    power) printf '%s\n' "$2" > "$BT_STATE/power" ;;
    public-addr)
        [ "$(cat "$BT_STATE/power")" = off ] || { echo "Rejected"; exit 1; }
        # A stuck adapter drops out of mgmt and never comes back
        if [ -s "$BT_STATE/stuck" ]; then : > "$BT_STATE/addr"; else printf '%s\n' "$2" > "$BT_STATE/addr"; fi
        ;;
esac
EOF
    chmod +x "$FAKE_BIN/btmgmt"

    # Reloading btusb brings the adapter back on its factory address
    cat > "$FAKE_BIN/modprobe" <<'EOF'
#!/usr/bin/env bash
printf 'modprobe %s\n' "$*" >> "$BT_LOG"
[ "$1" = -r ] || { cp "$BT_STATE/factory" "$BT_STATE/addr"; : > "$BT_STATE/stuck"; }
EOF
    chmod +x "$FAKE_BIN/modprobe"
}

run_script() {
    # systemd runs the service with stdin on /dev/null
    OUTPUT="$(bash "$SCRIPT" "$@" 2>&1 < /dev/null)"
    STATUS=$?
}

test_derive_flips_top_bit_of_last_octet() {
    setup_test "derive address"
    run_script --derive 00:1a:7d:da:71:fe
    assert_eq "00:1A:7D:DA:71:7E" "$OUTPUT" "derived from FE"
    run_script --derive 00:1A:7D:DA:71:05
    assert_eq "00:1A:7D:DA:71:85" "$OUTPUT" "derived from 05"
    teardown_test
}

test_sets_address_from_conf_on_powered_adapter() {
    setup_test "sets address from conf"
    setup_fake_adapter 00:1A:7D:DA:71:FE on
    printf 'FACTORY_ADDRESS=00:1A:7D:DA:71:FE\nADDRESS=00:1A:7D:DA:71:7E\n' > "$BT_OWN_ADDRESS_CONF"
    run_script
    assert_eq 0 "$STATUS" "exit status"
    assert_eq "00:1A:7D:DA:71:7E" "$(cat "$BT_STATE/addr")" "adapter address"
    assert_eq "on" "$(cat "$BT_STATE/power")" "powered back on"
    assert_contains "$(cat "$BT_LOG")" "power off" "powered off first"
    assert_contains "$OUTPUT" "now uses 00:1A:7D:DA:71:7E" "message"
    teardown_test
}

test_leaves_unpowered_adapter_off() {
    setup_test "unpowered adapter at boot"
    setup_fake_adapter 00:1A:7D:DA:71:FE off
    run_script 00:1a:7d:da:71:7e
    assert_eq 0 "$STATUS" "exit status"
    assert_eq "00:1A:7D:DA:71:7E" "$(cat "$BT_STATE/addr")" "adapter address"
    assert_eq "off" "$(cat "$BT_STATE/power")" "still off"
    assert_not_contains "$(cat "$BT_LOG")" "power" "no power changes"
    teardown_test
}

test_noop_when_address_already_set() {
    setup_test "already set"
    setup_fake_adapter 00:1A:7D:DA:71:7E on
    run_script 00:1A:7D:DA:71:7E
    assert_eq 0 "$STATUS" "exit status"
    assert_contains "$OUTPUT" "already uses" "message"
    assert_not_contains "$(cat "$BT_LOG")" "public-addr" "no change"
    teardown_test
}

test_noop_without_conf_or_adapter() {
    setup_test "no conf, no adapter"
    setup_fake_adapter "" on
    run_script
    assert_eq 0 "$STATUS" "no conf exit status"
    assert_contains "$OUTPUT" "nothing to do" "no conf message"
    run_script 00:1A:7D:DA:71:7E
    assert_eq 0 "$STATUS" "no adapter exit status"
    assert_contains "$OUTPUT" "hci0 not found" "no adapter message"
    teardown_test
}

test_rejects_invalid_address() {
    setup_test "invalid address"
    setup_fake_adapter 00:1A:7D:DA:71:FE on
    run_script 00:1A:7D:DA:71
    assert_eq 1 "$STATUS" "exit status"
    assert_eq "00:1A:7D:DA:71:FE" "$(cat "$BT_STATE/addr")" "unchanged"
    teardown_test
}

test_recovers_adapter_stuck_after_address_change() {
    setup_test "stuck adapter"
    setup_fake_adapter 00:1A:7D:DA:71:FE off
    echo 1 > "$BT_STATE/stuck"
    run_script 00:1A:7D:DA:71:7E
    assert_eq 1 "$STATUS" "exit status"
    assert_contains "$(cat "$BT_LOG")" "modprobe -r btusb" "driver unloaded"
    assert_contains "$(cat "$BT_LOG")" "modprobe btusb" "driver reloaded"
    assert_eq "00:1A:7D:DA:71:FE" "$(cat "$BT_STATE/addr")" "back on factory address"
    assert_eq 1 "$([ -e "$BT_OWN_ADDRESS_MARKER" ] && echo 1)" "marker written"
    assert_contains "$OUTPUT" "factory address" "message"
    teardown_test
}

test_skips_after_failure_this_boot() {
    setup_test "skips after failure"
    setup_fake_adapter 00:1A:7D:DA:71:FE on
    : > "$BT_OWN_ADDRESS_MARKER"
    run_script 00:1A:7D:DA:71:7E
    assert_eq 0 "$STATUS" "exit status"
    assert_eq "00:1A:7D:DA:71:FE" "$(cat "$BT_STATE/addr")" "unchanged"
    assert_not_contains "$(cat "$BT_LOG")" "public-addr" "no change attempted"
    assert_contains "$OUTPUT" "factory address" "message"
    teardown_test
}

test_waits_for_adapter_to_appear() {
    setup_test "adapter appears late"
    setup_fake_adapter "" off
    (sleep 0.2; echo 00:1A:7D:DA:71:FE > "$BT_STATE/addr") &
    run_script 00:1A:7D:DA:71:7E
    wait
    assert_eq 0 "$STATUS" "exit status"
    assert_eq "00:1A:7D:DA:71:7E" "$(cat "$BT_STATE/addr")" "adapter address"
    teardown_test
}

test_derive_flips_top_bit_of_last_octet
test_recovers_adapter_stuck_after_address_change
test_skips_after_failure_this_boot
test_waits_for_adapter_to_appear
test_sets_address_from_conf_on_powered_adapter
test_leaves_unpowered_adapter_off
test_noop_when_address_already_set
test_noop_without_conf_or_adapter
test_rejects_invalid_address
summary

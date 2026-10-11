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
    mkdir -p "$BT_STATE"
    printf '%s\n' "$1" > "$BT_STATE/addr"
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
        printf '%s\n' "$2" > "$BT_STATE/addr"
        ;;
esac
EOF
    chmod +x "$FAKE_BIN/btmgmt"
}

run_script() {
    # systemd runs the service with stdin on /dev/null
    OUTPUT="$(bash "$SCRIPT" "$@" 2>&1 < /dev/null)"
    STATUS=$?
}

test_derive_flips_top_bit_of_last_octet() {
    setup_test "derive address"
    run_script --derive 2c:0d:a7:d7:dc:fe
    assert_eq "2C:0D:A7:D7:DC:7E" "$OUTPUT" "derived from FE"
    run_script --derive 2C:0D:A7:D7:DC:05
    assert_eq "2C:0D:A7:D7:DC:85" "$OUTPUT" "derived from 05"
    teardown_test
}

test_sets_address_from_conf_on_powered_adapter() {
    setup_test "sets address from conf"
    setup_fake_adapter 2C:0D:A7:D7:DC:FE on
    printf 'FACTORY_ADDRESS=2C:0D:A7:D7:DC:FE\nADDRESS=2C:0D:A7:D7:DC:7E\n' > "$BT_OWN_ADDRESS_CONF"
    run_script
    assert_eq 0 "$STATUS" "exit status"
    assert_eq "2C:0D:A7:D7:DC:7E" "$(cat "$BT_STATE/addr")" "adapter address"
    assert_eq "on" "$(cat "$BT_STATE/power")" "powered back on"
    assert_contains "$(cat "$BT_LOG")" "power off" "powered off first"
    assert_contains "$OUTPUT" "now uses 2C:0D:A7:D7:DC:7E" "message"
    teardown_test
}

test_leaves_unpowered_adapter_off() {
    setup_test "unpowered adapter at boot"
    setup_fake_adapter 2C:0D:A7:D7:DC:FE off
    run_script 2c:0d:a7:d7:dc:7e
    assert_eq 0 "$STATUS" "exit status"
    assert_eq "2C:0D:A7:D7:DC:7E" "$(cat "$BT_STATE/addr")" "adapter address"
    assert_eq "off" "$(cat "$BT_STATE/power")" "still off"
    assert_not_contains "$(cat "$BT_LOG")" "power" "no power changes"
    teardown_test
}

test_noop_when_address_already_set() {
    setup_test "already set"
    setup_fake_adapter 2C:0D:A7:D7:DC:7E on
    run_script 2C:0D:A7:D7:DC:7E
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
    run_script 2C:0D:A7:D7:DC:7E
    assert_eq 0 "$STATUS" "no adapter exit status"
    assert_contains "$OUTPUT" "hci0 not found" "no adapter message"
    teardown_test
}

test_rejects_invalid_address() {
    setup_test "invalid address"
    setup_fake_adapter 2C:0D:A7:D7:DC:FE on
    run_script 2C:0D:A7:D7:DC
    assert_eq 1 "$STATUS" "exit status"
    assert_eq "2C:0D:A7:D7:DC:FE" "$(cat "$BT_STATE/addr")" "unchanged"
    teardown_test
}

test_derive_flips_top_bit_of_last_octet
test_sets_address_from_conf_on_powered_adapter
test_leaves_unpowered_adapter_off
test_noop_when_address_already_set
test_noop_without_conf_or_adapter
test_rejects_invalid_address
summary

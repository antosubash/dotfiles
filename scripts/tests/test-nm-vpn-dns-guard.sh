#!/usr/bin/env bash
# Tests for scripts/nm-vpn-dns-guard.sh
# Run: bash scripts/tests/test-nm-vpn-dns-guard.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/nm-vpn-dns-guard.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

ETH=eth-uuid
WIFI=wifi-uuid
LAN_UP='2: eno2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP'
VPN_DOWN='9: fctvpn1a2b: <NO-CARRIER,POINTOPOINT,MULTICAST,NOARP,UP> mtu 1500 state DOWN'
VPN_UP='9: fctvpn1a2b: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 state UNKNOWN'

# Fake nmcli/ip/logger/sleep backed by files in $STATE; nmcli calls go to $NM_LOG.
setup_guard() {
    setup_test "$1"
    STATE="$TMPDIR_ROOT/state"
    NM_LOG="$TMPDIR_ROOT/nmcli.log"
    mkdir -p "$STATE"
    : > "$NM_LOG"
    printf '%s\n' "$ETH:802-3-ethernet" "$WIFI:802-11-wireless" "vpn-uuid:tun" > "$STATE/profiles"
    printf '%s\n' "$LAN_UP" "$VPN_DOWN" > "$STATE/links"
    : > "$STATE/$WIFI.dns"; : > "$STATE/$WIFI.routes"; : > "$STATE/$WIFI.dev"
    echo eno2 > "$STATE/$ETH.dev"
    : > "$STATE/$ETH.routes"
    export STATE NM_LOG VPN_DNS_GUARD_GRACE_SECONDS=0

    cat > "$FAKE_BIN/nmcli" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$NM_LOG"
case "$*" in
    "-t -f UUID,TYPE con show") cat "$STATE/profiles" ;;
    "-g ipv4.dns con show "*) cat "$STATE/${*: -1}.dns" ;;
    "-g ipv4.routes con show "*) cat "$STATE/${*: -1}.routes" ;;
    "-g GENERAL.DEVICES con show "*) cat "$STATE/${*: -1}.dev" ;;
    "con modify "*) : > "$STATE/$3.dns" ;;
esac
EOF
    cat > "$FAKE_BIN/ip" <<'EOF'
#!/usr/bin/env bash
cat "$STATE/links"
EOF
    cat > "$FAKE_BIN/logger" <<'EOF'
#!/usr/bin/env bash
EOF
    # A pending links.next simulates the VPN tunnel finishing during the grace wait.
    cat > "$FAKE_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
[ -f "$STATE/links.next" ] && mv "$STATE/links.next" "$STATE/links"
exit 0
EOF
    chmod +x "$FAKE_BIN"/*
}

nm_log() { cat "$NM_LOG"; }

test_cleans_leaked_profile_when_vpn_down() {
    setup_guard "cleans leaked DNS and pinned default route when the VPN is down"
    echo "147.125.99.131,147.125.99.26" > "$STATE/$ETH.dns"
    echo "0.0.0.0/0 192.168.0.1 100 src=192.168.0.223, 10.1.0.0/16 192.168.0.1" > "$STATE/$ETH.routes"
    "$SCRIPT" fctvpn1a2b down > /dev/null
    assert_contains "$(nm_log)" "con modify $ETH ipv4.dns  ipv4.ignore-auto-dns no ipv6.dns  ipv6.ignore-auto-dns no" "resets DNS"
    assert_contains "$(nm_log)" "-ipv4.routes 0.0.0.0/0 192.168.0.1 100 src=192.168.0.223" "drops pinned default route"
    assert_not_contains "$(nm_log)" "-ipv4.routes 10.1.0.0/16" "keeps other routes"
    assert_contains "$(nm_log)" "device reapply eno2" "reapplies the active device"
    assert_not_contains "$(nm_log)" "con modify $WIFI" "leaves clean profiles alone"
    teardown_test
}
test_cleans_leaked_profile_when_vpn_down

test_skips_when_vpn_connected() {
    setup_guard "does nothing while the VPN is connected"
    echo "147.125.99.131" > "$STATE/$ETH.dns"
    printf '%s\n' "$LAN_UP" "$VPN_UP" > "$STATE/links"
    "$SCRIPT" eno2 up > /dev/null
    assert_not_contains "$(nm_log)" "con modify" "no modify"
    teardown_test
}
test_skips_when_vpn_connected

test_skips_when_vpn_comes_up_during_grace() {
    setup_guard "does nothing if the VPN finishes connecting during the grace wait"
    echo "147.125.99.131" > "$STATE/$ETH.dns"
    printf '%s\n' "$LAN_UP" "$VPN_UP" > "$STATE/links.next"
    VPN_DNS_GUARD_GRACE_SECONDS=3 "$SCRIPT" eno2 up > /dev/null
    assert_not_contains "$(nm_log)" "con modify" "no modify"
    teardown_test
}
test_skips_when_vpn_comes_up_during_grace

test_keeps_user_dns() {
    setup_guard "keeps DNS that does not belong to the VPN"
    echo "1.1.1.1,9.9.9.9" > "$STATE/$ETH.dns"
    "$SCRIPT" > /dev/null
    assert_not_contains "$(nm_log)" "con modify" "no modify"
    teardown_test
}
test_keeps_user_dns

test_ignores_unrelated_events() {
    setup_guard "ignores events other than VPN down and LAN up"
    echo "147.125.99.131" > "$STATE/$ETH.dns"
    "$SCRIPT" eno2 dhcp4-change > /dev/null
    "$SCRIPT" fctvpn1a2b up > /dev/null
    assert_eq "" "$(nm_log)" "nmcli never called"
    teardown_test
}
test_ignores_unrelated_events

test_falls_back_to_con_up_when_reapply_fails() {
    setup_guard "reconnects the profile when device reapply fails"
    echo "147.125.99.131" > "$STATE/$ETH.dns"
    sed -i 's/^case "\$\*" in$/[ "$1 $2" = "device reapply" ] \&\& exit 1\n&/' "$FAKE_BIN/nmcli"
    "$SCRIPT" eno2 up > /dev/null
    assert_contains "$(nm_log)" "con up $ETH" "falls back to con up"
    teardown_test
}
test_falls_back_to_con_up_when_reapply_fails

summary

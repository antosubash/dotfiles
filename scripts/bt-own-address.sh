#!/bin/bash

# Give the Bluetooth adapter its own address under Linux.
#
# On a Windows dual boot both systems use the adapter's factory address, so a
# headset stores one pairing key for "this PC". Pairing in Windows replaces the
# key Linux holds, and Linux then fails to connect with "Permission denied
# (13)". With a different address under Linux, the headset sees two separate
# devices and keeps a pairing for each.
#
# The address doesn't survive a reboot, so setup-bt-own-address.sh runs this
# from a systemd service (at boot and whenever the adapter appears).
#
# Usage: bt-own-address.sh [ADDRESS]   set ADDRESS (default: ADDRESS from the conf)
#        bt-own-address.sh --derive FACTORY_ADDRESS   print the Linux address
# Needs root (btmgmt).

set -u

CONF="${BT_OWN_ADDRESS_CONF:-/etc/bt-own-address.conf}"
INDEX="${BT_OWN_ADDRESS_INDEX:-0}"

# Flip the top bit of the last octet: fixed per machine, and clear of the
# Wi-Fi MAC, which sits a few addresses below the Bluetooth one.
derive_address() {
    local factory="${1^^}" last
    last="${factory##*:}"
    printf '%s:%02X\n' "${factory%:*}" $((0x$last ^ 0x80))
}

mgmt() {
    timeout 10 btmgmt --index "$INDEX" "$@"
}

current_address() {
    mgmt info 2>/dev/null | awk '$1 == "addr" { print toupper($2); exit }'
}

main() {
    if [ "${1:-}" = --derive ]; then
        derive_address "$2"
        return 0
    fi

    local target="${1:-}"
    if [ -z "$target" ]; then
        [ -r "$CONF" ] || { echo "No $CONF, nothing to do."; return 0; }
        # shellcheck source=/dev/null
        . "$CONF"
        target="${ADDRESS:-}"
    fi
    target="${target^^}"
    [[ "$target" =~ ^([0-9A-F]{2}:){5}[0-9A-F]{2}$ ]] || { echo "Invalid address: $target" >&2; return 1; }

    local current
    current="$(current_address)"
    if [ -z "$current" ]; then
        echo "hci$INDEX not found, nothing to do."
        return 0
    fi
    if [ "$current" = "$target" ]; then
        echo "hci$INDEX already uses $target"
        return 0
    fi

    # The kernel only accepts a new public address while the adapter is off
    local powered=false
    mgmt info 2>/dev/null | grep -Eq 'current settings:.*\bpowered\b' && powered=true
    [ "$powered" = true ] && mgmt power off > /dev/null

    mgmt public-addr "$target" > /dev/null || { echo "btmgmt public-addr failed" >&2; return 1; }

    # The adapter re-initialises with the new address
    local _
    for _ in $(seq 50); do
        [ "$(current_address)" = "$target" ] && break
        sleep 0.1
    done
    [ "$powered" = true ] && mgmt power on > /dev/null

    current="$(current_address)"
    if [ "$current" != "$target" ]; then
        echo "hci$INDEX still uses $current, wanted $target" >&2
        return 1
    fi
    echo "hci$INDEX now uses $target"
}

main "$@"

#!/bin/bash

# NetworkManager dispatcher hook: undo FortiClient VPN DNS left on the LAN.
#
# While connected, FortiClient writes its DNS servers (and a pinned default
# route) into the ethernet/Wi-Fi profiles and sets ignore-auto-dns. When the
# VPN drops uncleanly those edits stay saved, so name resolution on the LAN
# points at unreachable VPN servers and the link looks dead. This hook runs
# when the VPN interface goes down or a LAN interface comes up, and if the VPN
# is not connected it strips the leftovers and reapplies the profile.
#
# Installed by scripts/setup-vpn-dns-guard.sh. Run with no arguments to check
# and fix once by hand.
set -u

VPN_IFACE_PREFIX="${VPN_DNS_GUARD_IFACE_PREFIX:-fctvpn}"
# Space-separated address prefixes of the VPN's DNS servers.
LEAK_DNS_PREFIXES="${VPN_DNS_GUARD_DNS_PREFIXES:-147.125.}"
# Seconds to wait for a VPN that is still coming up before treating DNS as leaked.
GRACE_SECONDS="${VPN_DNS_GUARD_GRACE_SECONDS:-10}"

log() {
    logger -t vpn-dns-guard "$*" 2>/dev/null || true
    echo "vpn-dns-guard: $*"
}

vpn_connected() {
    ip -o link show 2>/dev/null | awk -v p="$VPN_IFACE_PREFIX" '
        { name = $2; sub(/:$/, "", name); sub(/@.*/, "", name) }
        index(name, p) == 1 && /LOWER_UP/ { found = 1 }
        END { exit !found }'
}

is_leaked_dns() {
    local dns="$1" prefix
    for prefix in $LEAK_DNS_PREFIXES; do
        case ",$dns" in *",$prefix"*) return 0 ;; esac
    done
    return 1
}

lan_profiles() {
    nmcli -t -f UUID,TYPE con show 2>/dev/null |
        awk -F: '$2 == "802-3-ethernet" || $2 == "802-11-wireless" { print $1 }'
}

leaked_profiles() {
    local uuid
    for uuid in $(lan_profiles); do
        is_leaked_dns "$(nmcli -g ipv4.dns con show "$uuid" 2>/dev/null)" && echo "$uuid"
    done
}

clean_profile() {
    local uuid="$1" route device
    local args=(ipv4.dns "" ipv4.ignore-auto-dns no ipv6.dns "" ipv6.ignore-auto-dns no)
    local IFS=','
    for route in $(nmcli -g ipv4.routes con show "$uuid" 2>/dev/null); do
        route="${route# }"
        case "$route" in 0.0.0.0/0\ *) args+=(-ipv4.routes "$route") ;; esac
    done
    unset IFS

    if ! nmcli con modify "$uuid" "${args[@]}"; then
        log "failed to clean profile $uuid"
        return 1
    fi
    log "removed leftover VPN DNS from profile $uuid"

    device="$(nmcli -g GENERAL.DEVICES con show "$uuid" 2>/dev/null)"
    [ -n "$device" ] || return 0
    nmcli device reapply "$device" >/dev/null 2>&1 ||
        nmcli con up "$uuid" >/dev/null 2>&1 ||
        log "failed to reapply profile $uuid on $device"
}

should_run() {
    local iface="${1:-}" action="${2:-}"
    [ -z "$action" ] && return 0
    case "$iface:$action" in
        "$VPN_IFACE_PREFIX"*:down) return 0 ;;
        "$VPN_IFACE_PREFIX"*:*) return 1 ;;
        *:up) return 0 ;;
    esac
    return 1
}

main() {
    should_run "$@" || return 0
    vpn_connected && return 0

    local leaked waited=0
    leaked="$(leaked_profiles)"
    [ -n "$leaked" ] || return 0

    # A VPN that is mid-connect writes its DNS before its tunnel is up.
    while [ "$waited" -lt "$GRACE_SECONDS" ]; do
        sleep 1
        waited=$((waited + 1))
        vpn_connected && return 0
    done

    local uuid
    for uuid in $(leaked_profiles); do
        clean_profile "$uuid"
    done
}

main "$@"

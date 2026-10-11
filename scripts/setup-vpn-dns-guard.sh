#!/bin/bash

# Stop a dropped FortiClient VPN from breaking LAN name resolution: install a
# NetworkManager dispatcher hook that removes VPN DNS left in the ethernet and
# Wi-Fi profiles, and make sure the FortiClient tray (which restores them on a
# clean disconnect) can start.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SRC="$SCRIPT_DIR/nm-vpn-dns-guard.sh"
HOOK_DEST="/etc/NetworkManager/dispatcher.d/90-vpn-dns-guard"

if [ -x /opt/forticlient/fortitray ] && ldd /opt/forticlient/fortitray | grep -q 'not found'; then
    echo "Installing missing FortiClient tray libraries..."
    sudo apt-get install -y libgtk2.0-0t64
fi

echo "Installing NetworkManager dispatcher hook to $HOOK_DEST..."
# NetworkManager only runs dispatcher scripts owned by root and not writable by others.
sudo install -o root -g root -m 0755 "$HOOK_SRC" "$HOOK_DEST"

echo "Checking current profiles for leftover VPN DNS..."
sudo env VPN_DNS_GUARD_GRACE_SECONDS=0 "$HOOK_DEST"

echo "Done. VPN DNS left on ethernet/Wi-Fi is now removed whenever the VPN goes down."

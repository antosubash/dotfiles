#!/bin/bash

# Install bt-own-address.sh as a boot service so Linux and Windows use
# different Bluetooth addresses on a dual boot machine and stop overwriting
# each other's headset pairings. See bt-own-address.sh.
#
# Usage: setup-bt-own-address.sh            install and apply now
#        setup-bt-own-address.sh --remove   restore the factory address and uninstall
set -e

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bt-own-address.sh"
BIN="/usr/local/sbin/bt-own-address"
CONF="/etc/bt-own-address.conf"
UNIT="/etc/systemd/system/bt-own-address.service"
RULE="/etc/udev/rules.d/90-bt-own-address.rules"

if [ "${1:-}" = --remove ]; then
    if [ -r "$CONF" ]; then
        # shellcheck source=/dev/null
        . "$CONF"
        sudo "$BIN" "$FACTORY_ADDRESS" || true
    fi
    sudo systemctl disable bt-own-address.service 2> /dev/null || true
    sudo rm -f "$BIN" "$CONF" "$UNIT" "$RULE"
    sudo systemctl daemon-reload
    sudo udevadm control --reload
    sudo systemctl restart bluetooth
    echo "Removed. Linux uses the factory Bluetooth address again."
    exit 0
fi

if [ -r "$CONF" ]; then
    # Already set up: keep the addresses (the adapter may already be renamed)
    # shellcheck source=/dev/null
    . "$CONF"
else
    FACTORY_ADDRESS="$(: | sudo btmgmt --index 0 info | awk '$1 == "addr" { print toupper($2); exit }')"
    if [ -z "$FACTORY_ADDRESS" ]; then
        echo "No Bluetooth adapter found (hci0)." >&2
        exit 1
    fi
    ADDRESS="$(bash "$SRC" --derive "$FACTORY_ADDRESS")"
    sudo tee "$CONF" > /dev/null <<EOF
# Written by ~/dotfiles/scripts/setup-bt-own-address.sh
# Windows keeps FACTORY_ADDRESS; Linux uses ADDRESS.
FACTORY_ADDRESS=$FACTORY_ADDRESS
ADDRESS=$ADDRESS
EOF
fi

echo "Installing $BIN..."
sudo install -m 0755 "$SRC" "$BIN"

echo "Installing bt-own-address.service..."
sudo tee "$UNIT" > /dev/null <<EOF
[Unit]
Description=Use a Linux-only Bluetooth address (dual boot pairing fix)
Before=bluetooth.service

[Service]
Type=oneshot
ExecStart=$BIN

[Install]
WantedBy=bluetooth.target
EOF

# Re-apply whenever the adapter (re)appears, e.g. after a USB reset
sudo tee "$RULE" > /dev/null <<'EOF'
ACTION=="add", SUBSYSTEM=="bluetooth", KERNEL=="hci0", TAG+="systemd", ENV{SYSTEMD_WANTS}+="bt-own-address.service"
EOF

sudo systemctl daemon-reload
sudo udevadm control --reload
sudo systemctl enable bt-own-address.service
sudo systemctl start bt-own-address.service
sudo systemctl restart bluetooth

echo ""
echo "Done. Windows keeps $FACTORY_ADDRESS, Linux now uses $ADDRESS."
echo "Pair your headsets once more in Linux; Windows pairings stay as they are."

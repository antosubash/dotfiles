#!/bin/bash

# Keep a desktop running 24/7 as a dev box: never suspend or hibernate, and
# watch disk health. Masking the sleep targets matters even with GNOME's idle
# suspend disabled: after a reboot the GDM login screen suspends an idle
# machine on its own, which drops SSH, Tailscale, and running containers.
set -e

echo "Disabling suspend and hibernate..."
sudo systemctl mask sleep.target suspend.target hibernate.target \
    hybrid-sleep.target suspend-then-hibernate.target

if command -v gsettings &> /dev/null && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    echo "Configuring GNOME to never suspend on AC power..."
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
else
    echo "Skipping GNOME settings (not in a GNOME session)."
fi

# Wake-on-LAN (magic packet) on every wired connection, so the machine can be
# powered on remotely. The BIOS must also keep the NIC powered while off
# (ASUS: APM Configuration > ErP Ready = Disabled, Power On By PCI-E = Enabled).
if command -v nmcli &> /dev/null; then
    echo "Enabling Wake-on-LAN on wired connections..."
    # UUIDs, not names: nmcli -t escapes ':' inside names.
    nmcli -t -f UUID,TYPE connection show | awk -F: '$2 == "802-3-ethernet" {print $1}' |
        while read -r uuid; do
            sudo nmcli connection modify "$uuid" 802-3-ethernet.wake-on-lan magic
        done
    # Apply to connected NICs now, without taking the link down.
    nmcli -t -f DEVICE,TYPE,STATE device | awk -F: '$2 == "ethernet" && $3 == "connected" {print $1}' |
        while read -r dev; do
            sudo nmcli device reapply "$dev"
        done
fi

echo "Installing disk health monitoring (smartd)..."
if ! command -v smartctl &> /dev/null; then
    # --no-install-recommends: the recommended mailutils would pull in an MTA.
    sudo apt install -y --no-install-recommends smartmontools
else
    echo "smartmontools is already installed."
fi
sudo systemctl enable --now smartmontools.service

echo ""
echo "Done. The machine will no longer suspend or hibernate."
echo "Also set in the BIOS: Advanced > APM Configuration > Restore AC Power Loss = Power On,"
echo "so it boots back up by itself after a power cut."

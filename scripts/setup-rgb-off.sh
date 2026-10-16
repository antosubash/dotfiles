#!/usr/bin/env bash

# Turn off all RGB lighting OpenRGB can reach (motherboard Aura, GPU, RAM) and
# keep it off across reboots. DDR RAM controllers in particular reset to their
# default rainbow on every power cycle, so a one-off change is not enough: a
# systemd service re-applies it at each boot. See rgb-off.sh.
set -e

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rgb-off.sh"

echo "Installing OpenRGB..."
if ! command -v openrgb &> /dev/null; then
    sudo apt install -y openrgb i2c-tools
else
    echo "OpenRGB is already installed."
fi

# GPU and RAM lighting sit on I2C/SMBus, which OpenRGB reaches through i2c-dev.
echo "Loading i2c-dev at boot..."
echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf > /dev/null
sudo modprobe i2c-dev
# Apply OpenRGB's udev rules now so the desktop user can also run it unprivileged.
sudo udevadm control --reload-rules
sudo udevadm trigger

echo "Installing /usr/local/sbin/rgb-off..."
sudo install -m 0755 "$SRC" /usr/local/sbin/rgb-off

echo "Installing rgb-off.service..."
sudo tee /etc/systemd/system/rgb-off.service > /dev/null <<'EOF'
[Unit]
Description=Turn off all RGB lighting (OpenRGB)
# i2c-dev must be loaded and the I2C/SMBus devices settled before detection.
After=systemd-modules-load.service systemd-udev-settle.service

[Service]
# exec, not oneshot: device detection takes ~10 s and nothing should wait on it.
Type=exec
# rgb-off puts a timeout on every openrgb call, so 3 detect-and-apply tries plus
# the one-device-at-a-time fallback finish within 10 minutes even if every call
# hangs; RuntimeMaxSec is the backstop. With Type=exec, TimeoutStartSec only
# covers starting the script, not the run itself.
TimeoutStartSec=180
RuntimeMaxSec=600
# Keep the I2C probing from competing with login.
Nice=10
# OpenRGB's CLI is a Qt app; keep it from looking for a display at boot.
Environment=QT_QPA_PLATFORM=offscreen
ExecStart=/usr/local/sbin/rgb-off

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable rgb-off.service

echo "Turning lights off now..."
# Run it directly: the exec-type service returns before OpenRGB finishes, and a
# second OpenRGB instance must not probe the devices at the same time. A failure
# here should not stop the device list and the notes below from printing.
if ! sudo QT_QPA_PLATFORM=offscreen /usr/local/sbin/rgb-off; then
    echo "rgb-off could not turn any device off (see its output above)."
fi
sudo openrgb --noautoconnect --list-devices 2>/dev/null | grep -E '^[0-9]+: |^ *Type:'

echo ""
echo "Done. Lighting is turned off at every boot by rgb-off.service."
echo "For the few seconds before Linux starts, set the BIOS Aura/LED option to"
echo "Stealth / off (motherboard LEDs only)."
echo "RAM missing from the list above is not reachable from Linux (on the ASUS"
echo "ROG STRIX Z790-F no DIMM answers on any SMBus): set its hardware lighting"
echo "to off once from the vendor tool in Windows (Corsair: iCUE > Hardware Lighting)."

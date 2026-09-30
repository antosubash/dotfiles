#!/bin/bash

# Turn off all RGB lighting OpenRGB can reach (motherboard Aura, GPU, RAM) and
# keep it off across reboots. DDR RAM controllers in particular reset to their
# default rainbow on every power cycle, so a one-off change is not enough: a
# oneshot systemd service re-applies it at each boot.
set -e

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
sudo tee /usr/local/sbin/rgb-off > /dev/null <<'EOF'
#!/bin/bash
# Turn off every device OpenRGB detects, in a single detection pass. Uses the
# device's "Off" mode when it has one; otherwise sets it to black, since not
# every controller offers "Off".
set -u

args=()
for _ in 1 2 3; do
    list="$(openrgb --noautoconnect --list-devices 2>/dev/null)"
    # Device headers look like "0: Name"; the mode list like "  Modes: [Direct] Off Static".
    # OpenRGB can print an HTML warning on stdout ahead of the first header, so
    # match headers anywhere on an unindented line, and never emit an empty index.
    while read -r idx modes; do
        if grep -qiw 'off' <<< "$modes"; then
            args+=(--device "$idx" --mode off)
        elif grep -qiw 'static' <<< "$modes"; then
            args+=(--device "$idx" --mode static --color 000000)
        else
            args+=(--device "$idx" --mode direct --color 000000)
        fi
    done < <(awk '!/^[ \t]/ && match($0, /[0-9]+: [^ ]/) {idx = substr($0, RSTART); sub(/:.*/, "", idx)}
        /^ *Modes:/ && idx != "" {sub(/^ *Modes: */, ""); print idx, $0}' <<< "$list")
    [ ${#args[@]} -gt 0 ] && break
    # Controllers (e.g. the NVIDIA I2C adapters) can appear late during boot.
    sleep 5
done

if [ ${#args[@]} -eq 0 ]; then
    echo "rgb-off: OpenRGB found no RGB devices. Device list was:" >&2
    echo "$list" >&2
    exit 1
fi
echo "rgb-off: openrgb ${args[*]}" >&2
exec openrgb --noautoconnect "${args[@]}"
EOF
sudo chmod 0755 /usr/local/sbin/rgb-off

echo "Installing rgb-off.service..."
sudo tee /etc/systemd/system/rgb-off.service > /dev/null <<'EOF'
[Unit]
Description=Turn off all RGB lighting (OpenRGB)
After=systemd-modules-load.service

[Service]
# exec, not oneshot: device detection takes ~10 s and nothing should wait on it.
Type=exec
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
# second OpenRGB instance must not probe the devices at the same time.
sudo QT_QPA_PLATFORM=offscreen /usr/local/sbin/rgb-off
sudo openrgb --noautoconnect --list-devices 2>/dev/null | grep -E '^[0-9]+: |^ *Type:'

echo ""
echo "Done. Lighting is turned off at every boot by rgb-off.service."
echo "For the few seconds before Linux starts, set the BIOS Aura/LED option to"
echo "Stealth / off (motherboard LEDs only)."
echo "RAM missing from the list above is not reachable from Linux (on the ASUS"
echo "ROG STRIX Z790-F no DIMM answers on any SMBus): set its hardware lighting"
echo "to off once from the vendor tool in Windows (Corsair: iCUE > Hardware Lighting)."

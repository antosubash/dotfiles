#!/bin/bash

# Tune an always-on Ubuntu desktop for development. Idempotent; each step is
# independent and reversible.
set -e

# 1. File watchers: the default 65536 watches / 128 instances run out with
#    VS Code, JetBrains, vite/webpack/jest watchers, and tsserver on big repos.
echo "Raising inotify limits..."
sudo tee /etc/sysctl.d/60-dev-inotify.conf > /dev/null <<'EOF'
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 1024
EOF
sudo sysctl -q -p /etc/sysctl.d/60-dev-inotify.conf

# 2. Docker: rotate container logs (json-file is unbounded by default) and keep
#    containers running while dockerd itself restarts or upgrades.
if command -v docker &> /dev/null; then
    echo "Configuring Docker log rotation and live-restore..."
    defaults='{"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}, "live-restore": true}'
    sudo mkdir -p /etc/docker
    if sudo test -f /etc/docker/daemon.json; then
        merged="$(sudo cat /etc/docker/daemon.json | jq --argjson d "$defaults" '. * $d')"
    else
        merged="$(jq -n --argjson d "$defaults" '$d')"
    fi
    echo "$merged" | sudo tee /etc/docker/daemon.json > /dev/null
    # Reload applies live-restore without stopping containers; log limits apply
    # to containers created after dockerd next restarts (e.g. the next boot).
    if systemctl is-active --quiet docker; then
        sudo systemctl reload docker
    fi
fi

# 3. kdump: reserves 1-2 GB of RAM for crash dumps and adds ~12 s to boot.
#    Only a Recommends of ubuntu-desktop-minimal, so removal is safe.
if dpkg -s kdump-tools &> /dev/null; then
    echo "Removing kdump (frees its crashkernel RAM reservation after reboot)..."
    sudo apt purge -y kdump-tools
    sudo update-grub
fi

# 4. Services with nothing to do on this machine.
echo "Disabling cups-browsed (network printer discovery) and ModemManager..."
for unit in cups-browsed.service ModemManager.service; do
    if systemctl list-unit-files "$unit" --no-legend | grep -q .; then
        sudo systemctl disable --now "$unit"
    fi
done

# 5. CPU power limits: older BIOSes on 13th/14th-gen Intel K CPUs leave the
#    short-term limit effectively unlimited (4095 W). Cap both limits at Intel's
#    253 W spec at every boot; limits already at or below it are left alone.
if [ -d /sys/class/powercap/intel-rapl:0 ]; then
    echo "Installing cpu-power-limit.service (253 W cap)..."
    sudo tee /usr/local/sbin/cpu-power-limit > /dev/null <<'EOF'
#!/bin/bash
# Cap RAPL package power limits (PL1/PL2) at 253 W, Intel's spec for 13th/14th-gen K CPUs.
set -u
limit_uw=253000000
status=0
for c in /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw \
         /sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw; do
    [ -w "$c" ] || continue
    if [ "$(cat "$c")" -gt "$limit_uw" ]; then
        echo "$limit_uw" > "$c" 2>/dev/null
        # The BIOS can lock these registers; report instead of failing silently.
        if [ "$(cat "$c")" -gt "$limit_uw" ]; then
            echo "cpu-power-limit: $c is locked by firmware; set the limit in the BIOS" >&2
            status=1
        fi
    fi
done
exit $status
EOF
    sudo chmod 0755 /usr/local/sbin/cpu-power-limit
    sudo tee /etc/systemd/system/cpu-power-limit.service > /dev/null <<'EOF'
[Unit]
Description=Cap CPU package power limits at 253 W

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/cpu-power-limit

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now cpu-power-limit.service
    for i in 0 1; do
        c=/sys/class/powercap/intel-rapl:0
        echo "  $(cat $c/constraint_${i}_name): $(( $(cat $c/constraint_${i}_power_limit_uw) / 1000000 )) W"
    done
fi

echo ""
echo "Done. Reboot to reclaim the kdump RAM reservation and apply Docker log limits."

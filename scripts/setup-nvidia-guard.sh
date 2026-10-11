#!/bin/bash

# Install nvidia-kernel-guard as an APT hook so every apt run (Software Updater,
# unattended-upgrades, a plain `apt upgrade`) warns when the newest kernel has
# no NVIDIA module, before you reboot into it. See nvidia-kernel-guard.sh.
set -e

GUARD_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nvidia-kernel-guard.sh"
GUARD_BIN="/usr/local/sbin/nvidia-kernel-guard"
HOOK_CONF="/etc/apt/apt.conf.d/99nvidia-kernel-guard"

if ! command -v apt-get &> /dev/null; then
    echo "Skipping NVIDIA kernel guard (not an APT system)."
    exit 0
fi

echo "Installing $GUARD_BIN..."
sudo install -m 0755 "$GUARD_SRC" "$GUARD_BIN"

echo "Installing APT hook $HOOK_CONF..."
sudo tee "$HOOK_CONF" > /dev/null <<EOF
// Warn when the newest kernel has no NVIDIA module (from ~/dotfiles).
DPkg::Post-Invoke { "if [ -x $GUARD_BIN ]; then $GUARD_BIN -q || true; fi"; };
EOF

"$GUARD_BIN"
echo "Done. apt will now warn if a kernel update leaves out the NVIDIA module."

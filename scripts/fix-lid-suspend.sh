#!/bin/bash

# Keep the machine awake when the lid is closed while on AC power, so SSH and
# other long-running sessions survive. Battery still suspends on lid close.
set -e

LOGIND_CONF="/etc/systemd/logind.conf.d/10-lid.conf"

echo "Configuring systemd-logind lid behavior..."
sudo install -d -m 0755 /etc/systemd/logind.conf.d
sudo tee "$LOGIND_CONF" > /dev/null <<'EOF'
[Login]
HandleLidSwitch=suspend
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF

echo "Restarting systemd-logind..."
sudo systemctl restart systemd-logind.service

if command -v gsettings &> /dev/null && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    echo "Configuring GNOME power lid actions..."
    gsettings set org.gnome.settings-daemon.plugins.power lid-close-ac-action 'nothing'
    gsettings set org.gnome.settings-daemon.plugins.power lid-close-battery-action 'suspend'
else
    echo "Skipping GNOME settings (not in a GNOME session)."
fi

echo "Done. Lid close on AC will no longer suspend the system."

#!/usr/bin/env bash

# Install the generic headless Pi GitHub issue worker without enabling a repository profile.
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$DOTFILES_DIR/pi/github-issue-worker"
PREFIX="$HOME/.local"
CONFIG_DIR="$HOME/.config/pi-issue-worker"
DATA_DIR="$HOME/.local/share/pi-issue-worker"

for command in node npm git gh; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'Required command is not installed: %s\n' "$command" >&2
        exit 1
    fi
done

node -e '
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
    console.error(`Node.js 24 or newer is required; found ${process.versions.node}`);
    process.exit(1);
}
'

printf 'Installing Pi GitHub issue worker from %s\n' "$PACKAGE_DIR"
cd "$PACKAGE_DIR"
npm ci
npm run check

PACK_DIR="$(mktemp -d)"
cleanup() {
    rm -rf -- "$PACK_DIR"
}
trap cleanup EXIT
TARBALL="$(npm pack --pack-destination "$PACK_DIR" --silent)"
npm install --global --prefix "$PREFIX" "$PACK_DIR/$TARBALL"

mkdir -p "$CONFIG_DIR" "$DATA_DIR"
chmod 700 "$CONFIG_DIR" "$DATA_DIR"
if command -v systemctl >/dev/null 2>&1 && [ "$(uname -s)" = "Linux" ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    install -m 0644 "$PACKAGE_DIR/systemd/pi-issue-worker@.service" "$UNIT_DIR/"
    install -m 0644 "$PACKAGE_DIR/systemd/pi-issue-worker-supervisor.service" "$UNIT_DIR/"
    if ! systemctl --user daemon-reload; then
        printf '%s\n' "Warning: systemd user manager is unavailable; the unit was copied but not reloaded." >&2
    fi
fi

printf '\nInstalled %s/bin/pi-issue-worker\n' "$PREFIX"
printf 'Create a mode-0600 <profile>.env from %s/.env.example, then run:\n' "$PACKAGE_DIR"
printf '  set -a; . ~/.config/pi-issue-worker/<profile>.env; set +a\n'
printf '  pi-issue-worker --check\n'
printf 'Run all configured profiles with:\n'
printf '  pi-issue-worker-supervisor --check\n'
printf '  systemctl --user enable --now pi-issue-worker-supervisor.service  # Linux\n'
printf 'Or enable an individual profile with:\n'
printf '  systemctl --user enable --now pi-issue-worker@<profile>.service  # Linux\n'
printf '%s\n' 'No repository profile or supervisor was enabled or started automatically.'

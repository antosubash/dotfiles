#!/usr/bin/env bash
# Fixes the font install: moves fonts out of the old NerdFonts/ subdirectory,
# installs any pinned Nerd Font or MesloLGS NF that's missing, and refreshes
# the font cache. All of that is install_fonts in lib/installers.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/setup-common.sh
. "$HERE/lib/setup-common.sh"
# shellcheck source=lib/installers.sh
. "$HERE/lib/installers.sh"

echo "Fixing font installation..."
install_fonts
echo "Fonts are in: $HOME/.local/share/fonts"

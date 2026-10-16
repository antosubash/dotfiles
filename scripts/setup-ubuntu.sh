#!/usr/bin/env bash
# Sets up an Ubuntu desktop for development. Safe to re-run: each section
# installs only what's missing or below its pinned version, and a failing
# section doesn't stop the others. `--list` shows the sections; `--only a,b`
# and `--skip a,b` choose them. A log is kept in ~/.local/state/dotfiles/.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/setup-common.sh
. "$HERE/lib/setup-common.sh"
# shellcheck source=lib/installers.sh
. "$HERE/lib/installers.sh"

# shellcheck disable=SC2034  # read by the runner in lib/setup-common.sh
SECTIONS=(base editor languages dotnet cli security ssh-firewall vpn shell git-tools
    docker node python k8s db-gis ollama apps keyboard fonts nvidia apt-hygiene)

# Runs first: later sections need curl, gnupg and ca-certificates for add_apt_source.
section_base() {
    # One broken third-party source shouldn't stop the installs below.
    sudo apt update || echo "WARNING: apt update reported errors; continuing with the package lists apt has."
    # In their own call, so a package missing from this release's archive can't hold them back.
    apt_install_missing curl ca-certificates gnupg
    apt_install_missing wget git htop btop fastfetch vim nano build-essential cmake \
        net-tools openssl unzip bc sqlite3 shellcheck ffmpeg python-is-python3
}

section_editor() { apt_install_missing neovim; }

section_languages() {
    apt_install_missing python3 python3-full default-jdk
    install_pinned_go
    install_rust
}

section_dotnet() { install_dotnet 7.0 8.0 9.0 10.0; }

section_cli() {
    apt_install_missing httpie jq
    install_pinned_yq
    install_cli_extras
    if command -v curlie > /dev/null 2>&1; then
        echo "curlie is already installed."
    elif skip_new_install curlie; then
        :
    elif command -v go > /dev/null 2>&1; then
        go install github.com/rs/curlie@v1.6.0
    else
        # No Go on arm64 (the pinned Go is x86_64) or with --only cli on a fresh machine.
        echo "WARNING: Go not found; skipping curlie (run the languages section first)." >&2
    fi
}

section_security() {
    apt_install_missing gnupg pass nmap
    install_wireshark
}

section_ssh_firewall() {
    has_systemd || skip_section "no systemd"
    apt_install_missing openssh-server
    sudo systemctl enable --now ssh
    harden_sshd || echo "WARNING: SSH hardening was not applied; see the error above."
    configure_ufw
}

section_vpn() {
    command -v tailscale > /dev/null 2>&1 || install_tailscale
    apt_install_missing wireguard wireguard-tools
}

section_shell() {
    apt_install_missing tmux fzf ripgrep fd-find zsh
    # Ubuntu ships fd as `fdfind`; the shell config and tools expect `fd`.
    if ! command -v fd > /dev/null 2>&1; then
        mkdir -p "$HOME/.local/bin"
        ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd"
    fi
    local zsh_path
    zsh_path="$(command -v zsh)"
    [ "$(getent passwd "$USER" | cut -d: -f7)" = "$zsh_path" ] || sudo chsh -s "$zsh_path" "$USER"
    # Oh My Zsh, its plugins and Powerlevel10k (repairs a partial install).
    bash "$HERE/setup-oh-my-zsh.sh"
    install_tpm
}

section_git_tools() {
    install_gh
    install_pinned_git_tools
}

section_docker() {
    install_docker
    install_nvidia_container_toolkit
}

section_node() {
    command -v node > /dev/null 2>&1 || skip_new_install Node.js || install_nodejs
    install_pnpm
    install_pi
}

section_python() {
    apt_install_missing python3-pip python3-venv
    install_uv
}

section_k8s() { install_pinned_k8s; }

section_db_gis() {
    apt_install_missing postgresql-client gdal-bin libgdal-dev python3-gdal proj-bin libproj-dev \
        libgeos-dev spatialite-bin libspatialite-dev
}

section_ollama() {
    if command -v ollama > /dev/null 2>&1; then
        echo "Ollama is already installed."
        return 0
    fi
    # Ollama has no apt repository; run the vendor installer (which also sets up
    # its service and GPU support) from a file, not a pipe.
    local tmp status=0
    tmp="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/install.sh" https://ollama.com/install.sh \
        && sh "$tmp/install.sh" || status=1
    rm -rf "$tmp"
    return "$status"
}

section_apps() {
    apt_install_missing vlc thunderbird
    # Native messaging host for extensions.gnome.org; older releases name it chrome-gnome-shell.
    if apt-cache show gnome-browser-connector > /dev/null 2>&1; then
        apt_install_missing gnome-browser-connector
    else
        apt_install_missing chrome-gnome-shell
    fi
    has_systemd || skip_section "no systemd (snaps unavailable)"
    snap_install_missing slack discord zoom-client
    install_desktop_apps
}

section_keyboard() {
    # The same check as setup-keyboard.sh's main, which does nothing outside GNOME.
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [[ "${XDG_CURRENT_DESKTOP:-}" != *GNOME* ]]; then
        skip_section "not in a GNOME session"
    fi
    bash "$HERE/setup-keyboard.sh"
}

section_fonts() { install_fonts; }

section_nvidia() {
    has_nvidia_gpu || skip_section "No NVIDIA GPU found"
    # Warns on every apt run if a kernel update leaves out the NVIDIA module.
    bash "$HERE/setup-nvidia-guard.sh"
}

section_apt_hygiene() {
    sudo rm -f /etc/apt/sources.list.d/*.curtin.orig
    local leftover
    leftover="$(find /etc/apt/sources.list.d -name '*.list' -printf '  %f\n')"
    [ -z "$leftover" ] || printf 'One-line .list sources still present (not managed here):\n%s\n' "$leftover"
}

# _version_of TOOL: the first line of TOOL's version output.
_version_of() {
    local args=(--version)
    case "$1" in
        go) args=(version) ;;
        tmux) args=(-V) ;;
        kubectl) args=(version --client) ;;
        helm) args=(version --short) ;;
    esac
    "$1" "${args[@]}" 2>&1 | head -1
}

print_tool_versions() {
    local name t
    echo ""
    echo "Installed tools:"
    for name in git nvim python3 java go rustc dotnet node pnpm uv gh docker kubectl helm lazygit \
        lazydocker yq jq eza bat zoxide atuin fzf rg fd tmux zsh tailscale psql gdalinfo ollama ulauncher keyd; do
        t="$name"
        # Ubuntu's keyd package names the binary keyd.rvaiya.
        if [ "$t" = keyd ] && ! command -v keyd > /dev/null 2>&1; then t=keyd.rvaiya; fi
        if command -v "$t" > /dev/null 2>&1; then
            printf '  %-11s %s\n' "$name" "$(_version_of "$t")"
        else
            printf '  %-11s missing\n' "$name"
        fi
    done
}

# run_setup must run as a plain command (not in if/&&/||) so set -e works in each section.
if [ "${SETUP_UBUNTU_SOURCE_ONLY:-}" != 1 ]; then
    run_setup "$@"
    status=$?
    print_tool_versions
    exit "$status"
fi

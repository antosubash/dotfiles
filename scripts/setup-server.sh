#!/bin/bash

set -e

# shellcheck source=lib/setup-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/setup-common.sh"
# shellcheck source=lib/installers.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/installers.sh"

echo "Installing development & operations tools on Ubuntu Server (headless)..."

# ---------- Preflight: verify bootstrap commands & environment ----------
require_cmd() {
    if ! command -v "$1" &> /dev/null; then
        echo "ERROR: required command '$1' is not available.${2:+ $2}" >&2
        exit 1
    fi
}

# This script targets Debian/Ubuntu — refuse to run elsewhere.
require_debian_host

require_cmd apt  "This script targets Debian/Ubuntu systems."
require_cmd dpkg "dpkg should be present on Debian/Ubuntu."
require_cmd grep
require_cmd sed
require_cmd id

# sudo handling: when running as root, alias sudo to direct exec if missing.
# Otherwise require sudo and verify the user can actually use it.
if [ "$(id -u)" -eq 0 ]; then
    if ! command -v sudo &> /dev/null; then
        echo "Running as root; aliasing 'sudo' to direct execution."
        sudo() { env "$@"; }
    fi
else
    require_cmd sudo "Install sudo (apt install sudo) and add your user to the sudo group."
    if ! sudo -n true 2>/dev/null && ! sudo -v; then
        echo "ERROR: this script requires sudo privileges." >&2
        exit 1
    fi
fi

# Every install directory (~/.local/bin, cargo, go, .NET, pnpm) on PATH for this
# run; the dotfiles' shell files do the same for later sessions.
setup_path

# Update package manager
echo "Updating package manager..."
sudo apt update

# Install basic system tools (everything later in the script depends on)
echo "Installing basic system tools..."
sudo apt install -y \
    curl wget htop vim nano build-essential net-tools openssl git \
    ca-certificates software-properties-common unzip tar gnupg lsb-release \
    apt-transport-https

# Verify the basic install actually delivered the commands later sections need.
echo "Verifying core commands are available..."
for cmd in curl wget git gpg tar unzip lsb_release dpkg getent; do
    require_cmd "$cmd" "Expected '$cmd' to be installed via apt — install failed."
done

# Install server essentials (security, monitoring, SSH)
echo "Installing server essentials..."
sudo apt install -y \
    openssh-server \
    unattended-upgrades \
    fail2ban \
    sysstat \
    ncdu \
    iotop \
    logrotate

# Enable unattended security updates
echo "Enabling unattended security upgrades..."
sudo dpkg-reconfigure -f noninteractive unattended-upgrades || true

# Enable & start core services
sudo systemctl enable --now ssh || sudo systemctl enable --now sshd || true
sudo systemctl enable --now fail2ban || true

# Key-only SSH (skipped with a warning until you have an authorized key)
harden_sshd || echo "WARNING: SSH hardening was not applied; see the error above."

# Install Neovim
# Install Neovim from the official release binary.
# Ubuntu's apt nvim is typically too old (0.9.x) for modern plugin specs that
# require 0.10+. Install latest stable to /opt/nvim and symlink into PATH.
echo "Installing Neovim (latest stable binary)..."
INSTALLED_NVIM_VERSION=""
if command -v nvim &> /dev/null; then
    INSTALLED_NVIM_VERSION=$(nvim --version | head -n1 | awk '{print $2}' | tr -d 'v')
fi

NVIM_LATEST=$(curl -fsSL "https://api.github.com/repos/neovim/neovim/releases/latest" | grep -Po '"tag_name": "v\K[^"]*' | head -1 || true)
if [ -z "$NVIM_LATEST" ]; then
    echo "Could not query latest Neovim version; falling back to apt."
    apt_install_missing neovim
elif [ "$INSTALLED_NVIM_VERSION" = "$NVIM_LATEST" ]; then
    echo "Neovim $NVIM_LATEST already installed."
else
    echo "Installing Neovim v$NVIM_LATEST..."
    NVIM_ARCH="x86_64"
    [ "$(uname -m)" = "aarch64" ] && NVIM_ARCH="arm64"
    NVIM_TARBALL="nvim-linux-${NVIM_ARCH}.tar.gz"
    NVIM_URL="https://github.com/neovim/neovim/releases/download/v${NVIM_LATEST}/${NVIM_TARBALL}"
    TMP_NVIM=$(mktemp -d)
    # Extract into the temp dir first; /opt/nvim is replaced only once tar succeeded.
    if curl -fsSL "$NVIM_URL" -o "$TMP_NVIM/$NVIM_TARBALL" \
        && tar -C "$TMP_NVIM" -xzf "$TMP_NVIM/$NVIM_TARBALL"; then
        # Stage next to the target (root-owned, same filesystem), then swap, so a
        # failed copy never leaves /opt/nvim half-written.
        sudo rm -rf /opt/nvim.new
        sudo mv "$TMP_NVIM/nvim-linux-${NVIM_ARCH}" /opt/nvim.new \
            && sudo chown -R root:root /opt/nvim.new \
            && sudo rm -rf /opt/nvim \
            && sudo mv /opt/nvim.new /opt/nvim
        sudo ln -sf /opt/nvim/bin/nvim /usr/local/bin/nvim
        # Remove apt-installed nvim to avoid PATH conflicts.
        if _pkg_installed neovim; then
            sudo apt purge -y neovim || true
        fi
    else
        echo "Failed to download Neovim binary; falling back to apt."
        apt_install_missing neovim
    fi
    rm -rf "$TMP_NVIM"
fi

# Bootstrap Neovim plugins (lazy.nvim) headlessly so the first interactive
# launch isn't blocked by plugin installs.
if command -v nvim &> /dev/null && [ -f "$HOME/.config/nvim/init.lua" ]; then
    echo "Bootstrapping Neovim plugins via lazy.nvim..."
    nvim --headless "+Lazy! sync" +qa 2>/dev/null || \
        echo "Note: nvim plugin sync had warnings — run ':Lazy sync' inside nvim if needed."
fi

# Install development languages
echo "Installing Python..."
if ! command -v python3 &> /dev/null; then
    sudo apt install -y python3 python3-full python3-pip python3-venv
else
    echo "Python3 is already installed."
    sudo apt install -y python3-pip python3-venv
fi

echo "Installing Java (default-jdk)..."
if ! command -v java &> /dev/null; then
    sudo apt install -y default-jdk
else
    echo "Java is already installed."
fi

echo "Installing .NET SDKs (7, 8, 9, 10)..."
install_dotnet 7.0 8.0 9.0 10.0

echo "Installing Go..."
install_pinned_go

echo "Installing Rust..."
install_rust

# Install API and testing CLI tools
echo "Installing API/CLI tools..."
if ! command -v http &> /dev/null || ! command -v jq &> /dev/null; then
    sudo apt install -y httpie jq
else
    echo "httpie and jq are already installed."
fi
install_pinned_yq
if ! command -v curlie &> /dev/null && command -v go &> /dev/null; then
    go install github.com/rs/curlie@v1.6.0
fi

# Install security tools
echo "Installing security tools..."
if ! command -v gpg &> /dev/null || ! command -v pass &> /dev/null; then
    sudo apt install -y gnupg pass
else
    echo "Security tools are already installed."
fi

# Install network tools (CLI only, no Wireshark GUI on a server)
echo "Installing network tools..."
if ! command -v nmap &> /dev/null; then
    sudo apt install -y nmap
else
    echo "nmap is already installed."
fi
if ! command -v tshark &> /dev/null; then
    sudo DEBIAN_FRONTEND=noninteractive apt install -y tshark
else
    echo "tshark is already installed."
fi
apt_install_missing ufw

# Configure and enable UFW with safe defaults (SSH allowed, deny incoming,
# allow outgoing). configure_ufw always runs `ufw allow OpenSSH`; the default
# policies, the tailscale0 allow rule and enabling happen only while UFW is inactive.
# Also allow sshd on any non-default port first, so enabling UFW can't cut off SSH.
if ! sudo ufw status | grep -q "Status: active"; then
    for port in $(sudo sshd -T 2>/dev/null | awk '$1 == "port" && $2 != 22 { print $2 }'); do
        sudo ufw allow "$port/tcp"
    done
fi
configure_ufw

# Install VPN tools
echo "Installing VPN tools..."
if ! command -v tailscale &> /dev/null; then
    install_tailscale
else
    echo "Tailscale is already installed."
fi
if ! command -v wg &> /dev/null; then
    sudo apt install -y wireguard wireguard-tools
else
    echo "Wireguard is already installed."
fi

# Install productivity CLI tools
echo "Installing productivity CLI tools..."
if ! command -v tmux &> /dev/null || ! command -v fzf &> /dev/null || ! command -v rg &> /dev/null || ! command -v fdfind &> /dev/null; then
    sudo apt install -y tmux fzf ripgrep fd-find
else
    echo "Productivity tools are already installed."
fi
if ! command -v zsh &> /dev/null; then
    sudo apt install -y zsh
else
    echo "ZSH is already installed."
fi

# Make zsh the default login shell for the current user (idempotent).
ZSH_PATH="$(command -v zsh)"
if [ -n "$ZSH_PATH" ]; then
    if ! grep -Fxq "$ZSH_PATH" /etc/shells 2>/dev/null; then
        echo "$ZSH_PATH" | sudo tee -a /etc/shells > /dev/null
    fi
    CURRENT_LOGIN_SHELL="$(getent passwd "$USER" | awk -F: '{print $7}')"
    if [ "$CURRENT_LOGIN_SHELL" != "$ZSH_PATH" ]; then
        echo "Setting default shell to $ZSH_PATH for $USER..."
        sudo chsh -s "$ZSH_PATH" "$USER" || \
            echo "Warning: chsh failed — run 'sudo chsh -s $ZSH_PATH $USER' manually."
    else
        echo "Default shell is already zsh."
    fi
fi

# Install Oh My Zsh, plugins, and Powerlevel10k (repairs a custom/-only partial install)
bash "$(dirname "${BASH_SOURCE[0]}")/setup-oh-my-zsh.sh"

# Install tmux plugin manager (tpm) — required for .tmux.conf plugins.
echo "Installing tmux plugin manager..."
install_tpm

# Install atuin (fuzzy shell history): the apt package where the release has
# one, else the official GitHub release binary (verified against its checksum).
echo "Installing atuin..."
if command -v atuin &> /dev/null; then
    echo "atuin is already installed."
elif apt-cache show atuin &> /dev/null; then
    apt_install_missing atuin
else
    ATUIN_VERSION=$(curl -fsSL "https://api.github.com/repos/atuinsh/atuin/releases/latest" | grep -Po '"tag_name":\s*"v\K[^"]+' | head -1 || true)
    if [ -n "$ATUIN_VERSION" ]; then
        ATUIN_ARCH="x86_64"
        [ "$(uname -m)" = "aarch64" ] && ATUIN_ARCH="aarch64"
        ATUIN_TARBALL="atuin-${ATUIN_ARCH}-unknown-linux-gnu.tar.gz"
        ATUIN_URL="https://github.com/atuinsh/atuin/releases/download/v${ATUIN_VERSION}/${ATUIN_TARBALL}"
        TMP_ATUIN=$(mktemp -d)
        if curl -fsSLo "$TMP_ATUIN/$ATUIN_TARBALL" "$ATUIN_URL" \
            && curl -fsSLo "$TMP_ATUIN/$ATUIN_TARBALL.sha256" "$ATUIN_URL.sha256" \
            && (cd "$TMP_ATUIN" && sha256sum -c "$ATUIN_TARBALL.sha256") >/dev/null 2>&1; then
            tar -C "$TMP_ATUIN" -xzf "$TMP_ATUIN/$ATUIN_TARBALL"
            sudo install -m 755 "$TMP_ATUIN/atuin-${ATUIN_ARCH}-unknown-linux-gnu/atuin" /usr/local/bin/atuin
            echo "atuin $ATUIN_VERSION installed."
        else
            echo "atuin download or checksum verification failed — skipping."
        fi
        rm -rf "$TMP_ATUIN"
    else
        echo "Could not query the latest atuin release; skipping atuin."
    fi
fi

echo "Installing Lazygit and Lazydocker..."
install_pinned_git_tools

echo "Installing GitHub CLI..."
install_gh
echo "Installing Docker..."
install_docker

# Install Node.js and pnpm
echo "Installing Node.js..."
if ! command -v node &> /dev/null; then
    install_nodejs
else
    echo "Node.js is already installed."
fi

echo "Installing pnpm..."
install_pnpm

# Install uv (fast Python package manager)
echo "Installing uv..."
install_uv

# Install Kubernetes CLI tools
echo "Installing kubectl and helm..."
install_pinned_k8s

# Install database clients
echo "Installing database clients..."
if ! command -v psql &> /dev/null; then
    sudo apt install -y postgresql-client
else
    echo "PostgreSQL client is already installed."
fi

# Install GDAL and geospatial tools
echo "Installing GDAL and geospatial tools..."
if ! command -v gdalinfo &> /dev/null || ! command -v ogr2ogr &> /dev/null; then
    sudo apt install -y gdal-bin libgdal-dev python3-gdal
else
    echo "GDAL is already installed."
fi
if ! command -v proj &> /dev/null; then
    sudo apt install -y proj-bin libproj-dev
else
    echo "PROJ is already installed."
fi
if ! command -v geos-config &> /dev/null; then
    sudo apt install -y libgeos-dev
else
    echo "GEOS is already installed."
fi
if ! command -v spatialite &> /dev/null; then
    sudo apt install -y spatialite-bin libspatialite-dev
else
    echo "SpatiaLite is already installed."
fi

# Display versions
echo ""
echo "=========================================="
echo "Installation complete! Installed versions:"
echo "=========================================="
echo "Git:         $(git --version)"
command -v gh &> /dev/null      && echo "GitHub CLI:  $(gh --version | head -n1)"
echo "Python:      $(python3 --version)"
command -v java &> /dev/null    && echo "Java:        $(java -version 2>&1 | head -n1)"
if command -v dotnet &> /dev/null; then
    echo ".NET SDKs:"
    dotnet --list-sdks | sed 's/^/             /'
fi
command -v go &> /dev/null      && echo "Go:          $(go version)"
command -v rustc &> /dev/null   && echo "Rust:        $(rustc --version)"
command -v node &> /dev/null    && echo "Node.js:     $(node --version)"
command -v pnpm &> /dev/null    && echo "pnpm:        $(pnpm --version)"
command -v uv &> /dev/null      && echo "uv:          $(uv --version)"
command -v jq &> /dev/null      && echo "jq:          $(jq --version)"
command -v yq &> /dev/null      && echo "yq:          $(yq --version)"
command -v kubectl &> /dev/null && echo "kubectl:     $(kubectl version --client 2>/dev/null | head -n1)"
command -v helm &> /dev/null    && echo "Helm:        $(helm version --short)"
command -v docker &> /dev/null  && echo "Docker:      $(docker --version)"
command -v tmux &> /dev/null    && echo "tmux:        $(tmux -V)"
command -v rg &> /dev/null      && echo "ripgrep:     $(rg --version | head -n1)"
command -v nvim &> /dev/null    && echo "Neovim:      $(nvim --version | head -n1)"
command -v tailscale &> /dev/null && echo "Tailscale:   $(tailscale version | head -n1)"
command -v wg &> /dev/null      && echo "Wireguard:   $(wg --version)"
command -v ufw &> /dev/null     && echo "UFW:         $(sudo ufw status | head -n1)"
command -v fail2ban-client &> /dev/null && echo "fail2ban:    $(fail2ban-client --version | head -n1)"
command -v gdalinfo &> /dev/null && echo "GDAL:        $(gdalinfo --version)"
command -v geos-config &> /dev/null && echo "GEOS:        $(geos-config --version)"
command -v spatialite &> /dev/null && echo "SpatiaLite:  $(spatialite --version 2>&1 | head -n1)"

echo ""
echo "Next steps:"
echo "  1. Run 'source ~/.zshrc' (or ~/.bashrc) to apply PATH changes."
echo "  2. If you were added to the docker group, log out and back in."
echo "  3. Review the firewall:        sudo ufw status verbose"
echo "  4. Bring up Tailscale:         sudo tailscale up"
echo "  5. Verify fail2ban is active:  sudo systemctl status fail2ban"

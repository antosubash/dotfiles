#!/bin/bash

set -e

echo "Installing development & operations tools on Ubuntu Server (headless)..."

# ---------- Preflight: verify bootstrap commands & environment ----------
require_cmd() {
    if ! command -v "$1" &> /dev/null; then
        echo "ERROR: required command '$1' is not available.${2:+ $2}" >&2
        exit 1
    fi
}

# This script targets Debian/Ubuntu — refuse to run elsewhere.
if [ ! -r /etc/os-release ] || ! grep -qE '^ID(_LIKE)?=.*(debian|ubuntu)' /etc/os-release; then
    echo "ERROR: this script targets Debian/Ubuntu hosts." >&2
    exit 1
fi

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
        sudo() { "$@"; }
    fi
else
    require_cmd sudo "Install sudo (apt install sudo) and add your user to the sudo group."
    if ! sudo -n true 2>/dev/null && ! sudo -v; then
        echo "ERROR: this script requires sudo privileges." >&2
        exit 1
    fi
fi

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

# Install Neovim
# Install Neovim from the official release binary.
# Ubuntu's apt nvim is typically too old (0.9.x) for modern plugin specs that
# require 0.10+. Install latest stable to /opt/nvim and symlink into PATH.
echo "Installing Neovim (latest stable binary)..."
INSTALLED_NVIM_VERSION=""
if command -v nvim &> /dev/null; then
    INSTALLED_NVIM_VERSION=$(nvim --version | head -n1 | awk '{print $2}' | tr -d 'v')
fi

NVIM_LATEST=$(curl -s "https://api.github.com/repos/neovim/neovim/releases/latest" | grep -Po '"tag_name": "v\K[^"]*' | head -1)
if [ -z "$NVIM_LATEST" ]; then
    echo "Could not query latest Neovim version; falling back to apt."
    sudo apt install -y neovim
elif [ "$INSTALLED_NVIM_VERSION" = "$NVIM_LATEST" ]; then
    echo "Neovim $NVIM_LATEST already installed."
else
    echo "Installing Neovim v$NVIM_LATEST..."
    NVIM_ARCH="x86_64"
    [ "$(uname -m)" = "aarch64" ] && NVIM_ARCH="arm64"
    NVIM_TARBALL="nvim-linux-${NVIM_ARCH}.tar.gz"
    NVIM_URL="https://github.com/neovim/neovim/releases/download/v${NVIM_LATEST}/${NVIM_TARBALL}"
    TMP_NVIM=$(mktemp -d)
    if curl -sL "$NVIM_URL" -o "$TMP_NVIM/$NVIM_TARBALL"; then
        sudo rm -rf /opt/nvim
        sudo tar -C /opt -xzf "$TMP_NVIM/$NVIM_TARBALL"
        sudo mv "/opt/nvim-linux-${NVIM_ARCH}" /opt/nvim
        sudo ln -sf /opt/nvim/bin/nvim /usr/local/bin/nvim
        # Remove apt-installed nvim to avoid PATH conflicts.
        if dpkg -l neovim 2>/dev/null | grep -q '^ii'; then
            sudo apt purge -y neovim || true
        fi
    else
        echo "Failed to download Neovim binary; falling back to apt."
        sudo apt install -y neovim
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
curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
chmod +x /tmp/dotnet-install.sh
for channel in 7.0 8.0 9.0 10.0; do
    echo "Installing .NET $channel..."
    /tmp/dotnet-install.sh --channel "$channel" --install-dir "$HOME/.dotnet"
done
rm -f /tmp/dotnet-install.sh
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools"
for rc in ~/.zshrc ~/.bashrc; do
    if [ -f "$rc" ] && ! grep -q 'DOTNET_ROOT' "$rc"; then
        echo 'export DOTNET_ROOT=$HOME/.dotnet' >> "$rc"
        echo 'export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools' >> "$rc"
    fi
done

echo "Installing Go..."
if ! command -v go &> /dev/null; then
    GO_VERSION="1.21.5"
    wget -q https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz
    sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz
    rm go${GO_VERSION}.linux-amd64.tar.gz
    if ! grep -q 'export PATH=$PATH:/usr/local/go/bin' ~/.zshrc 2>/dev/null; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.zshrc
    fi
    if ! grep -q 'export PATH=$PATH:/usr/local/go/bin' ~/.bashrc 2>/dev/null; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
    fi
    export PATH=$PATH:/usr/local/go/bin
else
    echo "Go is already installed."
fi

echo "Installing Rust..."
if ! command -v rustc &> /dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source ~/.cargo/env
    if ! grep -q 'source ~/.cargo/env' ~/.zshrc 2>/dev/null; then
        echo 'source ~/.cargo/env' >> ~/.zshrc
    fi
    if ! grep -q 'source ~/.cargo/env' ~/.bashrc 2>/dev/null; then
        echo 'source ~/.cargo/env' >> ~/.bashrc
    fi
else
    echo "Rust is already installed."
fi

# Install API and testing CLI tools
echo "Installing API/CLI tools..."
if ! command -v http &> /dev/null || ! command -v jq &> /dev/null; then
    sudo apt install -y httpie jq
else
    echo "httpie and jq are already installed."
fi
if ! command -v yq &> /dev/null; then
    sudo wget -q https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq && sudo chmod +x /usr/bin/yq
else
    echo "yq is already installed."
fi
if ! command -v curlie &> /dev/null && command -v go &> /dev/null; then
    go install github.com/rs/curlie@v1.6.0
    if ! grep -q 'export PATH=$PATH:~/go/bin' ~/.zshrc 2>/dev/null; then
        echo 'export PATH=$PATH:~/go/bin' >> ~/.zshrc
    fi
    if ! grep -q 'export PATH=$PATH:~/go/bin' ~/.bashrc 2>/dev/null; then
        echo 'export PATH=$PATH:~/go/bin' >> ~/.bashrc
    fi
    export PATH=$PATH:~/go/bin
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
if ! command -v ufw &> /dev/null; then
    sudo apt install -y ufw
else
    echo "UFW is already installed."
fi

# Configure UFW with safe defaults (SSH allowed, deny incoming, allow outgoing)
# Only set defaults if UFW is inactive to avoid clobbering existing rules.
if command -v ufw &> /dev/null && ! sudo ufw status | grep -q "Status: active"; then
    echo "Configuring UFW defaults (allow SSH)..."
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow OpenSSH
    echo "UFW configured but NOT enabled. Enable manually with: sudo ufw enable"
fi

# Install VPN tools
echo "Installing VPN tools..."
if ! command -v tailscale &> /dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
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

# Install Oh My Zsh and plugins
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    echo "Installing Oh My Zsh..."
    RUNZSH=no sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
    git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
    git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
    sed -i 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting)/' ~/.zshrc
else
    echo "Oh My Zsh is already installed."
fi

# Install tmux plugin manager (tpm) — required for .tmux.conf plugins.
echo "Installing tmux plugin manager..."
if [ ! -d "$HOME/.tmux/plugins/tpm" ]; then
    git clone --depth=1 https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"
    # Headlessly install plugins listed in .tmux.conf.
    if [ -f "$HOME/.tmux.conf" ]; then
        "$HOME/.tmux/plugins/tpm/bin/install_plugins" >/dev/null 2>&1 || \
            echo "Note: tpm plugin install had issues — open tmux and press 'prefix + I' to retry."
    fi
else
    echo "tpm already installed."
fi

# Install atuin (fuzzy shell history) from official GitHub release binary.
echo "Installing atuin..."
if ! command -v atuin &> /dev/null; then
    ATUIN_VERSION=$(curl -s "https://api.github.com/repos/atuinsh/atuin/releases/latest" | grep -Po '"tag_name":\s*"v\K[^"]+' | head -1)
    if [ -n "$ATUIN_VERSION" ]; then
        ATUIN_ARCH="x86_64"
        [ "$(uname -m)" = "aarch64" ] && ATUIN_ARCH="aarch64"
        ATUIN_TARBALL="atuin-${ATUIN_ARCH}-unknown-linux-gnu.tar.gz"
        ATUIN_URL="https://github.com/atuinsh/atuin/releases/download/v${ATUIN_VERSION}/${ATUIN_TARBALL}"
        TMP_ATUIN=$(mktemp -d)
        if curl -sLo "$TMP_ATUIN/$ATUIN_TARBALL" "$ATUIN_URL" \
            && curl -sLo "$TMP_ATUIN/$ATUIN_TARBALL.sha256" "$ATUIN_URL.sha256" \
            && (cd "$TMP_ATUIN" && sha256sum -c "$ATUIN_TARBALL.sha256") >/dev/null 2>&1; then
            tar -C "$TMP_ATUIN" -xzf "$TMP_ATUIN/$ATUIN_TARBALL"
            sudo install -m 755 "$TMP_ATUIN/atuin-${ATUIN_ARCH}-unknown-linux-gnu/atuin" /usr/local/bin/atuin
            echo "atuin $ATUIN_VERSION installed."
        else
            echo "atuin download or checksum verification failed — skipping."
        fi
        rm -rf "$TMP_ATUIN"
    fi
else
    echo "atuin is already installed."
fi

# Install Lazygit
echo "Installing Lazygit..."
if ! command -v lazygit &> /dev/null; then
    LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
    curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/latest/download/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
    tar xf lazygit.tar.gz lazygit
    sudo install lazygit /usr/local/bin
    rm lazygit lazygit.tar.gz
else
    echo "Lazygit is already installed."
fi

# Install Lazydocker
echo "Installing Lazydocker..."
if ! command -v lazydocker &> /dev/null; then
    curl https://raw.githubusercontent.com/jesseduffield/lazydocker/master/scripts/install_update_linux.sh | bash
else
    echo "Lazydocker is already installed."
fi

# Install GitHub CLI
echo "Installing GitHub CLI..."
if ! command -v gh &> /dev/null; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    sudo apt update
    sudo apt install -y gh
else
    echo "GitHub CLI is already installed."
fi

# Install Docker
echo "Installing Docker..."
if ! command -v docker &> /dev/null; then
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt update
    sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
    echo "Docker is already installed."
fi

# Ensure 'docker' group exists and current user is a member (idempotent on re-runs).
if getent group docker > /dev/null; then
    if id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
        echo "$USER is already in the docker group."
    else
        sudo usermod -aG docker "$USER"
        echo "Added $USER to docker group. Log out and back in (or run 'newgrp docker') for it to take effect."
    fi
fi

# Install Node.js and pnpm
echo "Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js is already installed."
fi

echo "Installing pnpm..."
if ! command -v pnpm &> /dev/null; then
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export PATH="$PNPM_HOME:$PATH"
    if ! grep -q 'PNPM_HOME' ~/.zshrc 2>/dev/null; then
        echo 'export PNPM_HOME="$HOME/.local/share/pnpm"' >> ~/.zshrc
        echo 'export PATH="$PNPM_HOME:$PATH"' >> ~/.zshrc
    fi
    if ! grep -q 'PNPM_HOME' ~/.bashrc 2>/dev/null; then
        echo 'export PNPM_HOME="$HOME/.local/share/pnpm"' >> ~/.bashrc
        echo 'export PATH="$PNPM_HOME:$PATH"' >> ~/.bashrc
    fi
else
    echo "pnpm is already installed."
fi

# Install uv (fast Python package manager)
echo "Installing uv..."
if ! command -v uv &> /dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.cargo/bin:$PATH"
    if ! grep -q 'export PATH="$HOME/.cargo/bin:$PATH"' ~/.zshrc 2>/dev/null; then
        echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc
    fi
else
    echo "uv is already installed."
fi

# Install Kubernetes CLI tools
echo "Installing kubectl..."
if ! command -v kubectl &> /dev/null; then
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
    sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
    rm kubectl
else
    echo "kubectl is already installed."
fi

if ! command -v helm &> /dev/null; then
    curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
else
    echo "Helm is already installed."
fi

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

# Start & enable Docker
if command -v docker &> /dev/null; then
    echo "Enabling Docker service..."
    sudo systemctl enable --now docker
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
echo "  3. Review & enable UFW:        sudo ufw enable"
echo "  4. Bring up Tailscale:         sudo tailscale up"
echo "  5. Verify fail2ban is active:  sudo systemctl status fail2ban"

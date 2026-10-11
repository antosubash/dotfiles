#!/bin/bash

set -e

# shellcheck source=lib/setup-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/setup-common.sh"

echo "Installing latest versions of development tools on Ubuntu..."

# Update package manager
echo "Updating package manager..."
sudo apt update

# Install basic system tools
echo "Installing basic system tools..."
if ! command -v git &> /dev/null || ! command -v curl &> /dev/null || ! command -v wget &> /dev/null || ! command -v fastfetch &> /dev/null; then
    sudo apt install -y curl wget htop fastfetch vim nano build-essential net-tools openssl git
else
    echo "Basic system tools are already installed."
fi

# Install Neovim
echo "Installing Neovim..."
if ! command -v nvim &> /dev/null; then
    sudo apt install -y neovim
else
    echo "Neovim is already installed."
fi

# Install development environments
echo "Installing development environments..."
if ! command -v python3 &> /dev/null || ! command -v java &> /dev/null; then
    sudo apt install -y python3 python3-full default-jdk
else
    echo "Python3 and Java are already installed."
fi
if ! command -v go &> /dev/null; then
    install_go
    if ! grep -q '/usr/local/go/bin' ~/.zshrc 2>/dev/null; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.zshrc
    fi
    export PATH=$PATH:/usr/local/go/bin
else
    echo "Go is already installed."
fi
if ! command -v rustc &> /dev/null; then
    # --no-modify-path: rustup would otherwise append to the symlinked ~/.profile and ~/.bashrc.
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
    # shellcheck source=/dev/null
    source ~/.cargo/env
    if ! grep -q '\.cargo/env' ~/.zshrc 2>/dev/null; then
        echo 'source ~/.cargo/env' >> ~/.zshrc
    fi
else
    echo "Rust is already installed."
fi

# Install .NET SDK
echo "Installing .NET SDK..."
if ! command -v dotnet &> /dev/null; then
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
    chmod +x dotnet-install.sh
    echo "Installing .NET 7..."
    ./dotnet-install.sh --channel 7.0 --install-dir ~/.dotnet
    echo "Installing .NET 8..."
    ./dotnet-install.sh --channel 8.0 --install-dir ~/.dotnet
    echo "Installing .NET 9..."
    ./dotnet-install.sh --channel 9.0 --install-dir ~/.dotnet
    echo "Installing .NET 10..."
    ./dotnet-install.sh --channel 10.0 --install-dir ~/.dotnet
    rm dotnet-install.sh
    # Add to PATH
    export DOTNET_ROOT=$HOME/.dotnet
    export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools
    if ! grep -q 'DOTNET_ROOT' ~/.zshrc 2>/dev/null; then
        echo 'export DOTNET_ROOT=$HOME/.dotnet' >> ~/.zshrc
        echo 'export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools' >> ~/.zshrc
    fi
else
    echo ".NET is already installed. Installing additional versions..."
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
    chmod +x dotnet-install.sh
    ./dotnet-install.sh --channel 7.0 --install-dir ~/.dotnet
    ./dotnet-install.sh --channel 8.0 --install-dir ~/.dotnet
    ./dotnet-install.sh --channel 9.0 --install-dir ~/.dotnet
    ./dotnet-install.sh --channel 10.0 --install-dir ~/.dotnet
    rm dotnet-install.sh
fi

# Install API and testing tools
echo "Installing API and testing tools..."
if ! command -v http &> /dev/null || ! command -v jq &> /dev/null; then
    sudo apt install -y httpie jq
else
    echo "httpie and jq are already installed."
fi
if ! command -v yq &> /dev/null; then
    install_verified_binary "$YQ_URL" "$YQ_SHA256" /usr/local/bin/yq
else
    echo "yq is already installed."
fi
if ! command -v curlie &> /dev/null; then
    if command -v go &> /dev/null; then
        go install github.com/rs/curlie@v1.6.0
        if ! grep -qE '(~|\$HOME)/go/bin' ~/.zshrc 2>/dev/null; then
            echo 'export PATH=$PATH:~/go/bin' >> ~/.zshrc
        fi
        export PATH=$PATH:~/go/bin
    else
        echo "Go not found, skipping curlie installation."
    fi
else
    echo "curlie is already installed."
fi

# Install security tools
echo "Installing security tools..."
if ! command -v gpg &> /dev/null || ! command -v pass &> /dev/null; then
    sudo apt install -y gnupg pass
else
    echo "Security tools are already installed."
fi

# Install network security tools
echo "Installing network security tools..."
if ! command -v wireshark &> /dev/null; then
    sudo apt install -y wireshark
else
    echo "Wireshark is already installed."
fi
if ! command -v nmap &> /dev/null; then
    sudo apt install -y nmap
else
    echo "nmap is already installed."
fi
if ! command -v ufw &> /dev/null; then
    sudo apt install -y ufw
else
    echo "UFW is already installed."
fi

# Install and enable the SSH server
echo "Installing SSH server..."
if [ ! -x /usr/sbin/sshd ]; then
    sudo apt install -y openssh-server
else
    echo "OpenSSH server is already installed."
fi
sudo systemctl enable --now ssh
# Pre-allow SSH so enabling UFW later can't lock out remote sessions.
sudo ufw allow OpenSSH
harden_sshd || echo "WARNING: SSH hardening was not applied; see the error above."

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

# Install productivity tools
echo "Installing productivity tools..."
if ! command -v tmux &> /dev/null || ! command -v fzf &> /dev/null || ! command -v rg &> /dev/null || ! command -v fdfind &> /dev/null; then
    sudo apt install -y tmux fzf ripgrep fd-find
else
    echo "Productivity tools are already installed."
fi
# Ubuntu ships fd as `fdfind`; the shell config and tools expect `fd`.
if ! command -v fd &> /dev/null && command -v fdfind &> /dev/null; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd"
fi
if ! command -v zsh &> /dev/null; then
    sudo apt install -y zsh
else
    echo "ZSH is already installed."
fi
ZSH_PATH="$(command -v zsh)"
if [ "$(getent passwd "$USER" | cut -d: -f7)" != "$ZSH_PATH" ]; then
    echo "Making zsh the default login shell..."
    sudo chsh -s "$ZSH_PATH" "$USER"
fi

# Install Oh My Zsh, plugins, and Powerlevel10k (repairs a custom/-only partial install)
bash "$(dirname "${BASH_SOURCE[0]}")/setup-oh-my-zsh.sh"

# Warn on every apt run if a kernel update leaves out the NVIDIA module
bash "$(dirname "${BASH_SOURCE[0]}")/setup-nvidia-guard.sh"

# Install Lazygit
echo "Installing Lazygit..."
if ! command -v lazygit &> /dev/null; then
    install_verified_binary "$LAZYGIT_URL" "$LAZYGIT_SHA256" /usr/local/bin/lazygit lazygit
else
    echo "Lazygit is already installed."
fi

# Install Lazydocker
echo "Installing Lazydocker..."
if ! command -v lazydocker &> /dev/null; then
    install_verified_binary "$LAZYDOCKER_URL" "$LAZYDOCKER_SHA256" /usr/local/bin/lazydocker lazydocker
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
    sudo apt install -y ca-certificates curl gnupg lsb-release
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt update
    sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    
    # Add user to docker group
    sudo usermod -aG docker $USER
    echo "Added user to docker group. You may need to log out and log back in."
else
    echo "Docker is already installed."
fi

# Install Node.js and npm
echo "Installing Node.js and npm..."
if ! command -v node &> /dev/null; then
    install_nodejs
else
    echo "Node.js is already installed."
fi

# Install pnpm
echo "Installing pnpm..."
if ! command -v pnpm &> /dev/null; then
    # The installer's `pnpm setup` rewrites the rc file of $SHELL, replacing the
    # dotfiles symlink with a regular file. The dotfiles rc files already set
    # PNPM_HOME, so put any clobbered symlinks back afterwards.
    rc_links=()
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        [ -L "$rc" ] && rc_links+=("$rc" "$(readlink "$rc")")
    done
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    for ((i = 0; i < ${#rc_links[@]}; i += 2)); do
        rc="${rc_links[i]}"
        if [ ! -L "$rc" ]; then
            mv "$rc" "$HOME/.dotfiles_backup/$(basename "$rc").pnpm-setup"
            ln -s "${rc_links[i + 1]}" "$rc"
            echo "Restored dotfiles symlink $rc (pnpm setup had replaced it)"
        fi
    done
    # Add to PATH for current session (pnpm 11+ puts its binaries in $PNPM_HOME/bin)
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
    # Add to .zshrc for persistence
    if ! grep -q 'PNPM_HOME' ~/.zshrc 2>/dev/null; then
        echo 'export PNPM_HOME="$HOME/.local/share/pnpm"' >> ~/.zshrc
        echo 'export PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"' >> ~/.zshrc
    fi
else
    echo "pnpm is already installed."
fi

# Install Pi coding agent (config is linked by install.sh via setup-pi.sh)
echo "Installing Pi coding agent..."
if ! command -v pi &> /dev/null; then
    # Per-user install into ~/.local (already on PATH), not a root-run global install.
    npm install -g --prefix "$HOME/.local" "@earendil-works/pi-coding-agent@$PI_CODING_AGENT_VERSION"
    export PATH="$HOME/.local/bin:$PATH"
else
    echo "Pi is already installed."
fi

# Install Python tools
echo "Installing Python tools..."
if ! command -v pip3 &> /dev/null || ! dpkg -l | grep -q python3-venv; then
    sudo apt install -y python3-pip python3-venv
else
    echo "Python tools are already installed."
fi

# Install uv (Python package manager)
echo "Installing uv..."
if ! command -v uv &> /dev/null; then
    # uv installs to ~/.local/bin, which the dotfiles rc files already put on
    # PATH, so stop the installer appending to them.
    curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
    export PATH="$HOME/.local/bin:$PATH"
else
    echo "uv is already installed."
fi

# Install Kubernetes tools
echo "Installing Kubernetes tools..."
if ! command -v kubectl &> /dev/null; then
    install_verified_binary "$KUBECTL_URL" "$KUBECTL_SHA256" /usr/local/bin/kubectl
else
    echo "kubectl is already installed."
fi

if ! command -v helm &> /dev/null; then
    install_verified_binary "$HELM_URL" "$HELM_SHA256" /usr/local/bin/helm linux-amd64/helm
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

# Install Ollama
echo "Installing Ollama..."
if ! command -v ollama &> /dev/null; then
    # Ollama has no apt repository, so this runs the vendor's own installer
    # (it also sets up the ollama user, systemd service and GPU support).
    # Download it to a file first instead of piping it straight into a shell.
    OLLAMA_INSTALL="$(mktemp)"
    curl -fsSL --proto '=https' --tlsv1.2 https://ollama.com/install.sh -o "$OLLAMA_INSTALL"
    sh "$OLLAMA_INSTALL"
    rm -f "$OLLAMA_INSTALL"
else
    echo "Ollama is already installed."
fi

# Install VLC
echo "Installing VLC media player..."
if ! command -v vlc &> /dev/null; then
    sudo apt install -y vlc
else
    echo "VLC is already installed."
fi

# Install GNOME Browser Integration (native messaging host for extensions.gnome.org)
echo "Installing GNOME Browser Integration..."
if ! dpkg -l 2>/dev/null | grep -qE '^ii\s+(gnome-browser-connector|chrome-gnome-shell)\s'; then
    if apt-cache show gnome-browser-connector &> /dev/null; then
        sudo apt install -y gnome-browser-connector
    else
        sudo apt install -y chrome-gnome-shell
    fi
else
    echo "GNOME Browser Integration is already installed."
fi

# Install communication apps
echo "Installing communication apps..."
if ! snap list | grep -q slack; then
    sudo snap install slack
else
    echo "Slack is already installed."
fi
if ! snap list | grep -q discord; then
    sudo snap install discord
else
    echo "Discord is already installed."
fi
if ! snap list | grep -q zoom-client; then
    sudo snap install zoom-client
else
    echo "Zoom is already installed."
fi
if ! command -v thunderbird &> /dev/null; then
    sudo apt install -y thunderbird
else
    echo "Thunderbird is already installed."
fi

# Install Nerd Fonts
echo "Installing Nerd Fonts..."
FONT_DIR="$HOME/.local/share/fonts"
mkdir -p "$FONT_DIR"

# Move fonts from subdirectory to main directory if they exist
if [ -d "$FONT_DIR/NerdFonts" ]; then
    echo "Moving fonts from subdirectory to main fonts directory..."
    find "$FONT_DIR/NerdFonts" -type f \( -name "*.ttf" -o -name "*.otf" \) | while read -r font; do
        if [ -f "$font" ]; then
            mv "$font" "$FONT_DIR/" 2>/dev/null || true
        fi
    done
    # Remove empty subdirectory
    rmdir "$FONT_DIR/NerdFonts" 2>/dev/null || true
fi

# Install JetBrainsMono Nerd Font
JETBRAINS_INSTALLED=true
if ! find "$FONT_DIR" -type f \( -name "*JetBrainsMono*NerdFont*.ttf" -o -name "*JetBrainsMono*NerdFont*.otf" \) | grep -q .; then
    JETBRAINS_INSTALLED=false
    echo "Downloading JetBrainsMono Nerd Font..."
    TEMP_DIR=$(mktemp -d)
    cd "$TEMP_DIR"
    if curl -fLo "JetBrainsMono.zip" https://github.com/ryanoasis/nerd-fonts/releases/latest/download/JetBrainsMono.zip; then
        unzip -q -o JetBrainsMono.zip
        find . -type f \( -name "*.ttf" -o -name "*.otf" \) | while read -r font; do
            if [ -f "$font" ]; then
                mv "$font" "$FONT_DIR/" 2>/dev/null || true
            fi
        done
        rm -f JetBrainsMono.zip
        echo "JetBrainsMono Nerd Font installed."
    else
        echo "Failed to download JetBrainsMono Nerd Font."
    fi
    cd -
    rm -rf "$TEMP_DIR"
else
    echo "JetBrainsMono Nerd Font already installed."
fi

# Install FiraCode Nerd Font
FIRACODE_INSTALLED=true
if ! find "$FONT_DIR" -type f \( -name "*FiraCode*NerdFont*.ttf" -o -name "*FiraCode*NerdFont*.otf" \) | grep -q .; then
    FIRACODE_INSTALLED=false
    echo "Downloading FiraCode Nerd Font..."
    TEMP_DIR=$(mktemp -d)
    cd "$TEMP_DIR"
    if curl -fLo "FiraCode.zip" https://github.com/ryanoasis/nerd-fonts/releases/latest/download/FiraCode.zip; then
        unzip -q -o FiraCode.zip
        find . -type f \( -name "*.ttf" -o -name "*.otf" \) | while read -r font; do
            if [ -f "$font" ]; then
                mv "$font" "$FONT_DIR/" 2>/dev/null || true
            fi
        done
        rm -f FiraCode.zip
        echo "FiraCode Nerd Font installed."
    else
        echo "Failed to download FiraCode Nerd Font."
    fi
    cd -
    rm -rf "$TEMP_DIR"
else
    echo "FiraCode Nerd Font already installed."
fi

# Refresh font cache if fonts were installed
if [ "$JETBRAINS_INSTALLED" = false ] || [ "$FIRACODE_INSTALLED" = false ]; then
    if command -v fc-cache &> /dev/null; then
        echo "Refreshing font cache..."
        fc-cache -fv
    fi
fi

# Install MesloLGS NF fonts (required for Powerlevel10k)
echo "Installing MesloLGS NF fonts..."
FONT_DIR="$HOME/.local/share/fonts"
mkdir -p "$FONT_DIR"

MESLO_FONTS=(
    "MesloLGS NF Regular.ttf"
    "MesloLGS NF Bold.ttf"
    "MesloLGS NF Italic.ttf"
    "MesloLGS NF Bold Italic.ttf"
)

MESLO_URLS=(
    "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Regular.ttf"
    "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold.ttf"
    "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Italic.ttf"
    "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold%20Italic.ttf"
)

MESLO_INSTALLED=true
for i in "${!MESLO_FONTS[@]}"; do
    font_file="$FONT_DIR/${MESLO_FONTS[$i]}"
    # Check if font exists (handle filenames with spaces)
    if [[ ! -f "$font_file" ]]; then
        MESLO_INSTALLED=false
        echo "Downloading ${MESLO_FONTS[$i]}..."
        # Use -o with quoted filename to handle spaces correctly
        if curl -fL "${MESLO_URLS[$i]}" -o "$font_file"; then
            echo "Downloaded ${MESLO_FONTS[$i]}"
        else
            echo "Failed to download ${MESLO_FONTS[$i]}"
        fi
    else
        echo "MesloLGS NF font already exists: ${MESLO_FONTS[$i]}"
    fi
done

if [ "$MESLO_INSTALLED" = false ]; then
    if command -v fc-cache &> /dev/null; then
        echo "Refreshing font cache..."
        fc-cache -fv
    fi
    echo "MesloLGS NF fonts installed."
else
    echo "MesloLGS NF fonts are already installed."
fi

# Start services
echo "Starting services..."
if command -v docker &> /dev/null; then
    sudo systemctl enable docker
    sudo systemctl start docker
fi

# Display versions
echo ""
echo "Installation complete! Installed versions:"
echo "Git: $(git --version)"
echo "GitHub CLI: $(gh --version)"
echo "Python: $(python3 --version)"
echo "Java: $(java -version 2>&1 | head -n 1)"
if command -v go &> /dev/null; then
    echo "Go: $(go version)"
else
    echo "Go: Not found in PATH"
fi
if command -v rustc &> /dev/null; then
    echo "Rust: $(rustc --version)"
else
    echo "Rust: Not found in PATH"
fi
if command -v dotnet &> /dev/null; then
    echo ".NET SDK versions:"
    dotnet --list-sdks
else
    echo ".NET: Not found in PATH"
fi
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"
if command -v pnpm &> /dev/null; then
    echo "pnpm: $(pnpm --version)"
else
    echo "pnpm: Not found in PATH"
fi
if command -v uv &> /dev/null; then
    echo "uv: $(uv --version)"
else
    echo "uv: Not found in PATH"
fi
echo "HTTPie: $(httpie --version)"
echo "jq: $(jq --version)"
if command -v yq &> /dev/null; then
    echo "yq: $(yq --version)"
else
    echo "yq: Not found in PATH"
fi
if command -v kubectl &> /dev/null; then
    echo "kubectl: $(kubectl version --client --short 2>/dev/null || kubectl version --client)"
else
    echo "kubectl: Not found in PATH"
fi
if command -v helm &> /dev/null; then
    echo "Helm: $(helm version --short)"
else
    echo "Helm: Not found in PATH"
fi
if command -v ollama &> /dev/null; then
    echo "Ollama: $(ollama --version)"
else
    echo "Ollama: Not found in PATH"
fi
if command -v docker &> /dev/null; then
    echo "Docker: $(docker --version)"
else
    echo "Docker: Not found in PATH"
fi
echo "ripgrep: $(rg --version)"
echo "fd: $(fd --version)"
echo "tmux: $(tmux -V)"
if command -v nvim &> /dev/null; then
    echo "Neovim: $(nvim --version | head -n 1)"
else
    echo "Neovim: Not found in PATH"
fi
if command -v gdalinfo &> /dev/null; then
    echo "GDAL: $(gdalinfo --version)"
else
    echo "GDAL: Not found in PATH"
fi
if command -v proj &> /dev/null; then
    echo "PROJ: $(proj 2>&1 | head -n 1)"
else
    echo "PROJ: Not found in PATH"
fi
if command -v geos-config &> /dev/null; then
    echo "GEOS: $(geos-config --version)"
else
    echo "GEOS: Not found in PATH"
fi
if command -v spatialite &> /dev/null; then
    echo "SpatiaLite: $(spatialite --version 2>&1 | head -n 1)"
else
    echo "SpatiaLite: Not found in PATH"
fi
if command -v vlc &> /dev/null; then
    echo "VLC: $(vlc --version 2>&1 | head -n 1)"
else
    echo "VLC: Not found in PATH"
fi
if command -v lazygit &> /dev/null; then
    echo "Lazygit: $(lazygit --version 2>&1 | head -n 1)"
else
    echo "Lazygit: Not found in PATH"
fi
if command -v lazydocker &> /dev/null; then
    echo "Lazydocker: $(lazydocker --version 2>&1 | head -n 1)"
else
    echo "Lazydocker: Not found in PATH"
fi
if command -v nmap &> /dev/null; then
    echo "nmap: $(nmap --version 2>&1 | head -n 1)"
else
    echo "nmap: Not found in PATH"
fi
if command -v wireshark &> /dev/null; then
    echo "Wireshark: $(wireshark --version 2>&1 | head -n 1)"
else
    echo "Wireshark: Not found in PATH"
fi
if command -v tailscale &> /dev/null; then
    echo "Tailscale: $(tailscale version 2>&1 | head -n 1)"
else
    echo "Tailscale: Not found in PATH"
fi
if command -v wg &> /dev/null; then
    echo "Wireguard: $(wg --version 2>&1)"
else
    echo "Wireguard: Not found in PATH"
fi
if command -v ufw &> /dev/null; then
    echo "UFW: $(ufw version 2>&1 | head -n 1)"
else
    echo "UFW: Not found in PATH"
fi
if snap list slack &> /dev/null; then
    echo "Slack: Installed via snap"
fi
if snap list discord &> /dev/null; then
    echo "Discord: Installed via snap"
fi
if snap list zoom-client &> /dev/null; then
    echo "Zoom: Installed via snap"
fi
if command -v thunderbird &> /dev/null; then
    echo "Thunderbird: $(thunderbird --version 2>&1 | head -n 1)"
else
    echo "Thunderbird: Not found in PATH"
fi
if dpkg -l 2>/dev/null | grep -qE '^ii\s+(gnome-browser-connector|chrome-gnome-shell)\s'; then
    echo "GNOME Browser Integration: Installed"
else
    echo "GNOME Browser Integration: Not installed"
fi
if fc-list | grep -q "Nerd Font"; then
    echo "Nerd Fonts: Installed"
else
    echo "Nerd Fonts: Not found"
fi

echo ""
echo "Note: You may need to restart your terminal or run 'source ~/.zshrc' for PATH changes to take effect."
echo "If you were added to the docker group, you may need to log out and log back in."
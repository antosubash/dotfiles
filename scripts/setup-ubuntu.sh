#!/bin/bash

set -e

echo "Installing latest versions of development tools on Ubuntu..."

# Update package manager
echo "Updating package manager..."
sudo apt update

# Install basic system tools
echo "Installing basic system tools..."
if ! command -v git &> /dev/null || ! command -v curl &> /dev/null || ! command -v wget &> /dev/null; then
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
    wget https://go.dev/dl/go1.21.5.linux-amd64.tar.gz
    sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.21.5.linux-amd64.tar.gz
    rm go1.21.5.linux-amd64.tar.gz
    if ! grep -q 'export PATH=$PATH:/usr/local/go/bin' ~/.zshrc 2>/dev/null; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.zshrc
    fi
    export PATH=$PATH:/usr/local/go/bin
else
    echo "Go is already installed."
fi
if ! command -v rustc &> /dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source ~/.cargo/env
    if ! grep -q 'source ~/.cargo/env' ~/.zshrc 2>/dev/null; then
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
    sudo wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq && sudo chmod +x /usr/bin/yq
else
    echo "yq is already installed."
fi
if ! command -v curlie &> /dev/null; then
    if command -v go &> /dev/null; then
        go install github.com/rs/curlie@v1.6.0
        if ! grep -q 'export PATH=$PATH:~/go/bin' ~/.zshrc 2>/dev/null; then
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

# Install productivity tools
echo "Installing productivity tools..."
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

# Install Oh My Zsh and plugins
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    echo "Installing Oh My Zsh..."
    RUNZSH=no sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
    # Install zsh-autosuggestions
    git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
    # Install zsh-syntax-highlighting
    git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
    # Update .zshrc to include plugins
    sed -i 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting)/' ~/.zshrc
else
    echo "Oh My Zsh is already installed."
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
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js is already installed."
fi

# Install pnpm
echo "Installing pnpm..."
if ! command -v pnpm &> /dev/null; then
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    # Add to PATH for current session
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export PATH="$PNPM_HOME:$PATH"
    # Add to .zshrc for persistence
    if ! grep -q 'PNPM_HOME' ~/.zshrc 2>/dev/null; then
        echo 'export PNPM_HOME="$HOME/.local/share/pnpm"' >> ~/.zshrc
        echo 'export PATH="$PNPM_HOME:$PATH"' >> ~/.zshrc
    fi
else
    echo "pnpm is already installed."
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
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # Add to PATH for current session (ZSH)
    export PATH="$HOME/.cargo/bin:$PATH"
    # Add to .zshrc for persistence
    if ! grep -q 'export PATH="$HOME/.cargo/bin:$PATH"' ~/.zshrc 2>/dev/null; then
        echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc
    fi
else
    echo "uv is already installed."
fi

# Install Kubernetes tools
echo "Installing Kubernetes tools..."
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

# Install Ollama
echo "Installing Ollama..."
if ! command -v ollama &> /dev/null; then
    curl -fsSL https://ollama.com/install.sh | sh
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
if [ ! -d "$HOME/.local/share/fonts/NerdFonts" ]; then
    mkdir -p ~/.local/share/fonts/NerdFonts
    cd ~/.local/share/fonts/NerdFonts
    echo "Downloading JetBrainsMono Nerd Font..."
    curl -fLo "JetBrainsMono.zip" https://github.com/ryanoasis/nerd-fonts/releases/latest/download/JetBrainsMono.zip
    unzip -o JetBrainsMono.zip
    rm JetBrainsMono.zip
    echo "Downloading FiraCode Nerd Font..."
    curl -fLo "FiraCode.zip" https://github.com/ryanoasis/nerd-fonts/releases/latest/download/FiraCode.zip
    unzip -o FiraCode.zip
    rm FiraCode.zip
    fc-cache -fv
    cd -
    echo "Nerd Fonts installed."
else
    echo "Nerd Fonts are already installed."
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
if fc-list | grep -q "Nerd Font"; then
    echo "Nerd Fonts: Installed"
else
    echo "Nerd Fonts: Not found"
fi

echo ""
echo "Note: You may need to restart your terminal or run 'source ~/.zshrc' for PATH changes to take effect."
echo "If you were added to the docker group, you may need to log out and log back in."
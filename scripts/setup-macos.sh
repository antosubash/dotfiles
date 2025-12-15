#!/bin/bash

set -e

echo "Installing latest versions of development tools on macOS..."

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
    echo "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    
    # Add Homebrew to PATH for Apple Silicon Macs
    if [[ $(uname -m) == "arm64" ]]; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zshrc
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
else
    echo "Homebrew is already installed. Updating..."
    brew update
fi

# Install basic system tools
echo "Installing basic system tools..."
brew install curl wget htop neofetch vim git

# Install development environments
echo "Installing development environments..."
brew install python@3.11 openjdk go rust

# Install .NET SDK
echo "Installing .NET SDK..."
brew install --cask dotnet

# Install API and testing tools
echo "Installing API and testing tools..."
brew install httpie jq yq

# Install curlie via go
if ! command -v curlie &> /dev/null; then
    go install github.com/rs/curlie@latest
else
    echo "curlie is already installed."
fi

# Install security tools
echo "Installing security tools..."
brew install gnupg pass

# Install network security tools
echo "Installing network security tools..."
brew install nmap wireshark

# Install VPN tools
echo "Installing VPN tools..."
brew install tailscale

# Install productivity tools
echo "Installing productivity tools..."
brew install tmux fzf ripgrep fd

# Install Zsh if not already installed (macOS usually comes with it)
if ! command -v zsh &> /dev/null; then
    brew install zsh
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
    sed -i '' 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting)/' ~/.zshrc
else
    echo "Oh My Zsh is already installed."
fi

# Install Lazygit
echo "Installing Lazygit..."
brew install lazygit

# Install Lazydocker
echo "Installing Lazydocker..."
brew install lazydocker

# Install GitHub CLI
echo "Installing GitHub CLI..."
brew install gh

# Install Docker
echo "Installing Docker..."
brew install --cask docker

# Install Node.js and npm
echo "Installing Node.js and npm..."
brew install node

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
brew install python3-pip

# Install uv (Python package manager)
echo "Installing uv..."
if ! command -v uv &> /dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # Add to PATH for current session
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
brew install kubectl helm

# Install database clients
echo "Installing database clients..."
brew install postgresql

# Install GDAL and geospatial tools
echo "Installing GDAL and geospatial tools..."
brew install gdal proj geos spatialite-tools

# Install Ollama
echo "Installing Ollama..."
if ! command -v ollama &> /dev/null; then
    curl -fsSL https://ollama.com/install.sh | sh
else
    echo "Ollama is already installed."
fi

# Install VLC
echo "Installing VLC media player..."
brew install --cask vlc

# Install communication apps
echo "Installing communication apps..."
brew install --cask slack discord zoom

# Install email client
echo "Installing email client..."
brew install --cask thunderbird

# Install Nerd Fonts
echo "Installing Nerd Fonts..."
brew install font-jetbrains-mono-nerd-font font-fira-code-nerd-font

# Start services
echo "Starting services..."
if command -v docker &> /dev/null; then
    # Docker Desktop on macOS needs to be started manually
    echo "Please start Docker Desktop manually from Applications folder."
fi

# Display versions
echo ""
echo "Installation complete! Installed versions:"
echo "Homebrew: $(brew --version | head -n 1)"
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
if fc-list | grep -q "Nerd Font"; then
    echo "Nerd Fonts: Installed"
else
    echo "Nerd Fonts: Not found"
fi

echo ""
echo "Note: You may need to restart your terminal or run 'source ~/.zshrc' for PATH changes to take effect."
echo "Please start Docker Desktop manually from Applications folder if you haven't already."
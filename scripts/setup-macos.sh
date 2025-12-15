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
tools_to_install=()
for tool in curl wget htop neofetch vim git; do
    if ! command -v $tool &> /dev/null; then
        tools_to_install+=($tool)
    fi
done

if [ ${#tools_to_install[@]} -gt 0 ]; then
    echo "Installing missing tools: ${tools_to_install[*]}"
    brew install ${tools_to_install[@]}
else
    echo "All basic system tools are already installed."
fi

# Install development environments
echo "Installing development environments..."
dev_tools_to_install=()

# Check Python
if ! command -v python3 &> /dev/null; then
    dev_tools_to_install+=("python@3.11")
else
    echo "Python3 is already installed."
fi

# Check Java
if ! command -v java &> /dev/null; then
    dev_tools_to_install+=("openjdk")
else
    echo "Java is already installed."
fi

# Check Go
if ! command -v go &> /dev/null; then
    dev_tools_to_install+=("go")
else
    echo "Go is already installed."
fi

# Check Rust
if ! command -v rustc &> /dev/null; then
    dev_tools_to_install+=("rust")
else
    echo "Rust is already installed."
fi

if [ ${#dev_tools_to_install[@]} -gt 0 ]; then
    echo "Installing missing development tools: ${dev_tools_to_install[*]}"
    brew install ${dev_tools_to_install[@]}
else
    echo "All development environments are already installed."
fi

# Install .NET SDK
echo "Installing .NET SDK..."
if ! command -v dotnet &> /dev/null; then
    brew install --cask dotnet
else
    echo ".NET SDK is already installed."
fi

# Install API and testing tools
echo "Installing API and testing tools..."
api_tools_to_install=()

if ! command -v http &> /dev/null; then
    api_tools_to_install+=("httpie")
else
    echo "HTTPie is already installed."
fi

if ! command -v jq &> /dev/null; then
    api_tools_to_install+=("jq")
else
    echo "jq is already installed."
fi

if ! command -v yq &> /dev/null; then
    api_tools_to_install+=("yq")
else
    echo "yq is already installed."
fi

if [ ${#api_tools_to_install[@]} -gt 0 ]; then
    echo "Installing missing API tools: ${api_tools_to_install[*]}"
    brew install ${api_tools_to_install[@]}
else
    echo "All API testing tools are already installed."
fi

# Install curlie via go
if ! command -v curlie &> /dev/null; then
    go install github.com/rs/curlie@latest
else
    echo "curlie is already installed."
fi

# Install security tools
echo "Installing security tools..."
security_tools_to_install=()

if ! command -v gpg &> /dev/null; then
    security_tools_to_install+=("gnupg")
else
    echo "GPG is already installed."
fi

if ! command -v pass &> /dev/null; then
    security_tools_to_install+=("pass")
else
    echo "pass is already installed."
fi

if [ ${#security_tools_to_install[@]} -gt 0 ]; then
    echo "Installing missing security tools: ${security_tools_to_install[*]}"
    brew install ${security_tools_to_install[@]}
else
    echo "All security tools are already installed."
fi

# Install network security tools
echo "Installing network security tools..."
net_tools_to_install=()

if ! command -v nmap &> /dev/null; then
    net_tools_to_install+=("nmap")
else
    echo "nmap is already installed."
fi

if ! command -v wireshark &> /dev/null; then
    net_tools_to_install+=("wireshark")
else
    echo "Wireshark is already installed."
fi

if [ ${#net_tools_to_install[@]} -gt 0 ]; then
    echo "Installing missing network tools: ${net_tools_to_install[*]}"
    brew install ${net_tools_to_install[@]}
else
    echo "All network security tools are already installed."
fi

# Install VPN tools
echo "Installing VPN tools..."
if ! command -v tailscale &> /dev/null; then
    brew install tailscale
else
    echo "Tailscale is already installed."
fi

# Install productivity tools
echo "Installing productivity tools..."
prod_tools_to_install=()

if ! command -v tmux &> /dev/null; then
    prod_tools_to_install+=("tmux")
else
    echo "tmux is already installed."
fi

if ! command -v fzf &> /dev/null; then
    prod_tools_to_install+=("fzf")
else
    echo "fzf is already installed."
fi

if ! command -v rg &> /dev/null; then
    prod_tools_to_install+=("ripgrep")
else
    echo "ripgrep is already installed."
fi

if ! command -v fd &> /dev/null; then
    prod_tools_to_install+=("fd")
else
    echo "fd is already installed."
fi

if [ ${#prod_tools_to_install[@]} -gt 0 ]; then
    echo "Installing missing productivity tools: ${prod_tools_to_install[*]}"
    brew install ${prod_tools_to_install[@]}
else
    echo "All productivity tools are already installed."
fi

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
if ! command -v lazygit &> /dev/null; then
    brew install lazygit
else
    echo "Lazygit is already installed."
fi

# Install Lazydocker
echo "Installing Lazydocker..."
if ! command -v lazydocker &> /dev/null; then
    brew install lazydocker
else
    echo "Lazydocker is already installed."
fi

# Install GitHub CLI
echo "Installing GitHub CLI..."
if ! command -v gh &> /dev/null; then
    brew install gh
else
    echo "GitHub CLI is already installed."
fi

# Install Docker
echo "Installing Docker..."
if ! command -v docker &> /dev/null && [ ! -d "/Applications/Docker.app" ]; then
    brew install --cask docker
else
    echo "Docker Desktop is already installed."
fi

# Install Node.js and npm
echo "Installing Node.js and npm..."
if ! command -v node &> /dev/null; then
    brew install node
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
if ! command -v pip3 &> /dev/null; then
    brew install python3-pip
else
    echo "Python3 pip is already installed."
fi

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
k8s_tools_to_install=()

if ! command -v kubectl &> /dev/null; then
    k8s_tools_to_install+=("kubectl")
else
    echo "kubectl is already installed."
fi

if ! command -v helm &> /dev/null; then
    k8s_tools_to_install+=("helm")
else
    echo "Helm is already installed."
fi

if [ ${#k8s_tools_to_install[@]} -gt 0 ]; then
    echo "Installing missing Kubernetes tools: ${k8s_tools_to_install[*]}"
    brew install ${k8s_tools_to_install[@]}
else
    echo "All Kubernetes tools are already installed."
fi

# Install database clients
echo "Installing database clients..."
if ! command -v psql &> /dev/null; then
    brew install postgresql
else
    echo "PostgreSQL client is already installed."
fi

# Install GDAL and geospatial tools
echo "Installing GDAL and geospatial tools..."
geospatial_tools_to_install=()

if ! command -v gdalinfo &> /dev/null; then
    geospatial_tools_to_install+=("gdal")
else
    echo "GDAL is already installed."
fi

if ! command -v proj &> /dev/null; then
    geospatial_tools_to_install+=("proj")
else
    echo "PROJ is already installed."
fi

if ! command -v geos-config &> /dev/null; then
    geospatial_tools_to_install+=("geos")
else
    echo "GEOS is already installed."
fi

if ! command -v spatialite &> /dev/null; then
    geospatial_tools_to_install+=("spatialite-tools")
else
    echo "SpatiaLite tools are already installed."
fi

if [ ${#geospatial_tools_to_install[@]} -gt 0 ]; then
    echo "Installing missing geospatial tools: ${geospatial_tools_to_install[*]}"
    brew install ${geospatial_tools_to_install[@]}
else
    echo "All geospatial tools are already installed."
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
if [ ! -d "/Applications/VLC.app" ]; then
    brew install --cask vlc
else
    echo "VLC is already installed."
fi

# Install communication apps
echo "Installing communication apps..."
comm_apps_to_install=()

if [ ! -d "/Applications/Slack.app" ]; then
    comm_apps_to_install+=("slack")
else
    echo "Slack is already installed."
fi

if [ ! -d "/Applications/Discord.app" ]; then
    comm_apps_to_install+=("discord")
else
    echo "Discord is already installed."
fi

if [ ! -d "/Applications/Zoom.app" ]; then
    comm_apps_to_install+=("zoom")
else
    echo "Zoom is already installed."
fi

if [ ${#comm_apps_to_install[@]} -gt 0 ]; then
    echo "Installing missing communication apps: ${comm_apps_to_install[*]}"
    brew install --cask ${comm_apps_to_install[@]}
else
    echo "All communication apps are already installed."
fi



# Install Nerd Fonts
echo "Installing Nerd Fonts..."
nerd_fonts_to_install=()

if ! fc-list | grep -q "JetBrainsMono Nerd Font"; then
    nerd_fonts_to_install+=("font-jetbrains-mono-nerd-font")
else
    echo "JetBrains Mono Nerd Font is already installed."
fi

if ! fc-list | grep -q "FiraCode Nerd Font"; then
    nerd_fonts_to_install+=("font-fira-code-nerd-font")
else
    echo "FiraCode Nerd Font is already installed."
fi

if [ ${#nerd_fonts_to_install[@]} -gt 0 ]; then
    echo "Installing missing Nerd Fonts: ${nerd_fonts_to_install[*]}"
    brew install ${nerd_fonts_to_install[@]}
else
    echo "All Nerd Fonts are already installed."
fi

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
# Wireguard check not applicable to macOS (built into the OS)
echo "Wireguard: Built into macOS"

# Check GUI applications
if [ -d "/Applications/Slack.app" ]; then
    echo "Slack: Installed in Applications"
else
    echo "Slack: Not found"
fi

if [ -d "/Applications/Discord.app" ]; then
    echo "Discord: Installed in Applications"
else
    echo "Discord: Not found"
fi

if [ -d "/Applications/Zoom.app" ]; then
    echo "Zoom: Installed in Applications"
else
    echo "Zoom: Not found"
fi



if [ -d "/Applications/VLC.app" ]; then
    echo "VLC: Installed in Applications"
else
    echo "VLC: Not found"
fi

echo ""
echo "Note: You may need to restart your terminal or run 'source ~/.zshrc' for PATH changes to take effect."
echo "Please start Docker Desktop manually from Applications folder if you haven't already."
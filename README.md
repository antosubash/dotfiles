# Dotfiles

A comprehensive cross-platform development environment setup with automated installation, themes, and update management.

## 🚀 Quick Start

### 1. Clone Repository

```bash
git clone https://github.com/antosubash/dotfiles ~/dotfiles
```

### 2. Run Installation

```bash
cd ~/dotfiles
./install.sh
```

On Windows, the equivalent symlink installer is:

```powershell
pwsh -ExecutionPolicy Bypass -File .\install.ps1
```

### 3. Set Up Development Environment

#### macOS

```bash
./scripts/setup-macos.sh
```

#### Ubuntu/Linux

```bash
./scripts/setup-ubuntu.sh
```

#### Ubuntu Server (headless)

```bash
./scripts/setup-server.sh
```

#### Windows

```powershell
# From an elevated PowerShell 7+ session:
pwsh -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

Uses **winget** for GUI apps (browsers, IDEs, Docker Desktop,
communication apps) and **scoop** for CLI dev tools (gh, jq, fzf,
ripgrep, fd, lazygit, kubectl, helm, neovim, etc.). Installs language
runtimes (Node LTS, Python 3.12, Go, Rust, Temurin JDK 21, .NET SDK
7/8/9 + preview 10), enables WSL2 + Ubuntu so `setup-ubuntu.sh` can
run inside WSL, and configures the terminal (Windows Terminal with
Catppuccin Mocha + MesloLGS NF, oh-my-posh prompt, PSReadLine
predictions, Alacritty linked to `config/alacritty.toml`). Flags:
`-SkipWSL`, `-SkipFonts`, `-SkipGUI`, `-SkipTerminal`, `-BootstrapWSL`.

Pass `-BootstrapWSL` once your Ubuntu distro is initialized with a
user account — it'll clone the dotfiles inside Ubuntu and run
`install.sh` for you.

To re-run terminal config only:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\setup-windows-terminal.ps1
```

To update everything later:

```powershell
pwsh -File .\scripts\update-windows.ps1          # full pass
pwsh -File .\scripts\update-windows.ps1 -Quick   # winget + scoop + rustup only
```

Headless variant: same dev toolchain as `setup-ubuntu.sh` (Java,
.NET 7/8/9/10, Go, Rust, Node, Python/uv, Docker, k8s, GDAL/PROJ/GEOS,
etc.) but drops GUI items (Wireshark, VLC, Thunderbird, snap chat apps,
terminal fonts) and adds server essentials: `openssh-server`,
`unattended-upgrades`, `fail2ban`, `sysstat`, `ncdu`, `iotop`, plus a
UFW default config that allows SSH.

### 4. Install Update Commands

```bash
./scripts/setup-update.sh
```

## 📁 Structure

```
dotfiles/
├── install.sh              # Main dotfiles installation (macOS / Linux)
├── install.ps1             # Main dotfiles installation (Windows)
├── scripts/
│   ├── setup-macos.sh      # macOS full development setup
│   ├── setup-ubuntu.sh     # Ubuntu desktop development setup
│   ├── setup-server.sh     # Ubuntu Server (headless) setup
│   ├── setup-windows.ps1   # Windows development setup (winget + scoop)
│   ├── setup-windows-terminal.ps1 # Windows Terminal + oh-my-posh + Alacritty
│   ├── update-windows.ps1  # Update winget + scoop + modules + WSL distros
│   ├── setup-agnoster.sh   # Agnoster theme installer
│   ├── setup-terminal.sh    # Terminal theme configuration
│   ├── setup-update.sh     # Update command installer
│   ├── update-all.sh       # Full system updater
│   └── update-quick.sh     # Quick daily updater
├── shell/
│   ├── .zshrc             # Enhanced Zsh configuration
│   ├── .bashrc            # Bash configuration (Ubuntu)
│   ├── .profile           # Shell profile
│   └── agnoster.zsh-theme # Agnoster theme
├── git/
│   └── .gitconfig         # Git configuration
├── vim/
│   └── .vimrc             # Vim configuration
└── config/
    └── terminal-colors.md  # Terminal color schemes
```

## 🛠️ Installation Guide

### 1. Basic Dotfiles Setup

```bash
# Clone repository
git clone https://github.com/antosubash/dotfiles ~/dotfiles

# Install dotfiles (creates symlinks)
cd ~/dotfiles
./install.sh

# Restart your terminal or run:
source ~/.zshrc  # or ~/.bashrc on Ubuntu
```

### 2. Development Environment Setup

Choose your platform:

#### macOS

```bash
./scripts/setup-macos.sh
```

#### Ubuntu/Linux

```bash
./scripts/setup-ubuntu.sh
```

**What gets installed:**
- 📦 Package managers (Homebrew / apt / winget + scoop)
- 💻 Languages (Node.js, Python, Java, Go, Rust, .NET)
- 🐳 Container tools (Docker, Kubernetes, Helm)
- 🔧 Productivity tools (tmux, fzf, ripgrep, fd)
- 🌐 API tools (HTTPie, jq, yq, curlie)
- 🔐 Security tools (GPG, pass, nmap, Wireshark)
- 📱 Communication apps (Slack, Discord, Zoom)
- 🗺️ Geospatial tools (GDAL, PROJ, GEOS)
- 🔤 Nerd Fonts (JetBrainsMono, FiraCode, MesloLGS NF)
- 🪟 Windows extras: Windows Terminal w/ Catppuccin Mocha, oh-my-posh, PSReadLine, Alacritty, WSL2 + Ubuntu (optional auto-bootstrap)

### 3. Shell Theme Setup

#### Agnoster Theme (Recommended)

```bash
# Install Agnoster theme with fonts
./scripts/setup-agnoster.sh

# Set terminal font to "Meslo LG Nerd Font"
# Restart terminal
```

#### Custom Terminal Themes

```bash
# Configure terminal colors
./scripts/setup-terminal.sh
```

### 4. Update System Setup

```bash
# Install update commands
./scripts/setup-update.sh

# Available commands after installation:
update          # Full system update
update-quick    # Fast daily update
update-manager  # Interactive manager
```

## 🎯 Available Commands

### Update Commands

```bash
update              # Full update of all tools
update-quick        # Fast daily updates (package managers only)
update-manager      # Interactive update interface
update --cleanup    # Clean caches and old files

# Aliases
upd                 # Quick update alias
upf                 # Full update alias
upc                 # Cleanup alias
```

### Development Shortcuts

```bash
# Git
gs, ga, gc, gp, gl  # Git status, add, commit, push, log
gd, gco             # Git diff, checkout

# Docker
d, dc, dps, di       # Docker, docker-compose, ps, images

# Node.js
ns, nr, ni, nb       # npm start, run, install, build

# Navigation & Files
ll, la, lt           # Enhanced ls commands
mkcd                 # Make and enter directory
extract              # Universal archive extractor
```

### Utility Functions

```bash
backup <file>        # Create timestamped backup
server [port]        # Start quick web server
checkport <port>     # Check what's using a port
replace <search> <replace> <dir>  # Find and replace
```

## 🎨 Shell Customization

### Agnoster Theme Features

- **Smart Context**: Shows user@host only for SSH
- **Git Integration**: Branch status, dirty/clean indicators  
- **Development Tools**: Node.js, Rust, Go detection
- **Cloud Tools**: Kubernetes, Docker, AWS profiles
- **Execution Time**: Command duration tracking
- **Status Indicators**: Error codes, background jobs

### Customizing Theme

The Agnoster theme uses default Oh My Zsh settings. You can customize it by editing your `.zshrc` file or creating a custom theme file in `~/.oh-my-zsh/custom/themes/`.

### Terminal Colors

Use Nordic color scheme in `config/terminal-colors.md` for consistency.

## 🔄 Maintenance

### Daily Usage

```bash
# Quick daily update
update-quick

# Check what's outdated
update-manager status
```

### Weekly Maintenance

```bash
# Full system update
update

# Clean up system
update --cleanup
```

### Manual Updates

```bash
# Package managers only
brew update && brew upgrade    # macOS
sudo apt update && sudo apt upgrade  # Ubuntu

# Language-specific
npm update -g                 # Node.js
pip3 list --outdated          # Python
rustup update                 # Rust
```

## 🌍 Cross-Platform Support

This dotfiles setup works seamlessly on:

### macOS

- 🍎 Homebrew package management
- 🖥️ Terminal.app and iTerm2 support
- 💼 Cocoa application installation
- 🔤 Native font management

### Ubuntu/Linux

- 🐧 APT package management
- 📦 Snap and Flatpak support
- 🔧 System service management
- 🎯 Desktop environment integration

**Automatic Detection:**
- OS type (macOS/Linux)
- Shell type (Zsh/Bash)
- Package manager availability
- Installed applications

## 🛠️ Troubleshooting

### Common Issues

#### Font Issues with Agnoster

```bash
# Install required fonts
./scripts/setup-agnoster.sh
# Set terminal font to "Meslo LG Nerd Font"
```

#### Command Not Found

```bash
# Reinstall update commands
./scripts/setup-update.sh
# Restart terminal or source shell config
source ~/.zshrc
```

#### Permission Denied

```bash
# Make scripts executable
chmod +x ~/dotfiles/scripts/*.sh
```

#### Oh My Zsh Issues

```bash
# Reinstall Oh My Zsh
sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
```

### Getting Help

#### Update Manager

```bash
update-manager help  # Show all update options
```

#### Script Help

```bash
./scripts/setup-macos.sh --help
./scripts/update-all.sh --help
```

#### Check Versions

```bash
update-manager status  # Check all tool versions
```

## 📚 Advanced Usage

### Custom Aliases

Add to `~/.zshrc.local`:

```bash
# Your custom aliases
alias myproject="cd ~/projects/myapp"
alias test="./scripts/test.sh"
```

### Environment Variables

Add to `~/.local/bin/env`:

```bash
# Custom environment variables
export API_KEY="your-key-here"
export DATABASE_URL="postgresql://..."
```

### Project Templates

Create project templates in `~/dotfiles/templates/` for quick scaffolding.

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Make your changes
4. Test on both platforms if possible
5. Submit pull request

## 📄 License

This repository follows the MIT License - feel free to use and modify for your own needs.

---

## 🎉 Enjoy Your New Development Environment!

You now have a powerful, cross-platform development setup with:
- ⚡ Automated updates
- 🎨 Beautiful themes
- 🛠️ Rich tooling
- 🔄 Cross-platform compatibility
- 📦 Intelligent package management

Happy coding! 🚀
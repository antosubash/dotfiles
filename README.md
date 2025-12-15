# Dotfiles

A collection of my personal configuration files for macOS development environment.

## Structure

```
dotfiles/
├── install.sh          # Dotfiles installation script
├── scripts/
│   ├── setup-macos.sh  # macOS development environment setup
│   └── setup-ubuntu.sh # Ubuntu development environment setup
├── git/
│   └── .gitconfig      # Git configuration
├── shell/
│   ├── .zshrc          # Zsh configuration
│   ├── .bashrc         # Bash configuration (for Ubuntu)
│   └── .profile        # Shell profile
├── vim/
│   └── .vimrc          # Vim configuration
└── config/             # Application-specific configs
```

## Installation

1. Clone this repository:
```bash
git clone https://github.com/antosubash/dotfiles ~/dotfiles
```

2. Run the installation script:
```bash
cd ~/dotfiles
./install.sh
```

2. Run the installation script:
```bash
cd ~/dotfiles
chmod +x install.sh
./install.sh
```

The script will:
- Backup any existing dotfiles to `~/.dotfiles_backup`
- Create symbolic links to the new configuration files
- Restart your shell to apply changes

## Features

- **Git**: Personal configuration with LFS support
- **Zsh**: Oh My Zsh setup with useful plugins and aliases
- **Vim**: Clean configuration with syntax highlighting and custom mappings
- **Shell aliases**: Common development shortcuts

## Requirements

- macOS or Linux (Ubuntu/Debian)
- Zsh or Bash shell
- Git
- Vim (optional)

## Cross-Platform Compatibility

This dotfiles setup works on both macOS and Ubuntu/Linux systems:
- Automatically detects the operating system
- Adapts to the detected shell (Zsh or Bash)
- Installs appropriate configuration files for each platform

## Development Environment Setup

For a complete development environment, use the platform-specific setup scripts:

### macOS
```bash
cd ~/dotfiles
./scripts/setup-macos.sh
```

### Ubuntu/Linux
```bash
cd ~/dotfiles
./scripts/setup-ubuntu.sh
```

These scripts install:
- Development tools (Git, Node.js, Python, Java, Go, Rust, .NET)
- API testing tools (HTTPie, jq, yq, curlie)
- Security tools (GPG, pass, nmap, Wireshark)
- VPN tools (Tailscale, Wireguard)
- Productivity tools (tmux, fzf, ripgrep, fd)
- Container tools (Docker, Kubernetes, Helm)
- Database clients (PostgreSQL)
- Geospatial tools (GDAL, PROJ, GEOS, SpatiaLite)
- Communication apps (Slack, Discord, Zoom, Thunderbird)
- Nerd Fonts
- And much more...

## Customization

Feel free to modify any configuration files to suit your preferences. After making changes, run the installation script again to update the symlinks.

## Backup

The installation script automatically creates backups of existing configuration files in `~/.dotfiles_backup`.
# Dotfiles

A collection of my personal configuration files for macOS development environment.

## Structure

```
dotfiles/
├── install.sh          # Installation script
├── git/
│   └── .gitconfig      # Git configuration
├── shell/
│   ├── .zshrc          # Zsh configuration
│   └── .profile        # Shell profile
├── vim/
│   └── .vimrc          # Vim configuration
└── config/             # Application-specific configs
```

## Installation

1. Clone this repository:
```bash
git clone <repository-url> ~/dotfiles
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

## Customization

Feel free to modify any configuration files to suit your preferences. After making changes, run the installation script again to update the symlinks.

## Backup

The installation script automatically creates backups of existing configuration files in `~/.dotfiles_backup`.
#!/bin/bash

# Update Command Installer
# Creates convenient `update` command for your system

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}✓${NC} $1"
}

info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

DOTFILES_DIR="$HOME/dotfiles"
BIN_DIR="$HOME/.local/bin"
UPDATE_SCRIPT="$DOTFILES_DIR/scripts/update-all.sh"
QUICK_UPDATE_SCRIPT="$DOTFILES_DIR/scripts/update-quick.sh"

# Create bin directory if it doesn't exist
mkdir -p "$BIN_DIR"

# Create main update command
create_update_command() {
    info "Creating 'update' command..."
    
    cat > "$BIN_DIR/update" << 'EOF'
#!/bin/bash
# Universal update command

SCRIPT_DIR="$HOME/dotfiles/scripts"

if [[ -f "$SCRIPT_DIR/update-all.sh" ]]; then
    exec "$SCRIPT_DIR/update-all.sh" "$@"
else
    echo "Error: update-all.sh not found"
    exit 1
fi
EOF
    
    chmod +x "$BIN_DIR/update"
    log "'update' command created"
}

# Create quick update command
create_quick_update_command() {
    info "Creating 'update-quick' command..."
    
    cat > "$BIN_DIR/update-quick" << 'EOF'
#!/bin/bash
# Quick update command

SCRIPT_DIR="$HOME/dotfiles/scripts"

if [[ -f "$SCRIPT_DIR/update-quick.sh" ]]; then
    exec "$SCRIPT_DIR/update-quick.sh"
else
    echo "Error: update-quick.sh not found"
    exit 1
fi
EOF
    
    chmod +x "$BIN_DIR/update-quick"
    log "'update-quick' command created"
}

# Create update alias file
create_alias_file() {
    info "Creating update aliases..."
    
    cat > "$HOME/.update_aliases" << 'EOF'
# Update command aliases
alias update='~/.local/bin/update'
alias update-all='~/.local/bin/update'
alias update-quick='~/.local/bin/update-quick'
alias update-full='~/.local/bin/update --full'
alias update-clean='~/.local/bin/update --cleanup'

# Convenience aliases
alias upd='update-quick'
alias upf='update --full'
alias upc='update --cleanup'

# Package manager specific updates
if [[ "$OSTYPE" == "darwin"* ]]; then
    alias brew-up='brew update && brew upgrade && brew cleanup'
    alias mac-up='update'
else
    alias apt-up='sudo apt update && sudo apt upgrade -y && sudo apt autoremove -y'
    alias linux-up='update'
fi

# Language specific updates
alias npm-up='npm update -g'
alias pip-up='pip3 list --outdated --format=freeze | grep -v "^\-e" | cut -d "=" -f 1 | xargs -n1 pip3 install -U'
alias rust-up='rustup update'
alias go-up='go install -a all'
alias dotnet-up='dotnet tool list --global | tail -n +3 | awk "{print $1}" | xargs -I {} dotnet tool update --global {}'

# Dev tools updates
alias ohmy-up='omz update'
alias gh-up='gh extension upgrade --all'
alias docker-up='docker system prune -f'
EOF
    
    log "Update aliases created in ~/.update_aliases"
}

# Update shell configurations
update_shell_configs() {
    info "Updating shell configurations..."
    
    # Update .zshrc
    if [[ -f "$HOME/dotfiles/shell/.zshrc" ]]; then
        if ! grep -q "update command aliases" "$HOME/dotfiles/shell/.zshrc"; then
            cat >> "$HOME/dotfiles/shell/.zshrc" << 'EOF'

# Update command aliases
if [ -f "$HOME/.update_aliases" ]; then
    source "$HOME/.update_aliases"
fi

# Update commands
alias update='~/.local/bin/update'
alias update-quick='~/.local/bin/update-quick'
alias upd='update-quick'
alias upf='update'
EOF
            log "Updated .zshrc with update aliases"
        else
            log ".zshrc already has update aliases"
        fi
    fi
    
    # Update .bashrc if it exists
    if [[ -f "$HOME/dotfiles/shell/.bashrc" ]]; then
        if ! grep -q "update command aliases" "$HOME/dotfiles/shell/.bashrc"; then
            cat >> "$HOME/dotfiles/shell/.bashrc" << 'EOF'

# Update command aliases
if [ -f "$HOME/.update_aliases" ]; then
    source "$HOME/.update_aliases"
fi
EOF
            log "Updated .bashrc with update aliases"
        fi
    fi
}

# Create update schedule setup
setup_cron_jobs() {
    info "Setting up automatic update suggestions..."
    
    # Create weekly update reminder
    cat > "$HOME/.update_reminder" << 'EOF'
#!/bin/bash
# Weekly update reminder

echo "🔄 Weekly Update Reminder"
echo "It's time to run your weekly full update:"
echo "  update"
echo ""
echo "Or run quick update:"
echo "  update-quick"
echo ""

# Check for outdated packages
if command -v brew &> /dev/null; then
    outdated=$(brew outdated | wc -l)
    if [[ $outdated -gt 0 ]]; then
        echo "⚠️  $outdated Homebrew packages are outdated"
    fi
fi

if command -v npm &> /dev/null; then
    outdated=$(npm outdated -g --depth=0 2>/dev/null | wc -l)
    if [[ $outdated -gt 0 ]]; then
        echo "⚠️  $outdated npm packages are outdated"
    fi
fi
EOF
    
    chmod +x "$HOME/.update_reminder"
    
    # Add to crontab (optional)
    if command -v crontab &> /dev/null; then
        if ! crontab -l 2>/dev/null | grep -q "update_reminder"; then
            echo "0 10 * * 1 $HOME/.update_reminder" | crontab -
            log "Weekly update reminder scheduled for Mondays at 10 AM"
        else
            log "Update reminder already in crontab"
        fi
    fi
    
    log "Update reminder created"
}

# Create update manager script
create_manager() {
    info "Creating update manager..."
    
    cat > "$BIN_DIR/update-manager" << 'EOF'
#!/bin/bash
# Update Manager - GUI for update commands

show_help() {
    cat << 'HELP'
🔄 Update Manager - Choose your update type:

1) Quick Update     - Fast daily updates (package managers only)
2) Full Update      - Complete system and dev tools update
3) Cleanup Only     - Clean caches and remove old files
4) Check Status     - Show current versions and outdated packages
5) Help             - Show this help

Usage:
  update-manager          # Interactive mode
  update-manager quick    # Run quick update
  update-manager full     # Run full update
  update-manager clean    # Run cleanup
  update-manager status   # Check status

Examples:
  update                # Alias for full update
  update-quick          # Alias for quick update
  update --cleanup      # Run cleanup only
HELP
}

check_status() {
    echo "📊 Current Status"
    echo "================"
    
    # OS info
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "🖥️  macOS $(sw_vers -productVersion)"
        if command -v brew &> /dev/null; then
            outdated=$(brew outdated | wc -l)
            echo "📦 Homebrew: $outdated outdated packages"
        fi
    else
        echo "🖥️  Linux $(lsb_release -d 2>/dev/null | cut -f2 || echo 'Unknown')"
        if command -v apt &> /dev/null; then
            echo "📦 APT packages: Check with 'apt list --upgradable'"
        fi
    fi
    
    # Development tools
    if command -v node &> /dev/null; then
        echo "💻 Node.js: $(node --version)"
        if command -v npm &> /dev/null; then
            outdated=$(npm outdated -g --depth=0 2>/dev/null | wc -l)
            echo "📦 npm global: $outdated outdated packages"
        fi
    fi
    
    if command -v python3 &> /dev/null; then
        echo "💻 Python: $(python3 --version)"
    fi
    
    if command -v rustc &> /dev/null; then
        echo "💻 Rust: $(rustc --version | cut -d' ' -f2)"
    fi
    
    if command -v go &> /dev/null; then
        echo "💻 Go: $(go version | cut -d' ' -f3)"
    fi
    
    # Dotfiles
    if [[ -d "$HOME/dotfiles" ]]; then
        cd "$HOME/dotfiles"
        if git status --porcelain | grep -q .; then
            echo "📝 Dotfiles: Local changes detected"
        else
            echo "📝 Dotfiles: Up to date"
        fi
    fi
    
    echo ""
    echo "💡 Run 'update-quick' for fast updates or 'update' for full updates"
}

# Interactive mode
if [[ $# -eq 0 ]]; then
    echo "🔄 Update Manager"
    echo "================"
    echo "1) Quick Update"
    echo "2) Full Update"  
    echo "3) Cleanup Only"
    echo "4) Check Status"
    echo "5) Help"
    echo ""
    read -p "Choose an option [1-5]: " choice
    
    case $choice in
        1) exec ~/.local/bin/update-quick ;;
        2) exec ~/.local/bin/update ;;
        3) exec ~/.local/bin/update --cleanup ;;
        4) check_status ;;
        5) show_help ;;
        *) echo "Invalid option. Run with --help for usage." ;;
    esac
else
    case $1 in
        quick) exec ~/.local/bin/update-quick ;;
        full) exec ~/.local/bin/update ;;
        clean) exec ~/.local/bin/update --cleanup ;;
        status) check_status ;;
        help|--help|-h) show_help ;;
        *) echo "Unknown option: $1" && show_help ;;
    esac
fi
EOF
    
    chmod +x "$BIN_DIR/update-manager"
    log "Update manager created"
}

# Main installer
main() {
    echo "🚀 Installing Update Commands"
    echo "============================"
    
    # Check if dotfiles exist
    if [[ ! -d "$DOTFILES_DIR" ]]; then
        echo "❌ Dotfiles directory not found: $DOTFILES_DIR"
        exit 1
    fi
    
    # Check if scripts exist
    if [[ ! -f "$UPDATE_SCRIPT" ]]; then
        echo "❌ Update script not found: $UPDATE_SCRIPT"
        exit 1
    fi
    
    create_update_command
    create_quick_update_command
    create_alias_file
    update_shell_configs
    setup_cron_jobs
    create_manager
    
    echo ""
    log "✨ Update commands installed successfully!"
    echo ""
    echo "📋 Available Commands:"
    echo "  update         - Full update of all tools"
    echo "  update-quick   - Fast daily updates"
    echo "  update-manager - Interactive update manager"
    echo "  update --cleanup - Clean caches and old files"
    echo ""
    echo "🎭 Aliases:"
    echo "  upd           - Quick update"
    echo "  upf           - Full update"
    echo "  upc           - Cleanup"
    echo ""
    echo "💡 Examples:"
    echo "  update              # Full update"
    echo "  update-quick        # Quick daily update"
    echo "  update --cleanup    # Cleanup only"
    echo "  update-manager      # Interactive mode"
    echo ""
    warn "💡 Restart your terminal or run 'source ~/.zshrc' to enable commands"
}

main "$@"
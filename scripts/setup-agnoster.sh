#!/bin/bash

# Agnoster Theme Setup Script
# Installs and configures Agnoster theme with all dependencies

set -e

THEME_DIR="$HOME/.oh-my-zsh/themes"
CUSTOM_THEME_DIR="$HOME/.oh-my-zsh/custom/themes"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Check dependencies
check_dependencies() {
    print_info "Checking dependencies..."
    
    if ! command -v zsh &> /dev/null; then
        echo -e "${YELLOW}❌ Zsh is not installed. Please install it first.${NC}"
        exit 1
    fi
    
    if [[ ! -d "$HOME/.oh-my-zsh" ]]; then
        print_warning "Oh My Zsh not found. Installing..."
        sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
        print_status "Oh My Zsh installed"
    fi
    
    print_status "Dependencies checked"
}

# Install required fonts for Agnoster
install_fonts() {
    print_info "Installing fonts for Agnoster theme..."
    
    FONT_DIR="$HOME/Library/Fonts"
    mkdir -p "$FONT_DIR"
    
    # Download Powerline fonts
    if command -v brew &> /dev/null; then
        brew tap homebrew/cask-fonts
        brew install font-meslo-lg-nerd-font
        print_status "Meslo LG Nerd Font installed via Homebrew"
    else
        # Download manually
        print_info "Downloading Meslo LG fonts..."
        
        local fonts=(
            "Meslo%20LG%20M%20Regular%20Nerd%20Font%20Complete%20Mono.ttf"
            "Meslo%20LG%20M%20Bold%20Nerd%20Font%20Complete%20Mono.ttf"
            "Meslo%20LG%20M%20Italic%20Nerd%20Font%20Complete%20Mono.ttf"
        )
        
        cd /tmp
        for font in "${fonts[@]}"; do
            curl -fLo "${font//%20/ }" "https://github.com/ryanoasis/nerd-fonts/releases/latest/download/$font"
        done
        
        mv *.ttf "$FONT_DIR/"
        print_status "Powerline fonts installed manually"
    fi
    
    # Update font cache
    if command -v fc-cache &> /dev/null; then
        fc-cache -fv
    fi
}

# Copy theme files
copy_theme() {
    print_info "Installing Agnoster theme..."
    
    # Create custom themes directory if it doesn't exist
    mkdir -p "$CUSTOM_THEME_DIR"
    
    # Copy custom Agnoster theme
    if [[ -f "$HOME/dotfiles/shell/agnoster.zsh-theme" ]]; then
        cp "$HOME/dotfiles/shell/agnoster.zsh-theme" "$CUSTOM_THEME_DIR/"
        print_status "Custom Agnoster theme copied"
    else
        print_warning "Custom theme not found in dotfiles"
    fi
}

# Configure terminal for Agnoster
configure_terminal() {
    print_info "Configuring terminal for Agnoster theme..."
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS Terminal.app configuration
        print_info "Setting up macOS Terminal..."
        
        # Create a custom theme for Agnoster
        osascript <<EOF 2>/dev/null || true
tell application "Terminal"
    set newSettings to current settings of default settings
    set name of newSettings to "Agnoster"
    set background color of newSettings to {0, 0, 0, 1}
    set normal text color of newSettings to {1, 1, 1, 1}
    set bold text color of newSettings to {1, 1, 1, 1}
    set cursor color of newSettings to {0.5, 0.5, 0.5, 1}
end tell
EOF
    fi
    
    if [[ -d "/Applications/iTerm.app" ]]; then
        print_info "Setting up iTerm2..."
        
        # Create iTerm2 profile for Agnoster
        local iterm_profiles="$HOME/Library/Application Support/iTerm2/DynamicProfiles"
        mkdir -p "$iterm_profiles"
        
        cat > "$iterm_profiles/Agnoster.json" <<'EOF'
{
  "Profiles": [
    {
      "Name": "Agnoster",
      "Guid": "agnoster-profile",
      "Background Color": {"Red Component": 0, "Green Component": 0, "Blue Component": 0, "Alpha Component": 1},
      "Foreground Color": {"Red Component": 1, "Green Component": 1, "Blue Component": 1, "Alpha Component": 1},
      "Cursor Color": {"Red Component": 0.5, "Green Component": 0.5, "Blue Component": 0.5, "Alpha Component": 1},
      "Bold Color": {"Red Component": 1, "Green Component": 1, "Blue Component": 1, "Alpha Component": 1},
      "Ansi 0 Color": {"Red Component": 0, "Green Component": 0, "Blue Component": 0, "Alpha Component": 1},
      "Ansi 1 Color": {"Red Component": 0.8, "Green Component": 0.2, "Blue Component": 0.2, "Alpha Component": 1},
      "Ansi 2 Color": {"Red Component": 0.2, "Green Component": 0.8, "Blue Component": 0.2, "Alpha Component": 1},
      "Ansi 3 Color": {"Red Component": 0.8, "Green Component": 0.8, "Blue Component": 0.2, "Alpha Component": 1},
      "Ansi 4 Color": {"Red Component": 0.2, "Green Component": 0.2, "Blue Component": 0.8, "Alpha Component": 1},
      "Ansi 5 Color": {"Red Component": 0.8, "Green Component": 0.2, "Blue Component": 0.8, "Alpha Component": 1},
      "Ansi 6 Color": {"Red Component": 0.2, "Green Component": 0.8, "Blue Component": 0.8, "Alpha Component": 1},
      "Ansi 7 Color": {"Red Component": 0.9, "Green Component": 0.9, "Blue Component": 0.9, "Alpha Component": 1},
      "Ansi 8 Color": {"Red Component": 0.3, "Green Component": 0.3, "Blue Component": 0.3, "Alpha Component": 1},
      "Ansi 9 Color": {"Red Component": 1, "Green Component": 0.4, "Blue Component": 0.4, "Alpha Component": 1},
      "Ansi 10 Color": {"Red Component": 0.4, "Green Component": 1, "Blue Component": 0.4, "Alpha Component": 1},
      "Ansi 11 Color": {"Red Component": 1, "Green Component": 1, "Blue Component": 0.4, "Alpha Component": 1},
      "Ansi 12 Color": {"Red Component": 0.4, "Green Component": 0.4, "Blue Component": 1, "Alpha Component": 1},
      "Ansi 13 Color": {"Red Component": 1, "Green Component": 0.4, "Blue Component": 1, "Alpha Component": 1},
      "Ansi 14 Color": {"Red Component": 0.4, "Green Component": 1, "Blue Component": 1, "Alpha Component": 1},
      "Ansi 15 Color": {"Red Component": 1, "Green Component": 1, "Blue Component": 1, "Alpha Component": 1},
      "Minimum Contrast": 1.0,
      "Use Bright Bold": true
    }
  ]
}
EOF
        
        print_status "iTerm2 profile created"
    fi
}

# Update .zshrc to use Agnoster
update_zshrc() {
    print_info "Updating .zshrc to use Agnoster theme..."
    
    # Backup current .zshrc
    if [[ -f "$HOME/.zshrc" ]]; then
        cp "$HOME/.zshrc" "$HOME/.zshrc.backup.$(date +%Y%m%d_%H%M%S)"
        print_status "Current .zshrc backed up"
    fi
    
    # Update theme setting
    if [[ -f "$HOME/dotfiles/shell/.zshrc" ]]; then
        sed -i '' 's/ZSH_THEME=".*"/ZSH_THEME="agnoster"/' "$HOME/dotfiles/shell/.zshrc"
        print_status "Theme updated in dotfiles .zshrc"
    elif [[ -f "$HOME/.zshrc" ]]; then
        sed -i '' 's/ZSH_THEME=".*"/ZSH_THEME="agnoster"/' "$HOME/.zshrc" || true
        print_status "Theme updated in .zshrc"
    fi
    
    # Ensure agnoster is in plugins if not using custom theme
    if [[ -f "$HOME/.zshrc" ]]; then
        if ! grep -q "agnoster" "$HOME/.zshrc"; then
            sed -i '' 's/plugins=(/plugins=(agnoster /' "$HOME/.zshrc" || true
        fi
    fi
}

# Install Powerline-compatible dependencies
install_dependencies() {
    print_info "Installing additional dependencies..."
    
    if command -v brew &> /dev/null; then
        # Install useful tools that work well with Agnoster
        if ! command -v exa &> /dev/null; then
            brew install exa
            print_status "exa installed (modern ls)"
        fi
        
        if ! command -v bat &> /dev/null; then
            brew install bat
            print_status "bat installed (modern cat)"
        fi
        
        if ! command -v fd &> /dev/null; then
            brew install fd
            print_status "fd installed (modern find)"
        fi
    fi
}

# Main installation
main() {
    echo "🎨 Installing Agnoster Theme..."
    echo ""
    
    check_dependencies
    install_fonts
    copy_theme
    configure_terminal
    update_zshrc
    install_dependencies
    
    echo ""
    print_status "✨ Agnoster theme installation complete!"
    echo ""
    print_info "📋 Next steps:"
    echo "   1. Set your terminal font to 'Meslo LG Nerd Font'"
    echo "   2. Restart your terminal"
    echo "   3. Run: source ~/.zshrc"
    echo ""
    print_info "🚀 Enjoy your beautiful new prompt!"
}

# Run main function
main "$@"
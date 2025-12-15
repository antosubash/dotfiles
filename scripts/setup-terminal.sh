#!/bin/bash

# Terminal Setup Script with Enhanced Agnoster Theme
# Essential setup for modern terminal experience

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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
        print_warning "Zsh is not installed. Installing..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            brew install zsh
        else
            sudo apt install -y zsh
        fi
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
    
    if command -v brew &> /dev/null; then
        brew install --cask font-meslo-lg-nerd-font
        print_status "Meslo LG Nerd Font installed via Homebrew"
    else
        print_warning "Please install Meslo LG Nerd Font manually"
    fi
    
    if command -v fc-cache &> /dev/null; then
        fc-cache -fv
    fi
}

# Configure zsh to use enhanced agnoster theme
configure_zsh_theme() {
    print_info "Configuring Zsh to use enhanced Agnoster theme..."
    
    if [[ -f "$HOME/.zshrc" ]]; then
        cp "$HOME/.zshrc" "$HOME/.zshrc.backup.$(date +%Y%m%d_%H%M%S)"
        print_status "Current .zshrc backed up"
    fi
    
    local custom_themes_dir="$HOME/.oh-my-zsh/custom/themes"
    mkdir -p "$custom_themes_dir"
    
    if [[ -f "$HOME/dotfiles/shell/agnoster.zsh-theme" ]]; then
        cp "$HOME/dotfiles/shell/agnoster.zsh-theme" "$custom_themes_dir/agnoster.zsh-theme"
        print_status "Enhanced Agnoster theme installed"
    fi
    
    if [[ -f "$HOME/dotfiles/shell/.zshrc" ]]; then
        sed -i '' 's/ZSH_THEME=".*"/ZSH_THEME="agnoster"/g' "$HOME/dotfiles/shell/.zshrc"
        print_status "Theme updated to 'agnoster' in dotfiles .zshrc"
    elif [[ -f "$HOME/.zshrc" ]]; then
        sed -i '' 's/ZSH_THEME=".*"/ZSH_THEME="agnoster"/g' "$HOME/.zshrc" || true
        print_status "Theme updated to 'agnoster' in .zshrc"
    fi
    
    if [[ -f "$HOME/dotfiles/shell/agnoster-config.zsh" ]]; then
        cp "$HOME/dotfiles/shell/agnoster-config.zsh" "$HOME/.oh-my-zsh/custom/agnoster-config.zsh"
        
        if [[ -f "$HOME/.zshrc" ]] && ! grep -q "agnoster-config.zsh" "$HOME/.zshrc"; then
            echo "" >> "$HOME/.zshrc"
            echo "# Enhanced Agnoster theme configuration" >> "$HOME/.zshrc"
            echo "source \$HOME/.oh-my-zsh/custom/agnoster-config.zsh" >> "$HOME/.zshrc"
        fi
        
        print_status "Enhanced Agnoster configuration copied"
    fi
}

# Install essential CLI tools
install_essential_tools() {
    print_info "Installing essential CLI tools..."
    
    if command -v brew &> /dev/null; then
        local tools=(
            "eza"
            "bat"
            "fd"
            "ripgrep"
        )
        
        for tool in "${tools[@]}"; do
            if ! command -v "$tool" &> /dev/null; then
                print_info "Installing $tool..."
                brew install "$tool" 2>/dev/null || print_warning "Failed to install $tool"
            else
                print_status "$tool already installed"
            fi
        done
    fi
}

# Main installation
main() {
    echo "🎨 Setting up Terminal with Enhanced Agnoster Theme"
    echo "=================================================="
    echo ""
    
    check_dependencies
    install_fonts
    configure_zsh_theme
    install_essential_tools
    
    echo ""
    print_status "✨ Terminal setup complete!"
    echo ""
    print_info "📋 Next steps:"
    echo "   1. Set your terminal font to 'Meslo LG Nerd Font'"
    echo "   2. Restart your terminal"
    echo "   3. Run: source ~/.zshrc"
    echo ""
    print_info "🚀 Enjoy your enhanced terminal!"
}

# Run main function
main "$@"
#!/bin/bash

# Universal Development Tools Updater
# Updates all development tools, packages, and applications

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

log_section() {
    echo -e "\n${BOLD}${CYAN}🔄 $1${NC}"
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin*)    OS="macos" ;;
        Linux*)     OS="linux" ;;
        *)          OS="unknown" ;;
    esac
}

# Check if command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# Update package managers
update_package_managers() {
    log_section "Updating Package Managers"
    
    if [[ "$OS" == "macos" ]]; then
        if command_exists brew; then
            log_info "Updating Homebrew..."
            brew update
            log_success "Homebrew updated"
            
            log_info "Upgrading Homebrew packages..."
            brew upgrade
            log_success "Homebrew packages upgraded"
            
            log_info "Cleaning up Homebrew..."
            brew cleanup --prune=7
            log_success "Homebrew cleanup completed"
        fi
        
        if command_exists mas; then
            log_info "Updating Mac App Store apps..."
            mas upgrade
            log_success "Mac App Store apps updated"
        fi
        
    elif [[ "$OS" == "linux" ]]; then
        if command_exists apt; then
            log_info "Updating APT packages..."
            sudo apt update
            sudo apt upgrade -y
            sudo apt autoremove -y
            sudo apt autoclean
            log_success "APT packages updated"
        fi
        
        if command_exists snap; then
            log_info "Updating Snap packages..."
            sudo snap refresh
            log_success "Snap packages updated"
        fi
        
        if command_exists flatpak; then
            log_info "Updating Flatpak packages..."
            flatpak update -y
            log_success "Flatpak packages updated"
        fi
    fi
}

# Update development environments
update_dev_environments() {
    log_section "Updating Development Environments"
    
    # Node.js and npm
    if command_exists npm; then
        log_info "Updating npm packages..."
        set +e
        npm_output=$(npm update -g 2>&1)
        npm_exit_code=$?
        set -e
        if [[ $npm_exit_code -eq 0 ]]; then
            log_success "npm global packages updated"
        else
            if echo "$npm_output" | grep -q "EACCES\|permission denied"; then
                log_warning "npm update requires elevated permissions. Skipping npm update."
                log_info "To update npm, run: sudo npm install -g npm@latest"
            else
                log_warning "npm update failed, continuing with other updates..."
            fi
        fi
    fi
    
    if command_exists pnpm; then
        log_info "Updating pnpm..."
        set +e
        pnpm self update 2>&1
        pnpm_exit_code=$?
        set -e
        if [[ $pnpm_exit_code -eq 0 ]]; then
            log_success "pnpm updated"
        else
            log_warning "pnpm update failed, continuing with other updates..."
        fi
    fi
    
    if command_exists yarn; then
        log_info "Updating yarn packages..."
        set +e
        yarn global upgrade 2>&1
        yarn_exit_code=$?
        set -e
        if [[ $yarn_exit_code -eq 0 ]]; then
            log_success "yarn global packages updated"
        else
            log_warning "yarn update failed, continuing with other updates..."
        fi
    fi
    
    # Python
    if command_exists pip3; then
        log_info "Updating pip3 packages..."
        pip3 list --outdated --format=freeze | grep -v '^\-e' | cut -d = -f 1 | xargs -r pip3 install -U || true
        log_success "pip3 packages updated"
    fi
    
    if command_exists uv; then
        log_info "Updating uv..."
        uv self update
        log_success "uv updated"
    fi
    
    # Rust
    if command_exists rustup; then
        log_info "Updating Rust toolchain..."
        rustup update
        log_success "Rust updated"
    fi
    
    # Go
    if command_exists go; then
        log_info "Updating Go tools..."
        # Update common Go tools
        if [[ -d "$HOME/go/bin" ]]; then
            for tool in "$HOME/go/bin"/*; do
                if [[ -f "$tool" ]]; then
                    tool_name=$(basename "$tool")
                    log_info "Updating Go tool: $tool_name"
                    go install -a "$tool_name@latest" 2>/dev/null || true
                fi
            done
            log_success "Go tools updated"
        fi
    fi
    
    # .NET
    if command_exists dotnet; then
        log_info "Updating .NET tools..."
        dotnet tool list --global | tail -n +3 | awk '{print $1}' | while read tool; do
            if [[ -n "$tool" ]]; then
                dotnet tool update --global "$tool" || true
            fi
        done
        log_success ".NET tools updated"
    fi
}

# Update container tools
update_containers() {
    log_section "Updating Container Tools"
    
    if command_exists docker; then
        log_info "Checking Docker updates..."
        if [[ "$OS" == "macos" ]]; then
            log_warning "Docker Desktop updates must be done manually from Applications"
        else
            log_info "Docker is managed by package manager"
        fi
    fi
    
    if command_exists helm; then
        log_info "Updating Helm..."
        helm repo update
        log_success "Helm repos updated"
    fi
    
    # Update Helm plugins
    if command_exists helm; then
        log_info "Updating Helm plugins..."
        helm plugin list | tail -n +2 | awk '{print $1}' | while read plugin; do
            if [[ -n "$plugin" ]]; then
                helm plugin update "$plugin" || true
            fi
        done
        log_success "Helm plugins updated"
    fi
}

# Update CLI tools
update_cli_tools() {
    log_section "Updating CLI Tools"
    
    # Oh My Zsh
    if [[ -d "$HOME/.oh-my-zsh" ]]; then
        log_info "Updating Oh My Zsh..."
        omz update
        log_success "Oh My Zsh updated"
    fi
    
    # GitHub CLI
    if command_exists gh; then
        log_info "Updating GitHub CLI extensions..."
        gh extension upgrade --all
        log_success "GitHub CLI extensions updated"
    fi
    
    # Zsh plugins
    if [[ -d "$HOME/.oh-my-zsh/custom/plugins" ]]; then
        log_info "Updating Zsh plugins..."
        for plugin in "$HOME/.oh-my-zsh/custom/plugins"/*; do
            if [[ -d "$plugin/.git" ]]; then
                plugin_name=$(basename "$plugin")
                log_info "Updating $plugin_name..."
                git -C "$plugin" pull origin main || git -C "$plugin" pull origin master || true
            fi
        done
        log_success "Zsh plugins updated"
    fi
    
    # Tmux plugins
    if [[ -d "$HOME/.tmux/plugins/tpm" ]]; then
        log_info "Updating Tmux plugins..."
        "$HOME/.tmux/plugins/tpm/bin/update_plugins" all
        log_success "Tmux plugins updated"
    fi
    
    # Vim plugins
    if [[ -d "$HOME/.vim/bundle/Vundle.vim" ]]; then
        log_info "Updating Vim plugins..."
        vim +PluginUpdate +qall
        log_success "Vim plugins updated"
    fi
}

# Update security tools
update_security_tools() {
    log_section "Updating Security Tools"
    
    if command_exists gpg; then
        log_info "Refreshing GPG keys..."
        gpg --refresh-keys
        log_success "GPG keys refreshed"
    fi
    
    if command_exists tailscale; then
        log_info "Updating Tailscale..."
        if [[ "$OS" == "macos" ]]; then
            brew upgrade tailscale
        else
            # Linux update handled by package manager
            log_info "Tailscale managed by package manager"
        fi
        log_success "Tailscale updated"
    fi
}

# Update databases
update_databases() {
    log_section "Updating Database Tools"
    
    # PostgreSQL client tools are usually updated by package manager
    if command_exists psql; then
        log_info "PostgreSQL tools managed by package manager"
    fi
    
    # Redis tools
    if command_exists redis-cli; then
        log_info "Redis tools managed by package manager"
    fi
    
    log_success "Database tools status checked"
}

# Update dotfiles
update_dotfiles() {
    log_section "Updating Dotfiles"
    
    if [[ -d "$HOME/dotfiles" ]]; then
        log_info "Updating dotfiles repository..."
        cd "$HOME/dotfiles"
        git pull origin main
        log_success "Dotfiles updated from repository"
        
        # Check if install.sh has been updated
        if git log --oneline HEAD@{1}..HEAD | grep -q "install.sh"; then
            log_warning "install.sh was updated, consider running: cd ~/dotfiles && ./install.sh"
        fi
    else
        log_warning "Dotfiles repository not found in ~/dotfiles"
    fi
}

# Clean up
cleanup() {
    log_section "Cleaning Up"
    
    if [[ "$OS" == "macos" ]]; then
        if command_exists brew; then
            log_info "Cleaning up Homebrew..."
            brew cleanup --prune=7
            log_success "Homebrew cleanup completed"
        fi
        
        # Clean up npm cache
        if command_exists npm; then
            log_info "Cleaning npm cache..."
            npm cache clean --force
            log_success "npm cache cleaned"
        fi
        
    elif [[ "$OS" == "linux" ]]; then
        # Clean package cache
        if command_exists apt; then
            log_info "Cleaning APT cache..."
            sudo apt autoremove -y
            sudo apt autoclean
            log_success "APT cache cleaned"
        fi
        
        # Clean snap cache
        if command_exists snap; then
            log_info "Cleaning old snap revisions..."
            sudo snap set system refresh.retain=2
            log_success "Snap revisions cleaned"
        fi
    fi
    
    # Clean pip cache
    if command_exists pip3; then
        log_info "Cleaning pip cache..."
        pip3 cache purge
        log_success "pip cache cleaned"
    fi
    
    # Clean docker
    if command_exists docker; then
        log_info "Cleaning Docker..."
        docker system prune -f --volumes
        log_success "Docker cleanup completed"
    fi
}

# Generate summary
generate_summary() {
    log_section "Update Summary"
    
    echo -e "${BOLD}System Information:${NC}"
    echo "  OS: $OS"
    echo "  Shell: $SHELL"
    echo "  Date: $(date)"
    
    echo -e "\n${BOLD}Key Tool Versions:${NC}"
    
    command_exists git && echo "  Git: $(git --version | cut -d' ' -f3)"
    command_exists node && echo "  Node.js: $(node --version)"
    command_exists python3 && echo "  Python: $(python3 --version)"
    command_exists rustc && echo "  Rust: $(rustc --version | cut -d' ' -f2)"
    command_exists go && echo "  Go: $(go version | cut -d' ' -f3)"
    command_exists docker && echo "  Docker: $(docker --version | cut -d' ' -f3 | cut -d',' -f1)"
    command_exists kubectl && echo "  kubectl: $(kubectl version --client --short 2>/dev/null || kubectl version --client | grep 'Client Version' | cut -d':' -f2 | tr -d ' ')"
    
    echo -e "\n${BOLD}Storage Usage:${NC}"
    echo "  Home directory: $(du -sh "$HOME" 2>/dev/null | cut -f1) used"
    
    if [[ "$OS" == "macos" ]]; then
        if command_exists brew; then
            echo "  Homebrew cache: $(du -sh "$(brew --cache)" 2>/dev/null | cut -f1)"
        fi
    fi
    
    echo -e "\n${GREEN}✨ Update completed successfully!${NC}"
}

# Show help
show_help() {
    echo -e "${BOLD}Development Tools Updater${NC}"
    echo ""
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo "  -q, --quick    Quick update (package managers only)"
    echo "  -c, --cleanup  Only run cleanup operations"
    echo "  -d, --dry-run  Show what would be updated (no changes)"
    echo ""
    echo "Examples:"
    echo "  $0              # Full update"
    echo "  $0 --quick      # Quick update of package managers"
    echo "  $0 --cleanup    # Clean up caches and old files"
}

# Main function
main() {
    local quick_mode=false
    local cleanup_only=false
    local dry_run=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                show_help
                exit 0
                ;;
            -q|--quick)
                quick_mode=true
                shift
                ;;
            -c|--cleanup)
                cleanup_only=true
                shift
                ;;
            -d|--dry-run)
                dry_run=true
                shift
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    echo -e "${BOLD}${CYAN}🚀 Development Tools Updater${NC}"
    echo "Updating all development tools and packages..."
    
    detect_os
    
    if [[ "$dry_run" == true ]]; then
        log_warning "Dry run mode - no changes will be made"
        log_info "Would update on $OS system"
        exit 0
    fi
    
    if [[ "$cleanup_only" == true ]]; then
        cleanup
        generate_summary
        exit 0
    fi
    
    # Update sequence
    update_dotfiles
    update_package_managers
    
    if [[ "$quick_mode" == false ]]; then
        update_dev_environments
        update_containers
        update_cli_tools
        update_security_tools
        update_databases
    fi
    
    cleanup
    generate_summary
    
    echo -e "\n${GREEN}🎉 All updates completed!${NC}"
    echo -e "${YELLOW}💡 Tip: Restart your terminal to ensure all changes take effect${NC}"
}

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
else
    log_warning "Script should be executed directly, not sourced"
fi
#!/bin/bash

# Universal Development Tools Updater
# Updates all development tools, packages, and applications

set -e

# Resolved up front so steps never depend on the current directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Steps that failed; reported in the summary and turned into the exit code.
FAILED_STEPS=()

# run_step NAME FUNC: run a top-level step and record it if it fails.
#
# The `||` below makes bash ignore `set -e` inside FUNC, so every step checks
# the commands that matter itself (`|| status=1` / `|| return 1`) instead of
# relying on errexit. A failing step must not stop the steps after it.
run_step() {
    local name="$1"
    shift
    "$@" || FAILED_STEPS+=("$name")
}

# Update package managers
update_package_managers() {
    local status=0
    log_section "Updating Package Managers"

    if [[ "$OS" == "macos" ]]; then
        if command_exists brew; then
            log_info "Updating Homebrew..."
            if brew update && brew upgrade; then
                log_success "Homebrew packages upgraded"
            else
                log_error "Homebrew update failed"
                status=1
            fi

            log_info "Cleaning up Homebrew..."
            brew cleanup --prune=7 || log_warning "Homebrew cleanup failed"
        fi

        if command_exists mas; then
            log_info "Updating Mac App Store apps..."
            if mas upgrade; then
                log_success "Mac App Store apps updated"
            else
                log_error "Mac App Store update failed"
                status=1
            fi
        fi

    elif [[ "$OS" == "linux" ]]; then
        if command_exists apt; then
            log_info "Updating APT packages..."
            if sudo apt update && sudo apt full-upgrade -y && sudo apt autoremove -y && sudo apt autoclean; then
                log_success "APT packages updated"
                "$SCRIPT_DIR/nvidia-kernel-guard.sh" --fix || status=1
            else
                log_error "APT update failed"
                status=1
            fi
        fi

        if command_exists snap; then
            log_info "Updating Snap packages..."
            if sudo snap refresh; then
                log_success "Snap packages updated"
            else
                log_error "Snap refresh failed"
                status=1
            fi
        fi

        if command_exists flatpak; then
            log_info "Updating Flatpak packages..."
            if flatpak update -y; then
                log_success "Flatpak packages updated"
            else
                log_error "Flatpak update failed"
                status=1
            fi
        fi
    fi

    return "$status"
}

# Update CLI tools
update_cli_tools() {
    local status=0
    log_section "Updating CLI Tools"

    # Oh My Zsh
    if [[ -d "$HOME/.oh-my-zsh/.git" ]]; then
        log_info "Updating Oh My Zsh..."
        if git -C "$HOME/.oh-my-zsh" pull origin master 2>&1 || git -C "$HOME/.oh-my-zsh" pull origin main 2>&1; then
            log_success "Oh My Zsh updated"
        else
            log_warning "Oh My Zsh could not be updated"
        fi
    fi

    # GitHub CLI
    if command_exists gh; then
        log_info "Updating GitHub CLI extensions..."
        if gh extension upgrade --all; then
            log_success "GitHub CLI extensions updated"
        else
            log_error "GitHub CLI extension upgrade failed"
            status=1
        fi
    fi

    # Zsh plugins
    if [[ -d "$HOME/.oh-my-zsh/custom/plugins" ]]; then
        log_info "Updating Zsh plugins..."
        local plugin plugin_name
        for plugin in "$HOME/.oh-my-zsh/custom/plugins"/*; do
            if [[ -d "$plugin/.git" ]]; then
                plugin_name=$(basename "$plugin")
                log_info "Updating $plugin_name..."
                git -C "$plugin" pull origin main || git -C "$plugin" pull origin master \
                    || log_warning "$plugin_name could not be updated"
            fi
        done
        log_success "Zsh plugins checked"
    fi

    # Tmux plugins
    if [[ -d "$HOME/.tmux/plugins/tpm" ]]; then
        log_info "Updating Tmux plugins..."
        if "$HOME/.tmux/plugins/tpm/bin/update_plugins" all; then
            log_success "Tmux plugins updated"
        else
            log_error "Tmux plugin update failed"
            status=1
        fi
    fi

    # Vim plugins
    if [[ -d "$HOME/.vim/bundle/Vundle.vim" ]]; then
        log_info "Updating Vim plugins..."
        if vim +PluginUpdate +qall; then
            log_success "Vim plugins updated"
        else
            log_error "Vim plugin update failed"
            status=1
        fi
    fi

    return "$status"
}

# Update security tools
update_security_tools() {
    local status=0
    log_section "Updating Security Tools"

    if command_exists gpg; then
        log_info "Refreshing GPG keys..."
        if gpg --refresh-keys; then
            log_success "GPG keys refreshed"
        else
            log_warning "GPG key refresh failed (keyserver unreachable?)"
        fi
    fi

    if command_exists tailscale; then
        if [[ "$OS" == "macos" ]]; then
            log_info "Updating Tailscale..."
            if brew upgrade tailscale; then
                log_success "Tailscale updated"
            else
                log_error "Tailscale upgrade failed"
                status=1
            fi
        else
            # Linux update handled by package manager
            log_info "Tailscale managed by package manager"
        fi
    fi

    return "$status"
}

# Update dotfiles
update_dotfiles() {
    local repo="$HOME/dotfiles" before after branch
    log_section "Updating Dotfiles"

    if [[ ! -d "$repo" ]]; then
        log_warning "Dotfiles repository not found in ~/dotfiles"
        return 0
    fi

    if [[ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]]; then
        log_warning "dotfiles has local changes; skipping git pull"
        return 0
    fi

    before="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || {
        log_warning "dotfiles is not a git repository; skipping"
        return 0
    }

    branch="$(git -C "$repo" symbolic-ref --short -q HEAD)" || branch="(detached HEAD)"
    if [[ "$branch" != "main" ]]; then
        log_warning "dotfiles is on branch $branch, not main; skipping git pull"
        return 0
    fi

    log_info "Updating dotfiles repository..."
    if git -C "$repo" pull --ff-only origin main; then
        log_success "Dotfiles updated from repository"
        after="$(git -C "$repo" rev-parse HEAD)"
        if [[ "$before" != "$after" ]] && git -C "$repo" diff --name-only "$before" "$after" | grep -qx "install.sh"; then
            log_warning "install.sh was updated, consider running: cd ~/dotfiles && ./install.sh"
        fi
    else
        log_warning "could not fast-forward dotfiles; skipping"
    fi
    return 0
}

# Re-run the pinned-tool sections of setup-ubuntu.sh so versions follow the repo
reconcile_pinned_tools() {
    local setup="$HOME/dotfiles/scripts/setup-ubuntu.sh"

    [[ "$OS" == "linux" && -f "$setup" ]] || return 0

    log_section "Reconciling Pinned Tools"
    bash "$setup" --only languages,cli,git-tools,k8s,node \
        || { log_warning "some pinned tools failed to update"; return 1; }
}

# Clean up (best effort: failures here are warnings, never a failed run)
cleanup() {
    log_section "Cleaning Up"

    if [[ "$OS" == "macos" ]]; then
        if command_exists brew; then
            log_info "Cleaning up Homebrew..."
            brew cleanup --prune=7 || log_warning "Homebrew cleanup failed"
        fi

        # Clean up npm cache
        if command_exists npm; then
            log_info "Cleaning npm cache..."
            npm cache clean --force || log_warning "npm cache clean failed"
        fi

    elif [[ "$OS" == "linux" ]]; then
        local rc
        # Clean package cache
        if command_exists apt; then
            log_info "Cleaning APT cache..."
            sudo apt autoremove -y || log_warning "apt autoremove failed"
            sudo apt autoclean || log_warning "apt autoclean failed"

            # Purge config left behind by removed packages
            rc="$(dpkg -l | awk '/^rc/{print $2}')"
            # shellcheck disable=SC2086  # word splitting wanted: one arg per package
            [ -z "$rc" ] || sudo apt-get purge -y $rc || log_warning "could not purge removed-package configs"
        fi

        # Clean snap cache
        if command_exists snap; then
            log_info "Limiting old snap revisions..."
            sudo snap set system refresh.retain=2 || log_warning "snap retain setting failed"
        fi

        # Old crash reports
        sudo find /var/crash -name '*.crash' -mtime +14 -delete 2>/dev/null || true

        # Information only
        log_info "Cache size: $(du -sh ~/.cache 2>/dev/null | cut -f1)"
        if command_exists docker; then
            docker system df || true
        fi
    fi

    # Clean pip cache
    if command_exists pip3; then
        log_info "Cleaning pip cache..."
        pip3 cache purge || true
    fi

    # Clean docker: dangling images and old build cache only; never volumes
    if command_exists docker; then
        log_info "Cleaning Docker..."
        docker image prune -f || log_warning "docker image prune failed"
        docker builder prune -f --filter until=168h || log_warning "docker builder prune failed"
        log_success "Docker cleanup completed"
    fi

    return 0
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

    if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
        echo -e "\n${RED}✗ Update completed with failures: ${FAILED_STEPS[*]}${NC}"
    else
        echo -e "\n${GREEN}✨ Update completed successfully!${NC}"
    fi
}

# Show help
show_help() {
    echo -e "${BOLD}Development Tools Updater${NC}"
    echo ""
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo "  -q, --quick    Quick update (dotfiles and package managers; skips cleanup)"
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
        log_info "Would update on $OS system:"
        echo "  - dotfiles (git pull --ff-only)"
        echo "  - package managers"
        if [[ "$quick_mode" == false ]]; then
            [[ "$OS" == "linux" ]] && echo "  - pinned tools (setup-ubuntu.sh --only ...)"
            echo "  - CLI tools"
            echo "  - security tools"
            echo "  - cleanup"
        fi
        if [[ "$OS" == "linux" ]] && command_exists apt; then
            log_info "Upgradable APT packages:"
            apt list --upgradable 2>/dev/null || true
        fi
        exit 0
    fi

    if [[ "$cleanup_only" == true ]]; then
        run_step cleanup cleanup
        generate_summary
        [[ ${#FAILED_STEPS[@]} -eq 0 ]] || exit 1
        exit 0
    fi

    # Update sequence
    run_step dotfiles update_dotfiles
    run_step packages update_package_managers

    if [[ "$quick_mode" == false ]]; then
        run_step pinned-tools reconcile_pinned_tools
        run_step cli-tools update_cli_tools
        run_step security-tools update_security_tools
        run_step cleanup cleanup
    fi

    generate_summary

    if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
        exit 1
    fi

    echo -e "\n${GREEN}🎉 All updates completed!${NC}"
    echo -e "${YELLOW}💡 Tip: Restart your terminal to ensure all changes take effect${NC}"
}

# Run when executed; UPDATE_ALL_SOURCE_ONLY=1 sources the functions for tests
if [[ -n "${UPDATE_ALL_SOURCE_ONLY:-}" ]]; then
    :
elif [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
else
    log_warning "Script should be executed directly, not sourced"
fi

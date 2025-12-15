#!/usr/bin/env zsh
# Zsh configuration - Optimized for development

# Performance: Set options first for faster loading
setopt AUTO_CD              # cd by typing directory name
setopt CORRECT              # Auto correct mistakes
setopt HIST_VERIFY          # Show command before running history substitution
setopt INTERACTIVE_COMMENTS # Allow comments in interactive commands
setopt INC_APPEND_HISTORY   # Immediately append to history file
setopt HIST_IGNORE_ALL_DUPS # Remove older duplicate entries from history
setopt HIST_REDUCE_BLANKS   # Remove superfluous blanks from history file
setopt HIST_SAVE_NO_DUPS    # Don't save duplicate entries
setopt SHARE_HISTORY        # Share history between all sessions
setopt COMPLETE_IN_WORD     # Complete from both sides of cursor
setopt ALWAYS_TO_END        # Move cursor to end if word had one match
setopt PATH_DIRS            # Perform path search even on command names with slashes
setopt AUTO_MENU            # Show completion menu on successive tab press
setopt AUTO_LIST            # Automatically list choices on ambiguous completion
setopt AUTO_PARAM_SLASH     # If completed parameter is a directory, add trailing slash

# History configuration
HISTFILE=$HOME/.zsh_history
HISTSIZE=1000000
SAVEHIST=1000000

# Oh My Zsh configuration
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="agnoster"
plugins=(
    git
    zsh-autosuggestions
    zsh-syntax-highlighting
    docker
    docker-compose
    kubectl
    npm
    node
    python
    pip
    vscode
)

# Oh My Zsh optimizations
DISABLE_UPDATE_PROMPT=true    # Don't ask for updates
COMPLETION_WAITING_DOTS=true   # Show dots while waiting for completion
DISABLE_UNTRACKED_FILES=true   # Faster git status for large repos

# Load Oh My Zsh
source $ZSH/oh-my-zsh.sh

# Environment variables
export EDITOR='vim'
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export TERM=xterm-256color

# Development paths
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export GOPATH="$HOME/go"
export PATH="$GOPATH/bin:$PATH"

# Node.js (NVM)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# pnpm
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

# Python
export PYTHONPATH="$HOME/.local/lib/python3.*/site-packages"
export PIP_CACHE_DIR="$HOME/.cache/pip"

# .NET
export DOTNET_ROOT=$HOME/.dotnet
export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools

# Go
export GO111MODULE=on
export GOPROXY=https://proxy.golang.org,direct

# Java (if installed)
export JAVA_HOME=$(/usr/libexec/java_home 2>/dev/null || echo "")

# Rust (if installed)
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

# Custom aliases - Navigation & Files
alias ll="ls -lah"
alias la="ls -lAh"
alias l="ls -l"
alias lt="ls -lath"  # Sort by modification time, newest first
alias lg="ls -l | grep"
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."
alias -- -="cd -"
alias md="mkdir -p"
alias rd="rmdir"
alias cp="cp -iv"
alias mv="mv -iv"
alias rm="rm -iv"
alias grep="grep --color=auto"
alias egrep="egrep --color=auto"
alias fgrep="fgrep --color=auto"

# Development aliases - Git (enhanced)
alias gs="git status"
alias ga="git add"
alias gaa="git add --all"
alias gc="git commit -v"
alias gcm="git commit -m"
alias gca="git commit -a -m"
alias gp="git push"
alias gpl="git pull"
alias gl="git log --oneline --decorate --graph"
alias gd="git diff"
alias gds="git diff --staged"
alias gco="git checkout"
alias gb="git branch"
alias gba="git branch -a"
alias gbl="git blame -b -w"
alias gss="git status -s"
alias gw="git switch"
alias gwt="git worktree"
alias gst="git stash"
alias gsp="git stash pop"
alias gsl="git stash list"
alias gcl="git clone"

# Development aliases - Docker
alias d="docker"
alias dc="docker-compose"
alias dps="docker ps"
alias dpa="docker ps -a"
alias di="docker images"
alias db="docker build"
alias dr="docker run"
alias drm="docker rm"
alias drmi="docker rmi"
alias dstop="docker stop"
alias dup="docker-compose up -d"
alias ddown="docker-compose down"

# Development aliases - Node.js
alias ns="npm start"
alias nr="npm run"
alias ni="npm install"
alias nid="npm install -D"
alias nls="npm ls"
alias nup="npm update"
alias nout="npm outdated"
alias nb="npm run build"
alias nd="npm run dev"
alias nt="npm run test"

# Development aliases - pnpm
alias ps="pnpm start"
alias pr="pnpm run"
alias pi="pnpm install"
alias pd="pnpm dev"
alias pb="pnpm build"
alias pt="pnpm test"

# Development aliases - Python
alias py="python3"
alias pip="pip3"
alias venv="python3 -m venv"
alias act="source venv/bin/activate"
alias pytest="python -m pytest"

# Development aliases - Kubernetes
alias k="kubectl"
alias kg="kubectl get"
alias kd="kubectl describe"
alias ka="kubectl apply"
alias kex="kubectl exec -it"
alias klo="kubectl logs"
alias kc="kubectl config"
alias kctx="kubectl config use-context"
alias kns="kubectl config set-context --current"

# Utility aliases
alias ports="netstat -tuln"  # Show listening ports
alias myip="curl ifconfig.me" # Get public IP
alias localip="ipconfig getifaddr en0"  # macOS local IP
alias grep="grep --color=auto"
alias his="history | grep"
alias du="du -h | sort -hr | head -20"  # Find largest files/directories
alias openports="lsof -i | grep LISTEN"

# System aliases (cross-platform)
if command -v "systemctl" &> /dev/null; then
    # Linux
    alias sys="systemctl"
    alias sysu="systemctl --user"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    alias reload="source ~/.zshrc"
    alias hidden="ls -la | grep '^\.'"
fi

# Tmux aliases
alias ta="tmux attach"
alias tl="tmux ls"
alias tn="tmux new -s"
alias tk="tmux kill-session"

# Enhanced ls with colors if available
if command -v "exa" &> /dev/null; then
    alias ls="exa --icons"
    alias ll="exa --icons -lah"
    alias lt="exa --icons --tree --level=2"
fi

# Enhanced cat if available
if command -v "bat" &> /dev/null; then
    alias cat="bat"
fi

# Enhanced find if available
if command -v "fd" &> /dev/null; then
    alias find="fd"
fi

# Enhanced top if available
if command -v "htop" &> /dev/null; then
    alias top="htop"
fi

# Functions

# Create and enter directory
mkcd() {
    mkdir -p "$1" && cd "$1"
}

# Extract archives - works with many formats
extract() {
    if [ -f "$1" ]; then
        case $1 in
            *.tar.bz2)   tar xjf "$1"     ;;
            *.tar.gz)    tar xzf "$1"     ;;
            *.bz2)       bunzip2 "$1"     ;;
            *.rar)       unrar x "$1"     ;;
            *.gz)        gunzip "$1"      ;;
            *.tar)       tar xf "$1"      ;;
            *.tbz2)      tar xjf "$1"     ;;
            *.tgz)       tar xzf "$1"     ;;
            *.zip)       unzip "$1"       ;;
            *.Z)         uncompress "$1"  ;;
            *.7z)        7z x "$1"        ;;
            *)           echo "'$1' cannot be extracted via extract()" ;;
        esac
    else
        echo "'$1' is not a valid file"
    fi
}

# Quick server - serves current directory on port 8000
server() {
    python3 -m http.server "${1:-8000}"
}

# Git quick commit with message
quickcommit() {
    git add .
    git commit -m "$1"
    git push
}

# Docker cleanup
docker-clean() {
    docker system prune -af
    docker volume prune -f
    docker network prune -f
}

# Kubernetes context switcher
kswitch() {
    if [ -z "$1" ]; then
        kubectl config get-contexts
    else
        kubectl config use-context "$1"
    fi
}

# Quick backup of a file
backup() {
    cp "$1" "$1.bak.$(date +%Y%m%d_%H%M%S)"
}

# Find and replace in files recursively
replace() {
    if [ $# -ne 3 ]; then
        echo "Usage: replace <search> <replace> <directory>"
        return 1
    fi
    find "$3" -type f -exec sed -i '' "s/$1/$2/g" {} +
}

# Go to project directory
goproject() {
    cd ~/go/src/github.com/"$1"
}

# Show path components, one per line
path() {
    echo $PATH | tr ':' '\n' | nl
}

# Memory usage on macOS
memusage() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        top -l 1 -s 0 | grep PhysMem
    fi
}

# Port check
checkport() {
    lsof -i ":$1"
}

# Network connection test
connection-test() {
    ping -c 4 8.8.8.8
    curl -I https://www.google.com
}

# Auto-completion enhancements
zstyle ':completion:*' menu select
zstyle ':completion:*' group-name ''
zstyle ':completion:*' completer _expand _complete _correct _approximate
zstyle ':completion:*' matcher-list '' 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=* l:|=*'
zstyle ':completion:*' special-dirs true
zstyle ':completion:*' list-colors ''

# Case insensitive completion
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}' 'm:{a-zA-Z}={A-Za-z}'

# Fuzzy completion with fzf if available
if command -v "fzf" &> /dev/null; then
    # Use fzf for history search (Ctrl+R)
    export FZF_DEFAULT_COMMAND='rg --files --no-ignore --hidden --follow --glob "!.git/*"'
    export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
    export FZF_ALT_C_COMMAND='cd $(find * -type d | fzf) && cd -'
    
    # Integrate with zsh
    [ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
fi

# Load local overrides if they exist
if [ -f "$HOME/.zshrc.local" ]; then
    source "$HOME/.zshrc.local"
fi

# Load local environment
if [ -f "$HOME/.local/bin/env" ]; then
    source "$HOME/.local/bin/env"
fi

# Welcome message
if command -v "neofetch" &> /dev/null; then
    neofetch
elif command -v "fortune" &> /dev/null && command -v "cowsay" &> /dev/null; then
    fortune | cowsay
fi

echo "Zsh loaded successfully! $(date)"
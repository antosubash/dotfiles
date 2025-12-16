#!/usr/bin/env zsh
# Aliases configuration

# Constants should already be loaded, but ensure DOTFILES_DIR is set
if [[ -z "$DOTFILES_DIR" ]]; then
    export DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
fi

# Ensure constants are loaded so path-based aliases work
if [ -f "$DOTFILES_DIR/shell/constants.zsh" ]; then
    source "$DOTFILES_DIR/shell/constants.zsh"
fi

# Navigation & Files
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

# Directory aliases (common)
alias home="cd $HOME"
alias downloads="cd $HOME/Downloads"
alias documents="cd $HOME/Documents"

# Load local aliases if they exist (machine-specific directories)
if [ -f "$DOTFILES_DIR/shell/aliases.local.zsh" ]; then
    source "$DOTFILES_DIR/shell/aliases.local.zsh"
fi

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
if [[ "$OSTYPE" == "darwin"* ]]; then
    alias localip="ipconfig getifaddr en0"  # macOS local IP
fi
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

# Enhanced ls with colors if available (using eza, not exa)
if command -v "$TOOL_EXA" &> /dev/null; then
    alias ls="$TOOL_EXA --icons"
    alias ll="$TOOL_EXA --icons -lah"
    alias lt="$TOOL_EXA --icons --tree --level=2"
fi

# Enhanced cat if available
if command -v "$TOOL_BAT" &> /dev/null; then
    alias cat="$TOOL_BAT"
fi

# Enhanced find if available
if command -v "$TOOL_FD" &> /dev/null; then
    alias find="$TOOL_FD"
fi

# Enhanced top if available
if command -v "$TOOL_HTOP" &> /dev/null; then
    alias top="$TOOL_HTOP"
fi

# Update command aliases (prefer installed binaries, fallback to repo scripts)
if [ -f "$UPDATE_ALIASES_FILE" ]; then
    source "$UPDATE_ALIASES_FILE"
fi

UPDATE_BIN="$LOCAL_BIN_DIR/update"
UPDATE_QUICK_BIN="$LOCAL_BIN_DIR/update-quick"
UPDATE_MANAGER_BIN="$LOCAL_BIN_DIR/update-manager"
UPDATE_SCRIPT="$DOTFILES_DIR/scripts/update-all.sh"
UPDATE_QUICK_SCRIPT="$DOTFILES_DIR/scripts/update-quick.sh"

if [[ -x "$UPDATE_BIN" ]]; then
    alias update="$UPDATE_BIN"
elif [[ -x "$UPDATE_SCRIPT" ]]; then
    alias update="$UPDATE_SCRIPT"
fi

if [[ -x "$UPDATE_QUICK_BIN" ]]; then
    alias update-quick="$UPDATE_QUICK_BIN"
elif [[ -x "$UPDATE_QUICK_SCRIPT" ]]; then
    alias update-quick="$UPDATE_QUICK_SCRIPT"
fi

alias upd="update-quick"
alias upf="update"

if [[ -x "$UPDATE_MANAGER_BIN" ]]; then
    alias update-manager="$UPDATE_MANAGER_BIN"
fi


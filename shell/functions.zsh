#!/usr/bin/env zsh
# Functions configuration

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
    if [[ "$OSTYPE" == "darwin"* ]]; then
        find "$3" -type f -exec sed -i '' "s/$1/$2/g" {} +
    else
        find "$3" -type f -exec sed -i "s/$1/$2/g" {} +
    fi
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


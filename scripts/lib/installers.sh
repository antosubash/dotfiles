#!/usr/bin/env bash
# Install steps shared by setup-ubuntu.sh and setup-server.sh. Source after
# setup-common.sh; it runs nothing on its own. Nothing here edits shell rc
# files: the dotfiles' shell/ files and setup_path already put every install
# directory on PATH.
#
# Every function is idempotent (a second run installs nothing) and returns
# non-zero when something it tried to install failed.

# ---------- Package managers and groups ----------

_pkg_installed() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = "install ok installed" ]; }

# apt_install_missing PKG...: installs only the packages that aren't installed.
apt_install_missing() {
    local pkg missing=()
    for pkg in "$@"; do
        _pkg_installed "$pkg" || missing+=("$pkg")
    done
    if [ ${#missing[@]} -eq 0 ]; then
        echo "Already installed: $*"
        return 0
    fi
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

# snap_install_missing SNAP...: installs only the snaps that aren't installed.
snap_install_missing() {
    local s status=0
    for s in "$@"; do
        if snap list "$s" > /dev/null 2>&1; then
            echo "$s (snap) is already installed."
        else
            sudo snap install "$s" || status=1
        fi
    done
    return "$status"
}

# ensure_user_in_group GROUP: adds the invoking user to GROUP if it exists.
ensure_user_in_group() {
    local group="$1" user="${SUDO_USER:-$USER}"
    getent group "$group" > /dev/null || return 0
    id -nG "$user" | tr ' ' '\n' | grep -qx "$group" && return 0
    sudo usermod -aG "$group" "$user" || return 1
    echo "Added $user to the $group group; log out and back in for it to apply."
}

_os_codename() { (. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}"); }
_os_family() { (. /etc/os-release && if [ "$ID" = debian ]; then echo debian; else echo ubuntu; fi); }

# ---------- Vendor apt repositories ----------

install_docker() {
    local family; family="$(_os_family)"
    add_apt_source docker "https://download.docker.com/linux/$family/gpg" "$DOCKER_KEY_FINGERPRINT" \
        "https://download.docker.com/linux/$family" "$(_os_codename)" stable || return 1
    apt_install_missing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
    ensure_user_in_group docker || return 1
    if has_systemd; then sudo systemctl enable --now docker; fi
}

install_gh() {
    add_apt_source github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        "$GH_KEY_FINGERPRINT" https://cli.github.com/packages stable main || return 1
    apt_install_missing gh
}

# install_nvidia_container_toolkit: lets Docker containers use the GPU.
install_nvidia_container_toolkit() {
    has_nvidia_gpu || { echo "No NVIDIA GPU; skipping the NVIDIA container toolkit."; return 0; }
    add_apt_source nvidia-container-toolkit https://nvidia.github.io/libnvidia-container/gpgkey \
        "$NVIDIA_CONTAINER_KEY_FINGERPRINT" \
        "https://nvidia.github.io/libnvidia-container/stable/deb/$(dpkg --print-architecture)" / "" || return 1
    apt_install_missing nvidia-container-toolkit || return 1
    if ! grep -q nvidia /etc/docker/daemon.json 2>/dev/null; then
        sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
    fi
}

install_desktop_apps() {
    local status=0
    snap_install_missing brave || status=1
    # Chrome's package keeps its own google-chrome.sources up to date (rewriting
    # it on each update), so only bootstrap the repository when it isn't there.
    if [ ! -e /etc/apt/sources.list.d/google-chrome.sources ] && [ ! -e /etc/apt/sources.list.d/google-chrome.list ]; then
        add_apt_source google-chrome https://dl.google.com/linux/linux_signing_key.pub \
            "$GOOGLE_KEY_FINGERPRINT" https://dl.google.com/linux/chrome-stable/deb/ stable main || status=1
    fi
    apt_install_missing google-chrome-stable || status=1
    add_apt_source claude-desktop https://downloads.claude.ai/claude-desktop/key.asc \
        "$CLAUDE_DESKTOP_KEY_FINGERPRINT" https://downloads.claude.ai/claude-desktop/apt/stable stable main \
        && apt_install_missing claude-desktop || status=1
    return "$status"
}

# ---------- Language toolchains and per-user tools ----------

install_rust() {
    command -v rustup > /dev/null 2>&1 && { echo "rustup is already installed."; return 0; }
    local tmp status=0; tmp="$(mktemp -d)"
    # --no-modify-path: the dotfiles rc files already source ~/.cargo/env.
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/rustup.sh" https://sh.rustup.rs \
        && sh "$tmp/rustup.sh" -y --no-modify-path || status=1
    rm -rf "$tmp"; return "$status"
}

# install_dotnet CHANNEL...: installs the SDK channels (e.g. 8.0) not yet in ~/.dotnet.
install_dotnet() {
    local channel missing=() tmp status=0 dotnet="$HOME/.dotnet/dotnet"
    for channel in "$@"; do
        "$dotnet" --list-sdks 2>/dev/null | awk -v c="$channel." 'index($1, c) == 1 { f = 1 } END { exit !f }' \
            || missing+=("$channel")
    done
    [ ${#missing[@]} -gt 0 ] || { echo ".NET SDKs already installed: $*"; return 0; }
    tmp="$(mktemp -d)"
    if curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/dotnet-install.sh" https://dot.net/v1/dotnet-install.sh; then
        chmod +x "$tmp/dotnet-install.sh"
        for channel in "${missing[@]}"; do
            echo "Installing .NET $channel..."
            "$tmp/dotnet-install.sh" --channel "$channel" --install-dir "$HOME/.dotnet" || status=1
        done
    else
        status=1
    fi
    rm -rf "$tmp"; return "$status"
}

install_pnpm() {
    command -v pnpm > /dev/null 2>&1 && { echo "pnpm is already installed."; return 0; }
    local tmp status=0 rc i rc_links=()
    # The installer's `pnpm setup` rewrites the rc file of $SHELL, replacing the
    # dotfiles symlink with a regular file. The dotfiles rc files already set
    # PNPM_HOME, so put any clobbered symlinks back afterwards.
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [ -L "$rc" ]; then rc_links+=("$rc" "$(readlink "$rc")"); fi
    done
    tmp="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/pnpm-install.sh" https://get.pnpm.io/install.sh \
        && sh "$tmp/pnpm-install.sh" || status=1
    rm -rf "$tmp"
    for ((i = 0; i < ${#rc_links[@]}; i += 2)); do
        rc="${rc_links[i]}"
        [ -L "$rc" ] && continue
        if [ -e "$rc" ]; then
            mkdir -p "$HOME/.dotfiles_backup"
            mv "$rc" "$HOME/.dotfiles_backup/$(basename "$rc").pnpm-setup"
        fi
        ln -s "${rc_links[i + 1]}" "$rc"
        echo "Restored dotfiles symlink $rc (pnpm setup had replaced it)"
    done
    return "$status"
}

install_uv() {
    command -v uv > /dev/null 2>&1 && { echo "uv is already installed."; return 0; }
    local tmp status=0; tmp="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/uv.sh" https://astral.sh/uv/install.sh \
        && env UV_NO_MODIFY_PATH=1 UV_INSTALL_DIR="$HOME/.local/bin" sh "$tmp/uv.sh" || status=1
    rm -rf "$tmp"; return "$status"
}

install_pi() {
    needs_install "$HOME/.local/bin/pi" "$PI_CODING_AGENT_VERSION" || { echo "pi $PI_CODING_AGENT_VERSION is installed."; return 0; }
    # Per-user install into ~/.local (on PATH), not a root-owned global one.
    npm install -g --prefix "$HOME/.local" "@earendil-works/pi-coding-agent@$PI_CODING_AGENT_VERSION"
}

install_tpm() {
    local dir="$HOME/.tmux/plugins/tpm"
    if [ ! -d "$dir" ]; then git clone --depth=1 https://github.com/tmux-plugins/tpm "$dir" || return 1; fi
    if [ -f "$HOME/.tmux.conf" ]; then
        "$dir/bin/install_plugins" > /dev/null 2>&1 \
            || echo "Note: tpm plugin install had issues; in tmux press prefix + I to retry."
    fi
}

install_cli_extras() {
    local pkgs=(eza bat zoxide atuin)
    if _pkg_installed atuin; then
        :
    elif command -v atuin > /dev/null 2>&1; then
        # Installed outside apt, e.g. /usr/local/bin/atuin from the old server script.
        echo "atuin is already installed at $(command -v atuin)."
        pkgs=(eza bat zoxide)
    elif ! apt-cache show atuin > /dev/null 2>&1; then
        # atuin is only in the archives from Ubuntu 25.04 and Debian 13; 24.04 has no package.
        echo "WARNING: atuin isn't in this release's apt archive; skipping it." >&2
        pkgs=(eza bat zoxide)
    fi
    apt_install_missing "${pkgs[@]}" || return 1
    # Ubuntu ships bat as `batcat`; the shell config calls `bat`.
    if ! command -v bat > /dev/null 2>&1 && command -v batcat > /dev/null 2>&1; then
        mkdir -p "$HOME/.local/bin"; ln -sf "$(command -v batcat)" "$HOME/.local/bin/bat"
    fi
}

# ---------- Pinned binaries ----------
# Pinned x86_64 binaries, grouped by the setup-ubuntu.sh section that installs them.
_pinned_ok() { is_amd64 || { echo "Skipping pinned $1: the pinned builds are x86_64 only."; return 1; }; }

install_pinned_go() {
    _pinned_ok Go || return 0
    # The pinned Go lives in /usr/local/go; a distro go elsewhere on PATH doesn't count.
    needs_install /usr/local/go/bin/go "$GO_VERSION" version || return 0
    install_go
}

install_pinned_yq() {
    _pinned_ok yq || return 0
    needs_install yq "$YQ_VERSION" || return 0
    install_verified_binary "$YQ_URL" "$YQ_SHA256" /usr/local/bin/yq
}

install_pinned_git_tools() {
    _pinned_ok "lazygit and lazydocker" || return 0
    local status=0
    if needs_install lazygit "$LAZYGIT_VERSION"; then
        install_verified_binary "$LAZYGIT_URL" "$LAZYGIT_SHA256" /usr/local/bin/lazygit lazygit || status=1
    fi
    if needs_install lazydocker "$LAZYDOCKER_VERSION"; then
        install_verified_binary "$LAZYDOCKER_URL" "$LAZYDOCKER_SHA256" /usr/local/bin/lazydocker lazydocker || status=1
    fi
    return "$status"
}

install_pinned_k8s() {
    _pinned_ok "kubectl and helm" || return 0
    local status=0
    if needs_install kubectl "$KUBECTL_VERSION" version --client; then
        install_verified_binary "$KUBECTL_URL" "$KUBECTL_SHA256" /usr/local/bin/kubectl || status=1
    fi
    if needs_install helm "$HELM_VERSION" version; then
        install_verified_binary "$HELM_URL" "$HELM_SHA256" /usr/local/bin/helm linux-amd64/helm || status=1
    fi
    return "$status"
}

install_pinned_tools() {
    local status=0
    install_pinned_go || status=1
    install_pinned_yq || status=1
    install_pinned_git_tools || status=1
    install_pinned_k8s || status=1
    return "$status"
}

# install_fonts: the pinned Nerd Fonts and MesloLGS NF into ~/.local/share/fonts.
install_fonts() {
    local dir="$HOME/.local/share/fonts" tmp name url sha new=0 file pattern status=0
    mkdir -p "$dir"
    apt_install_missing unzip fontconfig || return 1
    # Older setups unpacked Nerd Fonts into a NerdFonts/ subdirectory.
    if [ -d "$dir/NerdFonts" ]; then
        find "$dir/NerdFonts" -type f \( -name '*.ttf' -o -name '*.otf' \) -exec mv -t "$dir" {} +
        rmdir "$dir/NerdFonts" 2>/dev/null || true
    fi
    for name in JETBRAINSMONO FIRACODE; do
        if [ "$name" = JETBRAINSMONO ]; then pattern='*JetBrainsMono*NerdFont*'; else pattern='*FiraCode*NerdFont*'; fi
        # No `find | grep -q`: under pipefail, grep exiting early can fail find with SIGPIPE.
        [ -n "$(find "$dir" -maxdepth 1 -type f -name "$pattern" -print -quit)" ] && continue
        url="NERDFONT_${name}_URL"; sha="NERDFONT_${name}_SHA256"
        tmp="$(mktemp -d)"
        if download_verified "${!url}" "${!sha}" "$tmp/font.zip" \
            && unzip -q -o "$tmp/font.zip" -d "$tmp/x" \
            && find "$tmp/x" -type f \( -name '*.ttf' -o -name '*.otf' \) -exec mv -t "$dir" {} +; then
            new=1
        else
            status=1
        fi
        rm -rf "$tmp"
    done
    for name in REGULAR BOLD ITALIC BOLD_ITALIC; do
        url="MESLO_${name}_URL"; sha="MESLO_${name}_SHA256"
        file="$dir/$(basename "${!url}" | sed 's/%20/ /g')"
        [ -f "$file" ] && continue
        if download_verified "${!url}" "${!sha}" "$file"; then new=1; else status=1; fi
    done
    if [ "$new" -eq 1 ]; then fc-cache -f "$dir" || status=1; fi
    return "$status"
}

# ---------- System configuration ----------

configure_ufw() {
    has_systemd || { echo "No systemd; leaving the firewall alone."; return 0; }
    apt_install_missing ufw || return 1
    sudo ufw allow OpenSSH > /dev/null
    local ufw_status
    # Captured first: `ufw status | grep -q` can fail with SIGPIPE under pipefail.
    ufw_status="$(sudo ufw status)" || ufw_status=""
    if grep -q '^Status: active' <<< "$ufw_status"; then
        echo "UFW is already active; its rules are left as they are."
        return 0
    fi
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow in on tailscale0
    sudo ufw --force enable
}

install_wireshark() {
    # Answer the "non-root capture" debconf question up front so apt never stops to ask.
    echo 'wireshark-common wireshark-common/install-setuid boolean true' | sudo debconf-set-selections
    apt_install_missing wireshark || return 1
    ensure_user_in_group wireshark
}

#!/usr/bin/env bash
# shellcheck disable=SC2034  # the pins below are read by the scripts that source this file
#
# Shared helpers for the Linux setup scripts (setup-ubuntu.sh, setup-server.sh,
# setup-gis.sh): pinned downloads checked against a hardcoded sha256, vendor apt
# repositories locked to their own signing key, and SSH hardening. Source it;
# it runs nothing on its own.
#
# To bump a pinned tool, change its *_VERSION and *_SHA256 together, taking the
# hash from the source noted above it, then check every pin downloads and matches:
#   VERIFY_DOWNLOADS=1 bash scripts/tests/test-setup-common.sh

# Go: sha256 from https://go.dev/dl/?mode=json
GO_VERSION="1.27.2"
GO_SHA256="ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5"
GO_URL="https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"

# yq: the SHA-256 column of the release's `checksums` file (its column order is
# in `checksums_hashes_order`; SHA-256 is column 19 counting the file name).
YQ_VERSION="4.54.1"
YQ_SHA256="8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f"
YQ_URL="https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64"

# lazygit and lazydocker: the release's checksums.txt
LAZYGIT_VERSION="0.66.1"
LAZYGIT_SHA256="7b3f30c2c06a42cf575280f907e58d7ea08411408b6b62bc926bc91cbc6c3f46"
LAZYGIT_URL="https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_linux_x86_64.tar.gz"

LAZYDOCKER_VERSION="0.25.2"
LAZYDOCKER_SHA256="0d9dbfc26068b218e7ed84b104748cadc6e3cf733c0afd35465306fb39b9523c"
LAZYDOCKER_URL="https://github.com/jesseduffield/lazydocker/releases/download/v${LAZYDOCKER_VERSION}/lazydocker_${LAZYDOCKER_VERSION}_Linux_x86_64.tar.gz"

# kubectl: ${KUBECTL_URL}.sha256
KUBECTL_VERSION="1.37.1"
KUBECTL_SHA256="65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8"
KUBECTL_URL="https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl"

# helm: ${HELM_URL}.sha256sum
HELM_VERSION="4.3.0"
HELM_SHA256="86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb"
HELM_URL="https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz"

# pmtiles and DuckDB publish no checksum file; these are the sha256 digests
# GitHub shows for the release assets.
PMTILES_VERSION="1.31.2"
PMTILES_SHA256="3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f"
PMTILES_URL="https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz"

DUCKDB_VERSION="1.5.6"
DUCKDB_SHA256="cce2687a38681db644c248198b99ecd86170ff47e324c5f33e50c0042f142839"
DUCKDB_URL="https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-amd64.gz"

# Ulauncher and espanso .debs: the sha256 digests GitHub shows for the release assets.
ULAUNCHER_VERSION="5.16.2"
ULAUNCHER_SHA256="e6bd4f55a71daf4d3f5bd1a0f8d11d04c80c536938dde4ba3ccc8849049fe788"
ULAUNCHER_URL="https://github.com/Ulauncher/Ulauncher/releases/download/${ULAUNCHER_VERSION}/ulauncher_${ULAUNCHER_VERSION}_all.deb"

ESPANSO_VERSION="2.4.1"
ESPANSO_SHA256="d4b3b284c6fabf6f2a73dc269189fb5a06611547529853c87b58d07aa7d295ae"
ESPANSO_URL="https://github.com/espanso/espanso/releases/download/v${ESPANSO_VERSION}/espanso-debian-wayland-amd64.deb"

# Nerd Fonts: the sha256 digests GitHub shows for the release assets.
NERDFONT_VERSION="3.5.1"
NERDFONT_JETBRAINSMONO_SHA256="fab782a66f7d3019da64f6572db9fc5d3a4bcb19f9fa13e2d8a62e3693d6396e"
NERDFONT_JETBRAINSMONO_URL="https://github.com/ryanoasis/nerd-fonts/releases/download/v${NERDFONT_VERSION}/JetBrainsMono.zip"
NERDFONT_FIRACODE_SHA256="239395baf60c89b2eaf4862b6b09db0ef95605cd3e8eef51c00345822a81a665"
NERDFONT_FIRACODE_URL="https://github.com/ryanoasis/nerd-fonts/releases/download/v${NERDFONT_VERSION}/FiraCode.zip"

# MesloLGS NF (Powerlevel10k's font), pinned to a powerlevel10k-media commit.
MESLO_COMMIT="145eb9fbc2f42ee408dacd9b22d8e6e0e553f83d"
MESLO_BASE="https://raw.githubusercontent.com/romkatv/powerlevel10k-media/${MESLO_COMMIT}"
MESLO_REGULAR_SHA256="d97946186e97f8d7c0139e8983abf40a1d2d086924f2c5dbf1c29bd8f2c6e57d"
MESLO_REGULAR_URL="${MESLO_BASE}/MesloLGS%20NF%20Regular.ttf"
MESLO_BOLD_SHA256="b6c0199cf7c7483c8343ea020658925e6de0aeb318b89908152fcb4d19226003"
MESLO_BOLD_URL="${MESLO_BASE}/MesloLGS%20NF%20Bold.ttf"
MESLO_ITALIC_SHA256="6f357bcbe2597704e157a915625928bca38364a89c22a4ac36e7a116dcd392ef"
MESLO_ITALIC_URL="${MESLO_BASE}/MesloLGS%20NF%20Italic.ttf"
MESLO_BOLD_ITALIC_SHA256="56b4131adecec052c4b324efb818dd326d586dbc316fc68f98f1cae2eb8d1220"
MESLO_BOLD_ITALIC_URL="${MESLO_BASE}/MesloLGS%20NF%20Bold%20Italic.ttf"

# Node.js LTS major from NodeSource, and exact versions of global npm tools.
NODE_MAJOR="24"
PI_CODING_AGENT_VERSION="1.1.0"
MAPSHAPER_VERSION="0.7.83"

# Primary-key fingerprints of the vendor apt repositories' signing keys.
NODESOURCE_KEY_FINGERPRINT="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
TAILSCALE_KEY_FINGERPRINT="2596A99EAAB33821893C0A79458CA832957F5868"
DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
GH_KEY_FINGERPRINT="2C6106201985B60E6C7AC87323F3D4EA75716059"
GOOGLE_KEY_FINGERPRINT="EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"
CLAUDE_DESKTOP_KEY_FINGERPRINT="31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"
NVIDIA_CONTAINER_KEY_FINGERPRINT="C95B321B61E88C1809C4F759DDCAE044F796ECB0"

SSHD_HARDENING_CONF="${SSHD_HARDENING_CONF:-/etc/ssh/sshd_config.d/10-hardening.conf}"

# download_verified URL SHA256 DEST
# Downloads URL to DEST over HTTPS only. Removes DEST and fails unless its
# sha256 matches.
download_verified() {
    local url="$1" sha256="$2" dest="$3"
    if ! curl -fsSL --proto '=https' --tlsv1.2 -o "$dest" "$url"; then
        echo "ERROR: download failed: $url" >&2
        rm -f "$dest"
        return 1
    fi
    if ! printf '%s  %s\n' "$sha256" "$dest" | sha256sum -c --status -; then
        echo "ERROR: sha256 mismatch for $url (expected $sha256); not installing it." >&2
        rm -f "$dest"
        return 1
    fi
}

# install_verified_binary URL SHA256 DEST [MEMBER]
# Installs one executable as DEST from a verified download of URL: the file
# itself, the contents of a .gz, or MEMBER of a .tar.gz. Uses sudo only when
# DEST's directory isn't writable. Works in a temporary directory it removes.
install_verified_binary() {
    local url="$1" sha256="$2" dest="$3" member="${4:-}" tmp status=0
    tmp="$(mktemp -d)"
    download_verified "$url" "$sha256" "$tmp/download" \
        && _extract_binary "$url" "$tmp" "$member" \
        && _install_executable "$tmp/bin" "$dest" \
        || status=1
    rm -rf "$tmp"
    return "$status"
}

_extract_binary() {
    local url="$1" tmp="$2" member="$3"
    case "$url" in
        *.tar.gz) tar -xzf "$tmp/download" -C "$tmp" "$member" && mv "$tmp/$member" "$tmp/bin" ;;
        *.gz)     gunzip -c "$tmp/download" > "$tmp/bin" ;;
        *)        mv "$tmp/download" "$tmp/bin" ;;
    esac
}

_install_executable() {
    local src="$1" dest="$2"
    if [ -w "$(dirname "$dest")" ]; then
        install -m 0755 "$src" "$dest"
    else
        sudo install -o root -g root -m 0755 "$src" "$dest"
    fi
}

# install_verified_deb URL SHA256: installs a .deb (and its dependencies) from
# a verified download of URL.
install_verified_deb() {
    local url="$1" sha256="$2" tmp status=0
    tmp="$(mktemp -d)"
    chmod 0755 "$tmp"  # apt's _apt user must be able to read the file
    download_verified "$url" "$sha256" "$tmp/package.deb" \
        && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$tmp/package.deb" \
        || status=1
    rm -rf "$tmp"
    return "$status"
}

# install_go: replaces /usr/local/go with the pinned, verified Go release.
install_go() {
    local tmp status=0
    tmp="$(mktemp -d)"
    download_verified "$GO_URL" "$GO_SHA256" "$tmp/go.tar.gz" \
        && sudo rm -rf /usr/local/go \
        && sudo tar -C /usr/local -xzf "$tmp/go.tar.gz" \
        || status=1
    rm -rf "$tmp"
    return "$status"
}

# add_apt_source NAME KEY_URL KEY_FINGERPRINT URI SUITE [COMPONENTS]
# Adds a vendor apt repository signed by the key with KEY_FINGERPRINT, which
# must be a primary key in the file at KEY_URL (armored or binary; vendors
# such as Google and GitHub ship several keys in one file). Only that key is
# written, as $APT_KEYRINGS_DIR/NAME.gpg, so no other key in the vendor's file
# can sign the repository. The source goes to $APT_SOURCES_DIR/NAME.sources;
# SUITE "/" with empty COMPONENTS writes a flat repository.
# When the key or source changed, or a NAME.list (from the vendor's own
# instructions or package) is present, refreshes just this source, not every
# repository, so a broken unrelated one can't fail it. Only once that refresh
# works is NAME.list removed: the two would conflict on Signed-By. If it fails,
# removes the .sources file again, which leaves any NAME.list as it was and
# lets the next run retry.
add_apt_source() {
    local name="$1" key_url="$2" fingerprint="$3" uri="$4" suite="$5" components="${6:-}"
    local keyrings="${APT_KEYRINGS_DIR:-/etc/apt/keyrings}" sources="${APT_SOURCES_DIR:-/etc/apt/sources.list.d}"
    local keyring="$keyrings/$name.gpg" tmp status=0 changed=0 listing=""
    [ -n "$fingerprint" ] || { echo "ERROR: no key fingerprint given for the $name apt source." >&2; return 1; }
    tmp="$(mktemp -d)"
    mkdir -m 0700 "$tmp/gnupg"
    # A throwaway GNUPGHOME and keyring: the vendor's keys never reach ~/.gnupg.
    local gpg=(gpg --homedir "$tmp/gnupg" --batch --no-default-keyring --keyring "$tmp/import.gpg")
    if ! curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/key" "$key_url"; then
        echo "ERROR: could not download the $name signing key from $key_url." >&2
        status=1
    else
        # Import everything, export just the pinned key (binary), then check the
        # export is exactly one primary key with that fingerprint: exporting by
        # a subkey's fingerprint would export its primary key instead.
        "${gpg[@]}" --import "$tmp/key" > /dev/null 2>&1 || true
        "${gpg[@]}" --export "$fingerprint" > "$tmp/key.gpg" 2>/dev/null || true
        listing="$("${gpg[@]}" --show-keys --with-colons "$tmp/key.gpg" 2>/dev/null)" || true
        if [ "$(awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 }' <<< "$listing")" != "$fingerprint" ]; then
            echo "ERROR: $key_url has no $name signing key with fingerprint $fingerprint." >&2
            status=1
        fi
    fi
    gpgconf --homedir "$tmp/gnupg" --kill all > /dev/null 2>&1 || true
    if [ "$status" -eq 0 ] && ! cmp -s "$tmp/key.gpg" "$keyring"; then
        sudo install -D -o root -g root -m 0644 "$tmp/key.gpg" "$keyring" || status=1
        changed=1
    fi
    if [ "$status" -eq 0 ]; then
        {
            printf 'Types: deb\nURIs: %s\nSuites: %s\n' "$uri" "$suite"
            [ -n "$components" ] && printf 'Components: %s\n' "$components"
            printf 'Architectures: %s\nSigned-By: %s\n' "$(dpkg --print-architecture)" "$keyring"
        } > "$tmp/source"
        if ! cmp -s "$tmp/source" "$sources/$name.sources"; then
            sudo install -D -m 0644 "$tmp/source" "$sources/$name.sources" || status=1
            changed=1
        fi
    fi
    rm -rf "$tmp"
    [ "$status" -eq 0 ] || return 1
    local list="$sources/$name.list"
    [ "$changed" -eq 0 ] && [ ! -e "$list" ] && return 0
    if ! sudo apt-get update -o Dir::Etc::sourcelist="$sources/$name.sources" \
            -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0; then
        sudo rm -f "$sources/$name.sources"
        if [ -e "$list" ]; then
            echo "ERROR: apt could not refresh $name from $sources/$name.sources; removed it and kept $list." >&2
        else
            echo "ERROR: apt could not refresh $name; removed $sources/$name.sources so the next run retries." >&2
        fi
        return 1
    fi
    if [ -e "$list" ] && ! sudo rm -f "$list"; then
        # Both files at once would fail every apt run on conflicting Signed-By values.
        echo "ERROR: could not remove $list; removed $sources/$name.sources so the two don't conflict." >&2
        sudo rm -f "$sources/$name.sources"
        return 1
    fi
}

# install_nodejs: Node.js $NODE_MAJOR.x from NodeSource's apt repository.
install_nodejs() {
    add_apt_source nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        "$NODESOURCE_KEY_FINGERPRINT" "https://deb.nodesource.com/node_${NODE_MAJOR}.x" nodistro main \
        || return 1
    # Prefer NodeSource's nodejs over the distribution's, as NodeSource's setup script does.
    printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' \
        | sudo tee /etc/apt/preferences.d/nodejs > /dev/null
    sudo apt install -y nodejs
}

# install_tailscale: Tailscale from its apt repository for this release.
install_tailscale() {
    local distro codename
    # Debian uses Tailscale's debian tree; Ubuntu and its derivatives the ubuntu one.
    distro="$(. /etc/os-release && if [ "$ID" = debian ]; then echo debian; else echo ubuntu; fi)"
    codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
    add_apt_source tailscale "https://pkgs.tailscale.com/stable/$distro/$codename.gpg" \
        "$TAILSCALE_KEY_FINGERPRINT" "https://pkgs.tailscale.com/stable/$distro" "$codename" main \
        || return 1
    sudo apt install -y tailscale
}

# harden_sshd: turns off password, keyboard-interactive and root logins, but
# only when the invoking user already has an authorized key, so the change
# can't lock them out. Validates with `sshd -t` and backs out if that fails.
harden_sshd() {
    local user="${SUDO_USER:-$(id -un)}" home keys content
    if [ "$(id -u "$user")" -eq 0 ]; then
        echo "WARNING: running as root with no sudo user; skipping SSH hardening so root logins keep working." >&2
        echo "         Re-run as a sudo user who has an SSH key to turn off password and root logins." >&2
        return 0
    fi
    home="$(getent passwd "$user" | cut -d: -f6)"
    keys="$home/.ssh/authorized_keys"
    if ! grep -qE '^[[:space:]]*[^#[:space:]]' "$keys" 2>/dev/null; then
        echo "WARNING: $keys has no keys; leaving SSH password login on so you aren't locked out." >&2
        echo "         Add your public key (ssh-copy-id $user@<host>) and re-run to turn it off." >&2
        return 0
    fi
    content="# Managed by dotfiles (scripts/lib/setup-common.sh): key-only SSH logins.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no"
    if [ "$(cat "$SSHD_HARDENING_CONF" 2>/dev/null)" = "$content" ]; then
        echo "SSH is already hardened ($SSHD_HARDENING_CONF)."
        return 0
    fi
    printf '%s\n' "$content" | sudo tee "$SSHD_HARDENING_CONF" > /dev/null
    # sshd -t needs its privilege separation directory, which only exists while ssh runs.
    sudo mkdir -p /run/sshd
    if ! sudo sshd -t; then
        echo "ERROR: sshd rejected $SSHD_HARDENING_CONF; removed it and left SSH unchanged." >&2
        sudo rm -f "$SSHD_HARDENING_CONF"
        return 1
    fi
    sudo systemctl try-reload-or-restart ssh
    echo "SSH hardened: key-only logins, no root login ($SSHD_HARDENING_CONF)."
}

# ---------- Environment guards ----------

# has_systemd: false in containers and WSL without systemd.
has_systemd() { [ -d "${SYSTEMD_RUN_DIR:-/run/systemd/system}" ]; }

# is_amd64: the pinned binaries above are x86_64 builds.
is_amd64() { [ "${SETUP_MACHINE:-$(uname -m)}" = x86_64 ]; }

# has_nvidia_gpu: true when a PCI display controller (class 0x03xxxx) made by
# NVIDIA (vendor 0x10de) is present. Reads sysfs, so it needs no lspci.
has_nvidia_gpu() {
    local dev
    for dev in "${SYSFS_PCI_DEVICES:-/sys/bus/pci/devices}"/*; do
        [ "$(cat "$dev/vendor" 2>/dev/null)" = 0x10de ] || continue
        case "$(cat "$dev/class" 2>/dev/null)" in 0x03*) return 0 ;; esac
    done
    return 1
}

# needs_install CMD VERSION [ARGS...]: true when CMD is missing or `CMD ARGS`
# (default --version) doesn't print VERSION, so bumping a pin reinstalls it.
needs_install() {
    local cmd="$1" version="$2" out
    shift 2
    [ $# -gt 0 ] || set -- --version
    command -v "$cmd" > /dev/null 2>&1 || return 0
    out="$("$cmd" "$@" 2>&1)" || true
    [[ "$out" != *"$version"* ]]
}

# ---------- Section runner ----------
# A setup script defines a SECTIONS array (run order) and a section_<name>
# function per entry ("-" in a name becomes "_"), then calls run_setup "$@".
# Each section runs in its own subshell under `set -euo pipefail`, so a failure
# ends that section only; the summary lists every section's outcome.

SECTION_RESULTS=()
SELECTED_SECTIONS=()

# skip_section REASON: ends the current section as skipped. It leaves a marker
# file rather than a special exit status, which a failing command could share.
skip_section() {
    echo "Skipping: $*"
    if [ -n "${SECTION_SKIP_MARKER:-}" ]; then : > "$SECTION_SKIP_MARKER"; fi
    exit 0
}

section_usage() {
    echo "Usage: $(basename "$0") [--list] [--only a,b] [--skip a,b]"
    echo "Sections: ${SECTIONS[*]}"
}

_in_csv() { [[ ",$2," == *",$1,"* ]]; }

_section_arg_error() {
    echo "ERROR: $1" >&2
    section_usage >&2
    exit 2
}

# parse_section_args ARGS...: sets SELECTED_SECTIONS from --only/--skip (comma
# separated); exits after --list or -h, and with status 2 on a bad argument.
parse_section_args() {
    local only="" skip="" name s
    while [ $# -gt 0 ]; do
        case "$1" in
            --list) printf '%s\n' "${SECTIONS[@]}"; exit 0 ;;
            --only|--skip)
                [ -n "${2:-}" ] || _section_arg_error "$1 needs a comma-separated list of sections"
                if [ "$1" = --only ]; then only="$2"; else skip="$2"; fi
                shift ;;
            --only=*|--skip=*)
                [ -n "${1#*=}" ] || _section_arg_error "${1%%=*} needs a comma-separated list of sections"
                if [[ $1 == --only=* ]]; then only="${1#*=}"; else skip="${1#*=}"; fi ;;
            -h|--help) section_usage; exit 0 ;;
            *) _section_arg_error "unknown option: $1" ;;
        esac
        shift
    done
    for name in ${only//,/ } ${skip//,/ }; do
        _in_csv "$name" "$(IFS=,; echo "${SECTIONS[*]}")" || _section_arg_error "unknown section: $name"
    done
    SELECTED_SECTIONS=()
    for s in "${SECTIONS[@]}"; do
        if [ -n "$only" ] && ! _in_csv "$s" "$only"; then continue; fi
        _in_csv "$s" "$skip" && continue
        SELECTED_SECTIONS+=("$s")
    done
}

# run_sections NAME...: runs each section, fills SECTION_RESULTS, prints the
# summary and returns 1 if any section failed. Call it as a plain command:
# bash ignores set -e in everything run from an if/while condition or an
# &&, || or ! list, subshells included, so there a failing command could not
# stop its section. In that context it refuses to run and returns 2.
run_sections() {
    local s start status failed=0 errexit=0 markers
    [[ $- == *e* ]] && errexit=1
    set +e  # a failing section must not end the caller
    ( set -e; false; true )
    if [ $? -eq 0 ]; then
        echo "ERROR: run_sections was called from an if, while, &&, || or ! context," \
            "where bash ignores set -e, so a failing command would not stop its section." >&2
        [ "$errexit" -eq 0 ] || set -e
        return 2
    fi
    markers="$(mktemp -d)"
    for s in "$@"; do
        echo ""
        echo "==> $s"
        start=$SECONDS
        ( export SECTION_SKIP_MARKER="$markers/$s"; set -euo pipefail; "section_${s//-/_}" )
        status=$?
        if [ "$status" -ne 0 ]; then
            SECTION_RESULTS+=("$s|failed ($status)|$((SECONDS - start))s"); failed=1
        elif [ -e "$markers/$s" ]; then
            SECTION_RESULTS+=("$s|skipped|$((SECONDS - start))s")
        else
            SECTION_RESULTS+=("$s|ok|$((SECONDS - start))s")
        fi
    done
    rm -rf "$markers"
    [ "$errexit" -eq 0 ] || set -e
    print_section_summary
    return "$failed"
}

print_section_summary() {
    local row name result took
    echo ""
    echo "Summary:"
    for row in "${SECTION_RESULTS[@]}"; do
        IFS='|' read -r name result took <<< "$row"
        printf '  %-14s %-12s %s\n' "$name" "$result" "$took"
    done
}

# setup_path: every tool directory the sections install into, so sections
# never need to export PATH or edit rc files.
setup_path() {
    export PNPM_HOME="$HOME/.local/share/pnpm" DOTNET_ROOT="$HOME/.dotnet"
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PNPM_HOME/bin:$PNPM_HOME:/usr/local/go/bin:$HOME/go/bin:$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
}

# start_sudo_keepalive: one password prompt up front, refreshed until exit.
start_sudo_keepalive() {
    [ "$(id -u)" -eq 0 ] && return 0
    sudo -v || { echo "ERROR: this script needs sudo." >&2; exit 1; }
    ( while kill -0 "$$" 2>/dev/null; do sudo -n true 2>/dev/null; sleep 50; done ) &
    SUDO_KEEPALIVE_PID=$!
    trap 'kill "$SUDO_KEEPALIVE_PID" 2>/dev/null' EXIT
}

# setup_log NAME: copies all output to ~/.local/state/dotfiles/NAME-<time>.log.
setup_log() {
    local dir="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles"
    local SETUP_LOG_FILE
    mkdir -p "$dir"
    SETUP_LOG_FILE="$dir/$1-$(date +%Y%m%d-%H%M%S).log"
    exec > >(tee -a "$SETUP_LOG_FILE") 2>&1
    echo "Logging to $SETUP_LOG_FILE"
}

# run_setup ARGS...: parse args, check the host, then run the chosen sections.
# Call it as a plain command (see run_sections), e.g. `run_setup "$@"`.
run_setup() {
    parse_section_args "$@"
    # As root, $HOME, ~/.local, the login shell and group changes would all be root's.
    if [ "$(id -u)" -eq 0 ]; then
        echo "Run setup as your normal user; it uses sudo itself where needed." >&2
        exit 1
    fi
    if [ ! -r /etc/os-release ] || ! grep -qE '^ID(_LIKE)?=.*(debian|ubuntu)' /etc/os-release; then
        echo "ERROR: this script targets Debian/Ubuntu hosts." >&2
        exit 1
    fi
    setup_log "$(basename "$0" .sh)"
    start_sudo_keepalive
    setup_path
    run_sections "${SELECTED_SECTIONS[@]}"
}

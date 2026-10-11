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

# Node.js LTS major from NodeSource, and exact versions of global npm tools.
NODE_MAJOR="24"
PI_CODING_AGENT_VERSION="1.1.0"
MAPSHAPER_VERSION="0.7.83"

# Primary-key fingerprints of the vendor apt repositories' signing keys.
NODESOURCE_KEY_FINGERPRINT="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
TAILSCALE_KEY_FINGERPRINT="2596A99EAAB33821893C0A79458CA832957F5868"

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

# add_apt_source NAME KEY_URL KEY_FINGERPRINT URI SUITE COMPONENTS
# Adds a vendor apt repository that only its own key can sign: the key is
# checked against KEY_FINGERPRINT and stored as /etc/apt/keyrings/NAME.gpg,
# and the source as /etc/apt/sources.list.d/NAME.sources. A NAME.list left by
# the vendor's own installer is removed so apt doesn't see two Signed-By values.
add_apt_source() {
    local name="$1" key_url="$2" fingerprint="$3" uri="$4" suite="$5" components="$6"
    local keyring="/etc/apt/keyrings/$name.gpg" tmp actual status=0
    tmp="$(mktemp -d)"
    if curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/key.asc" "$key_url"; then
        actual="$(gpg --batch --show-keys --with-colons "$tmp/key.asc" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
        if [ "$actual" != "$fingerprint" ]; then
            echo "ERROR: $name signing key fingerprint is '${actual:-unreadable}', expected $fingerprint." >&2
            status=1
        fi
    else
        echo "ERROR: could not download the $name signing key from $key_url." >&2
        status=1
    fi
    if [ "$status" -eq 0 ]; then
        gpg --batch --dearmor -o "$tmp/key.gpg" "$tmp/key.asc" \
            && sudo install -D -o root -g root -m 0644 "$tmp/key.gpg" "$keyring" \
            || status=1
    fi
    rm -rf "$tmp"
    [ "$status" -eq 0 ] || return 1

    sudo rm -f "/etc/apt/sources.list.d/$name.list"
    printf 'Types: deb\nURIs: %s\nSuites: %s\nComponents: %s\nArchitectures: %s\nSigned-By: %s\n' \
        "$uri" "$suite" "$components" "$(dpkg --print-architecture)" "$keyring" \
        | sudo tee "/etc/apt/sources.list.d/$name.sources" > /dev/null
    sudo apt update
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

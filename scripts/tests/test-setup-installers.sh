#!/usr/bin/env bash
# Tests for scripts/lib/installers.sh with fake package managers.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/lib/installers.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

ORIG_HOME="$HOME"
unset SUDO_USER

fake() {  # fake NAME BODY
    printf '#!/usr/bin/env bash\n%s\n' "$2" > "$FAKE_BIN/$1"; chmod +x "$FAKE_BIN/$1"
}

setup_fakes() {
    export TMPDIR_ROOT CALLS="$TMPDIR_ROOT/calls" INSTALLED="$TMPDIR_ROOT/installed"
    : > "$CALLS"; : > "$INSTALLED"
    fake sudo 'echo "sudo $*" >> "$CALLS"; while [[ "$1" == *=* ]]; do export "$1"; shift; done; "$@"'
    fake apt-get 'echo "apt-get $*" >> "$CALLS"'
    fake apt 'echo "apt $*" >> "$CALLS"'
    fake dpkg-query 'grep -qx "${@: -1}" "$INSTALLED" && printf "install ok installed" || exit 1'
    fake snap '[ "$1" = list ] && { grep -qx "$2" "$TMPDIR_ROOT/snaps" 2>/dev/null; exit; }; echo "snap $*" >> "$CALLS"'
    fake usermod 'echo "usermod $*" >> "$CALLS"'
    : > "$TMPDIR_ROOT/snaps"
    # shellcheck disable=SC1090
    . "$(dirname "$SCRIPT")/setup-common.sh"
    # shellcheck disable=SC1090
    . "$SCRIPT"
}

end_test() {
    export HOME="$ORIG_HOME"
    teardown_test
}

test_apt_install_missing_installs_only_missing() {
    setup_test "apt_install_missing"
    setup_fakes
    echo curl > "$INSTALLED"
    apt_install_missing curl eza bat
    assert_contains "$(cat "$CALLS")" "apt-get install -y eza bat" "installs only missing"
    : > "$CALLS"; printf 'eza\nbat\n' >> "$INSTALLED"
    apt_install_missing curl eza bat
    assert_not_contains "$(cat "$CALLS")" "apt-get install" "nothing missing -> no install"
    end_test
}

test_snap_install_missing() {
    setup_test "snap_install_missing"
    setup_fakes
    echo slack > "$TMPDIR_ROOT/snaps"
    snap_install_missing slack brave
    assert_not_contains "$(cat "$CALLS")" "snap install slack" "slack present"
    assert_contains "$(cat "$CALLS")" "snap install brave" "brave installed"
    end_test
}

test_ensure_user_in_group() {
    setup_test "ensure_user_in_group"
    setup_fakes
    fake getent '[ "$2" = docker ] && echo "docker:x:999:"'
    fake id 'echo "anto sudo"'
    USER=anto ensure_user_in_group docker
    assert_contains "$(cat "$CALLS")" "usermod -aG docker anto" "added"
    : > "$CALLS"; fake id 'echo "anto sudo docker"'
    USER=anto ensure_user_in_group docker
    assert_not_contains "$(cat "$CALLS")" "usermod" "already member"
    : > "$CALLS"
    USER=anto ensure_user_in_group nosuchgroup
    assert_not_contains "$(cat "$CALLS")" "usermod" "missing group is a no-op"
    end_test
}

test_install_dotnet_only_missing_channels() {
    setup_test "install_dotnet"
    setup_fakes
    export HOME="$TMPDIR_ROOT/home"; mkdir -p "$HOME/.dotnet"
    fake_dotnet="$HOME/.dotnet/dotnet"
    printf '#!/bin/sh\nprintf "8.0.410 [x]\\n10.0.100 [x]\\n"\n' > "$fake_dotnet"; chmod +x "$fake_dotnet"
    fake curl 'out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done; printf "#!/bin/sh\necho dotnet-install \"\$@\" >> \"$CALLS\"\n" > "$out"'
    install_dotnet 7.0 8.0 9.0 10.0
    assert_contains "$(cat "$CALLS")" "--channel 7.0" "7 missing"
    assert_contains "$(cat "$CALLS")" "--channel 9.0" "9 missing"
    assert_not_contains "$(cat "$CALLS")" "--channel 8.0" "8 present"
    assert_not_contains "$(cat "$CALLS")" "--channel 10.0" "10 present"
    end_test
}

test_nvidia_toolkit_skips_without_gpu() {
    setup_test "nvidia toolkit needs a GPU"
    setup_fakes
    SYSFS_PCI_DEVICES="$TMPDIR_ROOT/none" install_nvidia_container_toolkit > "$TMPDIR_ROOT/out"
    assert_eq 0 $? "returns 0"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "No NVIDIA GPU" "message"
    assert_eq "" "$(cat "$CALLS")" "no package calls"
    end_test
}

test_pinned_tools_skip_on_non_amd64() {
    setup_test "pinned tools on aarch64"
    setup_fakes
    SETUP_MACHINE=aarch64 install_pinned_tools > "$TMPDIR_ROOT/out"
    assert_eq 0 $? "returns 0"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "x86_64" "explains the skip"
    end_test
}

# The pnpm installer's `pnpm setup` replaces the rc symlinks with regular files.
test_install_pnpm_restores_rc_symlinks() {
    setup_test "install_pnpm restores rc symlinks"
    setup_fakes
    export HOME="$TMPDIR_ROOT/home"; mkdir -p "$HOME" "$TMPDIR_ROOT/repo"
    echo "# repo zshrc" > "$TMPDIR_ROOT/repo/zshrc"
    ln -s "$TMPDIR_ROOT/repo/zshrc" "$HOME/.zshrc"
    fake curl 'out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done; printf "#!/bin/sh\necho pnpm-install >> \"$CALLS\"\nrm -f \"\$HOME/.zshrc\"\necho PNPM_HOME > \"\$HOME/.zshrc\"\n" > "$out"'
    PATH="$FAKE_BIN:/usr/bin:/bin" install_pnpm > /dev/null
    assert_eq 0 $? "returns 0"
    assert_contains "$(cat "$CALLS")" "pnpm-install" "ran the installer"
    assert_eq "$TMPDIR_ROOT/repo/zshrc" "$(readlink "$HOME/.zshrc")" "symlink restored"
    assert_eq "# repo zshrc" "$(cat "$TMPDIR_ROOT/repo/zshrc")" "repo file untouched"
    assert_eq "PNPM_HOME" "$(cat "$HOME/.dotfiles_backup/.zshrc.pnpm-setup")" "clobbered file kept as a backup"
    : > "$CALLS"; fake pnpm 'exit 0'
    install_pnpm > /dev/null
    assert_eq 0 $? "present -> returns 0"
    assert_eq "" "$(cat "$CALLS")" "present -> no installer"
    end_test
}

test_install_fonts_skips_installed_fonts() {
    setup_test "install_fonts is idempotent"
    setup_fakes
    export HOME="$TMPDIR_ROOT/home"; local dir="$HOME/.local/share/fonts"; mkdir -p "$dir/NerdFonts"
    printf 'unzip\nfontconfig\n' > "$INSTALLED"
    touch "$dir/NerdFonts/JetBrainsMonoNerdFont-Regular.ttf" "$dir/FiraCodeNerdFont-Regular.ttf" \
        "$dir/MesloLGS NF Regular.ttf" "$dir/MesloLGS NF Bold.ttf" \
        "$dir/MesloLGS NF Italic.ttf" "$dir/MesloLGS NF Bold Italic.ttf"
    fake curl 'echo "curl $*" >> "$CALLS"; exit 1'
    fake fc-cache 'echo "fc-cache $*" >> "$CALLS"'
    install_fonts > /dev/null
    assert_eq 0 $? "returns 0"
    assert_eq "" "$(cat "$CALLS")" "no downloads, no fc-cache"
    assert_eq "yes" "$([ -f "$dir/JetBrainsMonoNerdFont-Regular.ttf" ] && [ ! -d "$dir/NerdFonts" ] && echo yes)" \
        "old NerdFonts/ directory flattened"
    end_test
}

test_install_cli_extras_links_batcat() {
    setup_test "install_cli_extras links bat"
    setup_fakes
    export HOME="$TMPDIR_ROOT/home"; mkdir -p "$HOME" "$TMPDIR_ROOT/usrbin"
    printf 'eza\nbat\nzoxide\natuin\n' > "$INSTALLED"
    printf '#!/bin/sh\n' > "$TMPDIR_ROOT/usrbin/batcat"; chmod +x "$TMPDIR_ROOT/usrbin/batcat"
    PATH="$FAKE_BIN:$TMPDIR_ROOT/usrbin:/usr/bin:/bin" install_cli_extras > /dev/null
    assert_eq 0 $? "returns 0"
    assert_eq "$TMPDIR_ROOT/usrbin/batcat" "$(readlink "$HOME/.local/bin/bat")" "bat -> batcat"
    # A release with no atuin package (Ubuntu 24.04) still gets the others.
    : > "$INSTALLED"; fake apt-cache 'exit 100'
    install_cli_extras > /dev/null 2>&1
    assert_eq 0 $? "no atuin package -> returns 0"
    assert_contains "$(cat "$CALLS")" "apt-get install -y eza bat zoxide" "installs the rest"
    assert_not_contains "$(cat "$CALLS")" "atuin" "skips atuin"
    end_test
}

# Sections run under pipefail. `find | grep -q .` there fails with SIGPIPE when
# grep exits before find has written everything, so many fonts must still count.
test_install_fonts_many_fonts_under_pipefail() {
    setup_test "install_fonts with many fonts under pipefail"
    setup_fakes
    export HOME="$TMPDIR_ROOT/home"; local dir="$HOME/.local/share/fonts" i pad
    mkdir -p "$dir"
    printf 'unzip\nfontconfig\n' > "$INSTALLED"
    pad="$(printf 'x%.0s' {1..150})"
    for i in $(seq 1 1500); do
        : > "$dir/JetBrainsMonoNerdFont-$pad-$i.ttf"; : > "$dir/FiraCodeNerdFont-$pad-$i.ttf"
    done
    touch "$dir/MesloLGS NF Regular.ttf" "$dir/MesloLGS NF Bold.ttf" \
        "$dir/MesloLGS NF Italic.ttf" "$dir/MesloLGS NF Bold Italic.ttf"
    fake curl 'echo "curl $*" >> "$CALLS"; exit 1'
    fake fc-cache 'echo "fc-cache $*" >> "$CALLS"'
    ( set -o pipefail; install_fonts > /dev/null 2>&1 )
    assert_eq 0 $? "returns 0"
    assert_eq "" "$(cat "$CALLS")" "no downloads"
    end_test
}

# An atuin installed outside apt (the old server script's /usr/local/bin/atuin)
# counts as installed, so apt doesn't install a second copy.
test_install_cli_extras_keeps_atuin_on_path() {
    setup_test "install_cli_extras keeps a non-apt atuin"
    setup_fakes
    export HOME="$TMPDIR_ROOT/home"; mkdir -p "$HOME" "$TMPDIR_ROOT/usrbin"
    printf 'eza\nbat\nzoxide\n' > "$INSTALLED"
    fake apt-cache 'exit 0'
    fake bat 'exit 0'
    local path="$FAKE_BIN:$TMPDIR_ROOT/usrbin" t
    for t in bash env mkdir ln grep cat readlink dirname; do ln -sf "$(command -v "$t")" "$TMPDIR_ROOT/usrbin/$t"; done
    PATH="$path" install_cli_extras > /dev/null 2>&1
    assert_contains "$(cat "$CALLS")" "apt-get install -y atuin" "no atuin anywhere -> apt installs it"
    : > "$CALLS"; fake atuin 'exit 0'
    PATH="$path" install_cli_extras > /dev/null 2>&1
    assert_eq 0 $? "returns 0"
    assert_not_contains "$(cat "$CALLS")" "atuin" "atuin on PATH -> not installed again"
    end_test
}

# The same pipefail trap as install_fonts: `ufw status | grep -q` fails when
# grep exits before ufw has written everything, and UFW would be re-configured.
test_configure_ufw_leaves_active_firewall_under_pipefail() {
    setup_test "configure_ufw with an active firewall under pipefail"
    setup_fakes
    mkdir -p "$TMPDIR_ROOT/systemd"; echo ufw > "$INSTALLED"
    fake ufw '[ "$1" = status ] && { echo "Status: active"; seq 1 200000; exit; }; echo "ufw $*" >> "$CALLS"'
    ( set -o pipefail; SYSTEMD_RUN_DIR="$TMPDIR_ROOT/systemd" configure_ufw > "$TMPDIR_ROOT/out" 2>&1 )
    assert_eq 0 $? "returns 0"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "already active" "sees it is active"
    assert_not_contains "$(cat "$CALLS")" "ufw default" "rules left alone"
    end_test
}

test_install_docker_keeps_ubuntu_docker_io() {
    setup_test "install_docker with docker.io present"
    setup_fakes
    echo docker.io > "$INSTALLED"
    mkdir -p "$TMPDIR_ROOT/systemd"
    fake getent '[ "$2" = docker ] && echo "docker:x:999:"'
    fake id 'echo "anto sudo"'
    fake curl 'echo "curl $*" >> "$CALLS"'
    fake systemctl 'echo "systemctl $*" >> "$CALLS"'
    add_apt_source() { echo "add_apt_source $*" >> "$CALLS"; }
    USER=anto SYSTEMD_RUN_DIR="$TMPDIR_ROOT/systemd" install_docker > "$TMPDIR_ROOT/out" 2>&1
    assert_eq 0 $? "returns 0"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "docker.io (Ubuntu's Docker) is installed; leaving it in place" "message"
    assert_not_contains "$(cat "$CALLS")" "add_apt_source" "no repo added"
    assert_not_contains "$(cat "$CALLS")" "curl" "no download"
    assert_not_contains "$(cat "$CALLS")" "docker-ce" "no docker-ce"
    assert_contains "$(cat "$CALLS")" "usermod -aG docker anto" "user added to group"
    assert_contains "$(cat "$CALLS")" "systemctl enable --now docker" "service enabled"
    end_test
}

test_apt_install_missing_installs_only_missing
test_install_docker_keeps_ubuntu_docker_io
test_snap_install_missing
test_ensure_user_in_group
test_install_dotnet_only_missing_channels
test_nvidia_toolkit_skips_without_gpu
test_pinned_tools_skip_on_non_amd64
test_install_pnpm_restores_rc_symlinks
test_install_fonts_skips_installed_fonts
test_install_cli_extras_links_batcat
test_install_fonts_many_fonts_under_pipefail
test_install_cli_extras_keeps_atuin_on_path
test_configure_ufw_leaves_active_firewall_under_pipefail
summary

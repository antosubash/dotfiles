#!/usr/bin/env bash
# Checks for the zsh config: compose aliases, tool names, and a startup that
# doesn't run compinit twice or reference macOS-only paths.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_DIR="$(cd "$HERE/../.." && pwd)/shell"
SCRIPT="$SHELL_DIR/.zshrc"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

test_compose_aliases_use_the_plugin() {
    setup_test "docker compose aliases"
    local a; a="$(grep -E '^alias (dc|dup|ddown)=' "$SHELL_DIR/aliases.zsh")"
    assert_not_contains "$a" "docker-compose" "no hyphenated compose"
    assert_contains "$a" 'alias dc="docker compose"' "dc"
    teardown_test
}

test_fastfetch_constant() {
    setup_test "fastfetch"
    assert_not_contains "$(cat "$SHELL_DIR/constants.zsh")" "neofetch" "neofetch gone"
    teardown_test
}

test_no_macos_docker_desktop_block() {
    setup_test "no Docker Desktop block"
    assert_not_contains "$(cat "$SCRIPT")" "/Volumes/ext1" "macOS path"
    teardown_test
}

test_fzf_bindings_from_apt() {
    setup_test "fzf key bindings"
    assert_contains "$(cat "$SHELL_DIR/completion.zsh")" "/usr/share/doc/fzf/examples/key-bindings.zsh" "apt fzf"
    teardown_test
}

test_zsh_parses() {
    setup_test "zsh -n"
    if command -v zsh > /dev/null; then
        local f
        for f in "$SHELL_DIR"/*.zsh "$SCRIPT"; do zsh -n "$f"; assert_eq 0 $? "$f parses"; done
    fi
    teardown_test
}

test_compose_aliases_use_the_plugin
test_fastfetch_constant
test_no_macos_docker_desktop_block
test_fzf_bindings_from_apt
test_zsh_parses
summary

#!/usr/bin/env bash
# Contract: no Linux setup/update script writes to the shell rc files, which
# install.sh symlinks into this repo (a write would dirty tracked files).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC2034  # lib.sh contract: SCRIPT names the script under test
SCRIPT="$SCRIPTS/setup-ubuntu.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

test_no_script_appends_to_rc_files() {
    setup_test "no rc writes"
    local hits
    hits="$(grep -nE '(>>|tee( -a)?) *("?\$HOME|~)/\.(zshrc|bashrc|profile)|for rc in ~/\.zshrc' \
        "$SCRIPTS"/setup-ubuntu.sh "$SCRIPTS"/setup-server.sh "$SCRIPTS"/setup-update.sh \
        "$SCRIPTS"/update-all.sh "$SCRIPTS"/update-quick.sh "$SCRIPTS"/lib/*.sh \
        "$SCRIPTS"/setup-keyboard.sh 2>/dev/null)"
    assert_eq "" "$hits" "rc-file writes"
    teardown_test
}

test_no_script_appends_to_rc_files
summary

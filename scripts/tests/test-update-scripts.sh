#!/usr/bin/env bash
# Tests for scripts/update-all.sh, update-quick.sh and setup-update.sh.
# update-all.sh is sourced (UPDATE_ALL_SOURCE_ONLY=1) and driven with fakes;
# the real update scripts are never run (they call sudo/apt/docker).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "$HERE/.." && pwd)"
SCRIPT="$SCRIPTS/update-all.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

# Source update-all.sh without its set -e, so a test failure doesn't abort us.
load_update_all() {
    # shellcheck disable=SC1090
    UPDATE_ALL_SOURCE_ONLY=1 . "$SCRIPT"
    set +e
}

# fake NAME [EXIT]: records "NAME args" in $FAKE_LOG, exits with EXIT.
fake() {
    cat > "$FAKE_BIN/$1" <<EOS
#!/usr/bin/env bash
echo "$1 \$*" >> "$FAKE_LOG"
exit ${2:-0}
EOS
    chmod +x "$FAKE_BIN/$1"
}

test_dirty_dotfiles_is_not_pulled() {
    setup_test "dirty dotfiles"
    export HOME="$TMPDIR_ROOT/home"
    make_repo "$HOME/dotfiles"
    echo x > "$HOME/dotfiles/untracked"
    local before out rc
    before="$(git -C "$HOME/dotfiles" rev-parse HEAD)"
    load_update_all
    out="$(update_dotfiles 2>&1)"; rc=$?
    assert_eq 0 "$rc" "returns 0"
    assert_contains "$out" "skipping" "says skipping"
    assert_eq "$before" "$(git -C "$HOME/dotfiles" rev-parse HEAD)" "HEAD unchanged"
    teardown_test
}

test_non_main_branch_is_not_pulled() {
    setup_test "non-main branch"
    export HOME="$TMPDIR_ROOT/home"
    make_repo "$HOME/dotfiles"
    git -C "$HOME/dotfiles" checkout -q -b feature
    # A pull attempt would warn "could not" (no origin), so its absence proves skipping.
    load_update_all
    local out rc
    out="$(update_dotfiles 2>&1)"; rc=$?
    assert_eq 0 "$rc" "returns 0"
    assert_contains "$out" "on branch feature, not main; skipping git pull" "names the branch"
    assert_not_contains "$out" "could not" "never attempted the pull"
    teardown_test
}

test_failed_pull_is_a_warning() {
    setup_test "no remote"
    export HOME="$TMPDIR_ROOT/home"
    make_repo "$HOME/dotfiles"
    local out rc
    load_update_all
    out="$(update_dotfiles 2>&1)"; rc=$?
    assert_eq 0 "$rc" "returns 0"
    assert_contains "$out" "could not" "warns"
    teardown_test
}

test_cleanup_never_prunes_volumes() {
    setup_test "cleanup"
    export HOME="$TMPDIR_ROOT/home"; mkdir -p "$HOME"
    FAKE_LOG="$TMPDIR_ROOT/fake.log"; : > "$FAKE_LOG"
    fake docker; fake sudo; fake apt; fake pip3 1; fake snap
    printf 'ii  bash 5\nrc  oldpkg 1\n' > "$TMPDIR_ROOT/dpkg.out"
    cat > "$FAKE_BIN/dpkg" <<EOS
#!/usr/bin/env bash
cat "$TMPDIR_ROOT/dpkg.out"
EOS
    chmod +x "$FAKE_BIN/dpkg"
    load_update_all
    # shellcheck disable=SC2034  # read by the sourced update-all.sh
    OS=linux
    local rc
    cleanup > /dev/null 2>&1; rc=$?
    local log; log="$(cat "$FAKE_LOG")"
    assert_eq 0 "$rc" "returns 0 despite pip3 failure"
    assert_contains "$log" "docker image prune -f" "image prune"
    assert_contains "$log" "docker builder prune -f --filter until=168h" "builder prune"
    assert_not_contains "$log" "--volumes" "no volumes"
    assert_not_contains "$log" "system prune" "no system prune"
    assert_contains "$log" "apt-get purge -y oldpkg" "purges rc packages"
    teardown_test
}

test_failing_step_is_recorded() {
    setup_test "failed step"
    export HOME="$TMPDIR_ROOT/home"; mkdir -p "$HOME"
    FAKE_LOG="$TMPDIR_ROOT/fake.log"; : > "$FAKE_LOG"
    fake sudo 1; fake apt; fake snap; fake flatpak
    load_update_all
    # shellcheck disable=SC2034  # read by the sourced update-all.sh
    OS=linux
    FAILED_STEPS=()
    local out
    run_step packages update_package_managers > "$TMPDIR_ROOT/out" 2>&1
    out="$(cat "$TMPDIR_ROOT/out")"
    assert_eq "packages" "${FAILED_STEPS[*]-}" "step recorded"
    assert_not_contains "$out" "APT packages updated" "no false success"
    assert_not_contains "$(cat "$FAKE_LOG")" "full-upgrade" "stopped after failed apt update"
    teardown_test
}

test_pinned_tool_failure_is_recorded() {
    setup_test "pinned tools failure"
    export HOME="$TMPDIR_ROOT/home"
    mkdir -p "$HOME/dotfiles/scripts"
    printf '#!/usr/bin/env bash\necho "$*" > "%s/setup.args"\nexit 1\n' "$TMPDIR_ROOT" \
        > "$HOME/dotfiles/scripts/setup-ubuntu.sh"
    load_update_all
    # shellcheck disable=SC2034  # read by the sourced update-all.sh
    OS=linux
    FAILED_STEPS=()
    run_step pinned-tools reconcile_pinned_tools > "$TMPDIR_ROOT/out" 2>&1
    assert_eq "pinned-tools" "${FAILED_STEPS[*]-}" "step recorded"
    assert_contains "$(cat "$TMPDIR_ROOT/setup.args")" "--only languages,cli,git-tools,k8s,node" "sections"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "some pinned tools failed to update" "warns"
    local out
    out="$(generate_summary 2>&1)"
    assert_contains "$out" "completed with failures: pinned-tools" "summary"
    assert_not_contains "$out" "completed successfully" "no false success"
    # Exit code: a full run with this failure must exit 1 (steps mocked out).
    out="$(
        # shellcheck disable=SC1090
        UPDATE_ALL_SOURCE_ONLY=1 . "$SCRIPT"; set +e
        OS=linux
        detect_os() { :; }
        update_dotfiles() { :; }; update_package_managers() { :; }
        update_cli_tools() { :; }; update_security_tools() { :; }; cleanup() { :; }
        ( main ) > /dev/null 2>&1; echo "exit=$?"
    )"
    assert_contains "$out" "exit=1" "main exits 1"
    teardown_test
}

test_passing_step_is_not_recorded() {
    setup_test "passing step"
    load_update_all
    FAILED_STEPS=()
    ok_step() { return 0; }
    run_step ok ok_step
    assert_eq 0 "${#FAILED_STEPS[@]}" "nothing recorded"
    teardown_test
}

test_summary_reports_failures() {
    setup_test "summary failures"
    export HOME="$TMPDIR_ROOT/home"; mkdir -p "$HOME"
    load_update_all
    # shellcheck disable=SC2034  # read by the sourced update-all.sh
    OS=linux
    FAILED_STEPS=(packages cli)
    local out
    out="$(generate_summary 2>&1)"
    assert_contains "$out" "completed with failures: packages cli" "lists failures"
    FAILED_STEPS=()
    out="$(generate_summary 2>&1)"
    assert_not_contains "$out" "completed with failures" "clean run"
    teardown_test
}

test_dry_run_changes_nothing() {
    setup_test "dry run"
    export HOME="$TMPDIR_ROOT/home"; mkdir -p "$HOME"
    FAKE_LOG="$TMPDIR_ROOT/fake.log"; : > "$FAKE_LOG"
    fake sudo 1; fake docker; fake apt
    local out rc
    out="$(bash "$SCRIPT" --dry-run 2>&1)"; rc=$?
    assert_eq 0 "$rc" "exit 0"
    assert_contains "$out" "Dry run" "announces dry run"
    assert_not_contains "$(cat "$FAKE_LOG")" "sudo" "no sudo"
    assert_not_contains "$(cat "$FAKE_LOG")" "docker" "no docker"
    teardown_test
}

test_setup_update_has_no_stale_aliases() {
    setup_test "setup-update.sh"
    assert_eq 0 "$(grep -c -- '--full' "$SCRIPTS/setup-update.sh")" "no --full"
    assert_eq 0 "$(grep -cE 'go-up|pip-up' "$SCRIPTS/setup-update.sh")" "no go-up/pip-up"
    assert_eq 0 "$(grep -c 'update_shell_configs' "$SCRIPTS/setup-update.sh")" "no rc writer"
    assert_eq 0 "$(grep -c 'system prune' "$SCRIPTS/setup-update.sh")" "no system prune alias"
    assert_contains "$(grep 'docker-up' "$SCRIPTS/setup-update.sh")" "docker image prune -f && docker builder prune -f --filter until=168h" "docker-up"
    teardown_test
}

test_setup_update_renames_manager() {
    setup_test "update-manager rename"
    export HOME="$TMPDIR_ROOT/home"
    mkdir -p "$HOME/dotfiles/scripts" "$HOME/.local/bin"
    : > "$HOME/dotfiles/scripts/update-all.sh"
    fake crontab
    FAKE_LOG="$TMPDIR_ROOT/fake.log"; : > "$FAKE_LOG"
    # An old update-manager made by this installer is replaced; a foreign one is kept.
    printf '#!/bin/bash\ncd "$HOME/dotfiles"\n' > "$HOME/.local/bin/update-manager"
    bash "$SCRIPTS/setup-update.sh" > /dev/null 2>&1
    assert_eq yes "$([ -x "$HOME/.local/bin/dotfiles-update" ] && echo yes || echo no)" "dotfiles-update created"
    assert_eq no "$([ -e "$HOME/.local/bin/update-manager" ] && echo yes || echo no)" "old one removed"
    printf '#!/bin/bash\necho Software Updater\n' > "$HOME/.local/bin/update-manager"
    bash "$SCRIPTS/setup-update.sh" > /dev/null 2>&1
    assert_eq yes "$([ -e "$HOME/.local/bin/update-manager" ] && echo yes || echo no)" "foreign one kept"
    assert_not_contains "$(cat "$HOME/.update_aliases")" "--full" "aliases have no --full"
    # npm-up is generated for macOS only
    assert_eq no "$(awk '/^else/{l=1} /^fi/{l=0} l&&/npm-up/{f=1} END{print f?"yes":"no"}' "$HOME/.update_aliases")" "no npm-up in linux branch"
    assert_contains "$(grep -c 'npm-up' "$HOME/.update_aliases")" "1" "npm-up defined once"
    teardown_test
}

test_update_quick_leaves_npm_alone_on_linux() {
    setup_test "update-quick npm"
    assert_eq 1 "$(grep -c 'npm update -g' "$SCRIPTS/update-quick.sh")" "single npm update call"
    assert_contains "$(grep -B4 'npm update -g' "$SCRIPTS/update-quick.sh")" 'OS" == "macos"' "macos only"
    assert_contains "$(cat "$SCRIPTS/update-quick.sh")" "setup-ubuntu.sh --only node" "documents who owns npm on linux"
    teardown_test
}

test_dirty_dotfiles_is_not_pulled
test_non_main_branch_is_not_pulled
test_failed_pull_is_a_warning
test_cleanup_never_prunes_volumes
test_failing_step_is_recorded
test_pinned_tool_failure_is_recorded
test_passing_step_is_not_recorded
test_summary_reports_failures
test_dry_run_changes_nothing
test_setup_update_has_no_stale_aliases
test_setup_update_renames_manager
test_update_quick_leaves_npm_alone_on_linux
summary

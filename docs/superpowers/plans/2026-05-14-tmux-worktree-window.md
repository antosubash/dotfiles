# tmux worktree window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `prefix + g` tmux binding that opens a new window in a git worktree (creating it on demand) when invoked inside a git repo.

**Architecture:** A POSIX `sh` helper script with two subcommands (`prompt` and `spawn`) plus pure helpers (`sanitize_name`, `main_toplevel`, `ensure_worktree`). The script can be sourced for unit testing — when `_TMUX_WORKTREE_SOURCE_ONLY=1` is set in the environment, it defines functions but does not dispatch. Tests use real temp git repos and a fake `tmux` binary on `PATH` that records calls to a log file.

**Tech Stack:** POSIX `sh` (script), `bash` (test harness for arrays and `set -u`), `git`, `tmux`, `sed`.

---

## File structure

- **Create**: `scripts/tmux-worktree-window.sh` — the helper script. POSIX `sh`. Executable.
- **Create**: `scripts/tests/test-tmux-worktree-window.sh` — bash test runner. Executable.
- **Modify**: `tmux/.tmux.conf` — add one `bind g` line near the other `bind` lines.

Spec: `docs/superpowers/specs/2026-05-14-tmux-worktree-window-design.md`.

---

### Task 1: Test harness and script skeleton

**Files:**
- Create: `scripts/tmux-worktree-window.sh`
- Create: `scripts/tests/test-tmux-worktree-window.sh`

- [ ] **Step 1: Write the failing test (harness + first assertion)**

Create `scripts/tests/test-tmux-worktree-window.sh`:

```bash
#!/usr/bin/env bash
# Tests for scripts/tmux-worktree-window.sh
# Run: bash scripts/tests/test-tmux-worktree-window.sh

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/tmux-worktree-window.sh"

PASS=0
FAIL=0
FAILURES=()
TEST_NAME=""

setup_test() {
    TEST_NAME="$1"
    TMPDIR_ROOT="$(mktemp -d)"
    FAKE_BIN="$TMPDIR_ROOT/bin"
    mkdir -p "$FAKE_BIN"
    TMUX_LOG="$TMPDIR_ROOT/tmux.log"
    : > "$TMUX_LOG"

    cat > "$FAKE_BIN/tmux" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMUX_LOG"
EOF
    chmod +x "$FAKE_BIN/tmux"

    ORIG_PATH="$PATH"
    export PATH="$FAKE_BIN:$PATH"
    cd "$TMPDIR_ROOT"
}

teardown_test() {
    cd /
    export PATH="$ORIG_PATH"
    rm -rf "$TMPDIR_ROOT"
}

assert_eq() {
    local expected="$1" actual="$2" label="${3:-}"
    if [ "$expected" = "$actual" ]; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1))
        FAILURES+=("$TEST_NAME: $label: expected [$expected] got [$actual]")
    fi
}

assert_contains() {
    local haystack="$1" needle="$2" label="${3:-}"
    case "$haystack" in
        *"$needle"*) PASS=$((PASS+1)) ;;
        *)
            FAIL=$((FAIL+1))
            FAILURES+=("$TEST_NAME: $label: [$haystack] does not contain [$needle]")
            ;;
    esac
}

assert_tmux_log_contains() {
    assert_contains "$(cat "$TMUX_LOG")" "$1" "${2:-tmux log}"
}

source_script() {
    # shellcheck disable=SC1090
    _TMUX_WORKTREE_SOURCE_ONLY=1 . "$SCRIPT"
}

summary() {
    echo "------"
    echo "PASS: $PASS  FAIL: $FAIL"
    if [ "$FAIL" -gt 0 ]; then
        printf '  %s\n' "${FAILURES[@]}"
        exit 1
    fi
    exit 0
}

# --- tests ---

test_unknown_subcommand_fails() {
    setup_test "unknown subcommand"
    if "$SCRIPT" bogus 2>"$TMPDIR_ROOT/err"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: expected non-zero exit")
    else
        PASS=$((PASS+1))
    fi
    assert_contains "$(cat "$TMPDIR_ROOT/err")" "unknown" "stderr mentions unknown"
    teardown_test
}

test_unknown_subcommand_fails
summary
```

- [ ] **Step 2: Run test to verify it fails**

```
chmod +x scripts/tests/test-tmux-worktree-window.sh
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: FAIL because `$SCRIPT` doesn't exist yet.

- [ ] **Step 3: Write minimal script skeleton**

Create `scripts/tmux-worktree-window.sh`:

```sh
#!/bin/sh
# tmux-worktree-window: open a new tmux window in a git worktree.
# Subcommands:
#   prompt <pane_current_path>   - prompt for branch, then dispatch to spawn
#   spawn  <pane_current_path> <branch>  - resolve/create worktree, open window

# When sourced with _TMUX_WORKTREE_SOURCE_ONLY=1, only define functions.

cmd_prompt() {
    :  # placeholder, filled in later
}

cmd_spawn() {
    :  # placeholder, filled in later
}

main() {
    sub="${1:-}"
    [ $# -gt 0 ] && shift
    case "$sub" in
        prompt) cmd_prompt "$@" ;;
        spawn)  cmd_spawn  "$@" ;;
        *)
            printf 'tmux-worktree-window: unknown subcommand: %s\n' "$sub" >&2
            return 1
            ;;
    esac
}

if [ -z "${_TMUX_WORKTREE_SOURCE_ONLY:-}" ]; then
    main "$@"
fi
```

```
chmod +x scripts/tmux-worktree-window.sh
```

- [ ] **Step 4: Run test to verify it passes**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: PASS: 2  FAIL: 0

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux-worktree-window.sh scripts/tests/test-tmux-worktree-window.sh
git commit -m "Add tmux-worktree-window script skeleton and test harness"
```

---

### Task 2: Sanitization helper (`sanitize_name`)

**Files:**
- Modify: `scripts/tmux-worktree-window.sh`
- Modify: `scripts/tests/test-tmux-worktree-window.sh`

- [ ] **Step 1: Write the failing tests**

Append before `summary` in `scripts/tests/test-tmux-worktree-window.sh`:

```bash
test_sanitize_name() {
    setup_test "sanitize_name"
    source_script

    assert_eq "feature-foo"      "$(sanitize_name 'feature/foo')"      "slash → dash"
    assert_eq "a-b-c"            "$(sanitize_name 'a/b/c')"            "multiple slashes"
    assert_eq "bugfix-ABC-123"   "$(sanitize_name 'bugfix/ABC-123')"   "preserves alnum and dash"
    assert_eq "ok.v1_x"          "$(sanitize_name 'ok.v1_x')"          "preserves . and _"
    assert_eq "weird-name"       "$(sanitize_name 'weird   name')"     "collapses runs"
    assert_eq "trimmed"          "$(sanitize_name '--trimmed--')"      "trims edges"
    assert_eq ""                 "$(sanitize_name '///')"              "all-bad → empty"
    assert_eq ""                 "$(sanitize_name '')"                 "empty stays empty"
    assert_eq "a-b"              "$(sanitize_name 'a$b')"              "special char → dash"

    teardown_test
}

test_sanitize_name
```

And update the call list so `summary` runs after this test (move `summary` to the end of the file).

- [ ] **Step 2: Run tests to verify they fail**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: FAIL — `sanitize_name: command not found` (or 9 failures).

- [ ] **Step 3: Implement `sanitize_name`**

In `scripts/tmux-worktree-window.sh`, add this function above `cmd_prompt`:

```sh
sanitize_name() {
    name="$1"
    name=$(printf '%s' "$name" | sed 's/[^A-Za-z0-9._-]/-/g; s/--*/-/g; s/^-//; s/-$//')
    printf '%s' "$name"
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: all assertions pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux-worktree-window.sh scripts/tests/test-tmux-worktree-window.sh
git commit -m "Add sanitize_name helper for worktree/window naming"
```

---

### Task 3: Main-repo toplevel resolution (`main_toplevel`)

**Files:**
- Modify: `scripts/tmux-worktree-window.sh`
- Modify: `scripts/tests/test-tmux-worktree-window.sh`

- [ ] **Step 1: Write the failing tests**

Append before `summary`:

```bash
make_repo() {
    # Creates a real git repo with one commit at $1.
    local dir="$1"
    mkdir -p "$dir"
    git -C "$dir" init -q -b main
    git -C "$dir" config user.email t@t
    git -C "$dir" config user.name t
    : > "$dir/README"
    git -C "$dir" add README
    git -C "$dir" commit -q -m init
}

test_main_toplevel_in_repo() {
    setup_test "main_toplevel in plain repo"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    local top
    top=$(main_toplevel "$TMPDIR_ROOT/repo")
    assert_eq "$TMPDIR_ROOT/repo" "$top" "toplevel matches"
    teardown_test
}

test_main_toplevel_in_subdir() {
    setup_test "main_toplevel from subdir"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    mkdir -p "$TMPDIR_ROOT/repo/sub/dir"
    local top
    top=$(main_toplevel "$TMPDIR_ROOT/repo/sub/dir")
    assert_eq "$TMPDIR_ROOT/repo" "$top" "toplevel from subdir"
    teardown_test
}

test_main_toplevel_from_worktree() {
    setup_test "main_toplevel from inside a worktree"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b wt "$TMPDIR_ROOT/repo/.worktrees/wt" >/dev/null 2>&1
    local top
    top=$(main_toplevel "$TMPDIR_ROOT/repo/.worktrees/wt")
    assert_eq "$TMPDIR_ROOT/repo" "$top" "toplevel from worktree resolves to main"
    teardown_test
}

test_main_toplevel_not_repo() {
    setup_test "main_toplevel outside a repo"
    source_script
    mkdir -p "$TMPDIR_ROOT/plain"
    if main_toplevel "$TMPDIR_ROOT/plain" >/dev/null 2>&1; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: expected non-zero exit")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_main_toplevel_in_repo
test_main_toplevel_in_subdir
test_main_toplevel_from_worktree
test_main_toplevel_not_repo
```

- [ ] **Step 2: Run tests to verify they fail**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: FAIL — `main_toplevel: command not found`.

- [ ] **Step 3: Implement `main_toplevel`**

Add to `scripts/tmux-worktree-window.sh`, above `sanitize_name`:

```sh
main_toplevel() {
    path="$1"
    common_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
    # common_dir points at "<main>/.git". Its parent is the main toplevel.
    dirname "$common_dir"
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux-worktree-window.sh scripts/tests/test-tmux-worktree-window.sh
git commit -m "Add main_toplevel helper resolving to primary repo path"
```

---

### Task 4: Worktree resolution and creation (`ensure_worktree`)

**Files:**
- Modify: `scripts/tmux-worktree-window.sh`
- Modify: `scripts/tests/test-tmux-worktree-window.sh`

- [ ] **Step 1: Write the failing tests**

Append before `summary`:

```bash
test_ensure_worktree_new_branch() {
    setup_test "ensure_worktree creates a new branch"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    local wt="$TMPDIR_ROOT/repo/.worktrees/new-feat"
    ensure_worktree "$TMPDIR_ROOT/repo" "new-feat" "$wt"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    # Branch should now exist locally
    if git -C "$TMPDIR_ROOT/repo" show-ref --verify --quiet refs/heads/new-feat; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: new-feat branch not created")
    fi
    teardown_test
}

test_ensure_worktree_existing_local_branch() {
    setup_test "ensure_worktree uses existing local branch"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" branch existing
    local wt="$TMPDIR_ROOT/repo/.worktrees/existing"
    ensure_worktree "$TMPDIR_ROOT/repo" "existing" "$wt"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    # Branch HEAD in the worktree must match the local branch
    local wt_head main_head
    wt_head=$(git -C "$wt" rev-parse HEAD)
    main_head=$(git -C "$TMPDIR_ROOT/repo" rev-parse existing)
    assert_eq "$main_head" "$wt_head" "worktree on existing branch"
    teardown_test
}

test_ensure_worktree_from_origin() {
    setup_test "ensure_worktree pulls branch from origin"
    source_script
    # Make an "origin" repo with a branch, then clone it
    make_repo "$TMPDIR_ROOT/origin"
    git -C "$TMPDIR_ROOT/origin" checkout -q -b remote-feat
    : > "$TMPDIR_ROOT/origin/file"
    git -C "$TMPDIR_ROOT/origin" add file
    git -C "$TMPDIR_ROOT/origin" commit -q -m feat
    git -C "$TMPDIR_ROOT/origin" checkout -q main
    git clone -q "$TMPDIR_ROOT/origin" "$TMPDIR_ROOT/clone"
    git -C "$TMPDIR_ROOT/clone" fetch -q origin
    local wt="$TMPDIR_ROOT/clone/.worktrees/remote-feat"
    ensure_worktree "$TMPDIR_ROOT/clone" "remote-feat" "$wt"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    # Local branch should now exist, tracking origin/remote-feat
    if git -C "$TMPDIR_ROOT/clone" show-ref --verify --quiet refs/heads/remote-feat; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: local branch not created from origin")
    fi
    teardown_test
}

test_ensure_worktree_idempotent() {
    setup_test "ensure_worktree is idempotent when path exists"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    local wt="$TMPDIR_ROOT/repo/.worktrees/x"
    ensure_worktree "$TMPDIR_ROOT/repo" "x" "$wt"
    # Second call should succeed without trying to add again
    if ensure_worktree "$TMPDIR_ROOT/repo" "x" "$wt" 2>"$TMPDIR_ROOT/err"; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: second call failed: $(cat "$TMPDIR_ROOT/err")")
    fi
    teardown_test
}

test_ensure_worktree_failure_surfaces() {
    setup_test "ensure_worktree surfaces git errors"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    # Pre-create the worktree, then delete the directory but leave the branch
    # checked out from git's perspective by manually corrupting state:
    # easier path — try to add a branch that's already checked out in main.
    local wt="$TMPDIR_ROOT/repo/.worktrees/main"
    if ensure_worktree "$TMPDIR_ROOT/repo" "main" "$wt" 2>"$TMPDIR_ROOT/err"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: expected non-zero exit (branch already checked out)")
    else
        PASS=$((PASS+1))
    fi
    # Stderr should be non-empty
    if [ -s "$TMPDIR_ROOT/err" ]; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: expected git error on stderr")
    fi
    teardown_test
}

test_ensure_worktree_new_branch
test_ensure_worktree_existing_local_branch
test_ensure_worktree_from_origin
test_ensure_worktree_idempotent
test_ensure_worktree_failure_surfaces
```

- [ ] **Step 2: Run tests to verify they fail**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: FAIL — `ensure_worktree: command not found`.

- [ ] **Step 3: Implement `ensure_worktree`**

Add to `scripts/tmux-worktree-window.sh`, above `cmd_prompt`:

```sh
ensure_worktree() {
    repo_path="$1"
    branch="$2"
    worktree_path="$3"

    if [ -d "$worktree_path" ]; then
        return 0
    fi

    if git -C "$repo_path" show-ref --verify --quiet "refs/heads/$branch"; then
        git -C "$repo_path" worktree add "$worktree_path" "$branch" >/dev/null
    elif git -C "$repo_path" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        git -C "$repo_path" worktree add -b "$branch" "$worktree_path" "origin/$branch" >/dev/null
    else
        git -C "$repo_path" worktree add -b "$branch" "$worktree_path" >/dev/null
    fi
}
```

Note: `>/dev/null` silences git's success messages on stdout but leaves stderr alone so callers can capture errors.

- [ ] **Step 4: Run tests to verify they pass**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux-worktree-window.sh scripts/tests/test-tmux-worktree-window.sh
git commit -m "Add ensure_worktree helper resolving local/origin/new branches"
```

---

### Task 5: `spawn` subcommand orchestration

**Files:**
- Modify: `scripts/tmux-worktree-window.sh`
- Modify: `scripts/tests/test-tmux-worktree-window.sh`

- [ ] **Step 1: Write the failing tests**

Append before `summary`:

```bash
test_spawn_creates_window() {
    setup_test "spawn creates worktree and tmux window"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" "feature/foo"
    local wt="$TMPDIR_ROOT/repo/.worktrees/feature-foo"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    assert_tmux_log_contains "new-window -n feature-foo -c $wt" "new-window call"
    teardown_test
}

test_spawn_empty_branch_silent() {
    setup_test "spawn with empty branch is silent"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" ""
    assert_eq "" "$(cat "$TMUX_LOG")" "no tmux calls"
    teardown_test
}

test_spawn_invalid_sanitized_name() {
    setup_test "spawn with branch that sanitizes to empty shows message"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" "///"
    assert_tmux_log_contains "display-message" "shows error"
    assert_tmux_log_contains "invalid branch name" "specific message"
    # No new-window call
    if grep -q "new-window" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not call new-window")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_spawn_outside_repo() {
    setup_test "spawn outside a git repo shows message"
    mkdir -p "$TMPDIR_ROOT/plain"
    "$SCRIPT" spawn "$TMPDIR_ROOT/plain" "foo"
    assert_tmux_log_contains "display-message" "shows error"
    assert_tmux_log_contains "not a git repo" "specific message"
    teardown_test
}

test_spawn_git_failure_displays_error() {
    setup_test "spawn surfaces git worktree add failure"
    make_repo "$TMPDIR_ROOT/repo"
    # main branch is already checked out in the main worktree — adding it again fails
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" "main"
    assert_tmux_log_contains "display-message" "shows error"
    # No new-window because the add failed
    if grep -q "new-window" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not call new-window")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_spawn_reuses_existing_worktree() {
    setup_test "spawn opens window when worktree already exists"
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b reused "$TMPDIR_ROOT/repo/.worktrees/reused" >/dev/null 2>&1
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" "reused"
    assert_tmux_log_contains "new-window -n reused -c $TMPDIR_ROOT/repo/.worktrees/reused" "opens window"
    teardown_test
}

test_spawn_creates_window
test_spawn_empty_branch_silent
test_spawn_invalid_sanitized_name
test_spawn_outside_repo
test_spawn_git_failure_displays_error
test_spawn_reuses_existing_worktree
```

- [ ] **Step 2: Run tests to verify they fail**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: FAIL — `cmd_spawn` is still a placeholder.

- [ ] **Step 3: Implement `cmd_spawn`**

Replace the placeholder `cmd_spawn` in `scripts/tmux-worktree-window.sh`:

```sh
cmd_spawn() {
    pane_path="${1:-}"
    branch="${2:-}"

    if [ -z "$branch" ]; then
        return 0
    fi

    sanitized=$(sanitize_name "$branch")
    if [ -z "$sanitized" ]; then
        tmux display-message "invalid branch name"
        return 0
    fi

    toplevel=$(main_toplevel "$pane_path") || {
        tmux display-message "not a git repo"
        return 0
    }

    worktree_path="$toplevel/.worktrees/$sanitized"

    if ! err=$(ensure_worktree "$pane_path" "$branch" "$worktree_path" 2>&1); then
        tmux display-message "$err"
        return 0
    fi

    tmux new-window -n "$sanitized" -c "$worktree_path"
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux-worktree-window.sh scripts/tests/test-tmux-worktree-window.sh
git commit -m "Implement spawn subcommand to create worktree and open window"
```

---

### Task 6: `prompt` subcommand

**Files:**
- Modify: `scripts/tmux-worktree-window.sh`
- Modify: `scripts/tests/test-tmux-worktree-window.sh`

- [ ] **Step 1: Write the failing tests**

Append before `summary`:

```bash
test_prompt_outside_repo() {
    setup_test "prompt outside repo shows message"
    mkdir -p "$TMPDIR_ROOT/plain"
    "$SCRIPT" prompt "$TMPDIR_ROOT/plain"
    assert_tmux_log_contains "display-message" "shows message"
    assert_tmux_log_contains "not a git repo" "specific message"
    # No command-prompt issued
    if grep -q "command-prompt" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not issue command-prompt")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_prompt_in_repo_issues_command_prompt() {
    setup_test "prompt in repo issues command-prompt with run-shell callback"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" prompt "$TMPDIR_ROOT/repo"
    local log
    log="$(cat "$TMUX_LOG")"
    assert_contains "$log" "command-prompt -p branch:" "command-prompt issued"
    assert_contains "$log" "run-shell"               "run-shell in callback"
    assert_contains "$log" "$SCRIPT spawn"           "spawn invocation"
    assert_contains "$log" "$TMPDIR_ROOT/repo"       "pane path baked in"
    assert_contains "$log" "%%"                      "branch placeholder"
    teardown_test
}

test_prompt_outside_repo
test_prompt_in_repo_issues_command_prompt
```

- [ ] **Step 2: Run tests to verify they fail**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: FAIL — `cmd_prompt` is still a placeholder.

- [ ] **Step 3: Implement `cmd_prompt`**

Replace the placeholder `cmd_prompt` in `scripts/tmux-worktree-window.sh`:

```sh
# Quote a string for safe inclusion inside single quotes.
# Replaces every ' with '\''  (close, escaped quote, reopen).
sq_escape() {
    printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

cmd_prompt() {
    pane_path="${1:-}"

    if ! git -C "$pane_path" rev-parse --git-dir >/dev/null 2>&1; then
        tmux display-message "not a git repo"
        return 0
    fi

    # Resolve this script's absolute path so the callback can locate it
    # regardless of cwd at the time the prompt is submitted.
    script_dir=$(cd "$(dirname "$0")" && pwd)
    script_abs="$script_dir/$(basename "$0")"

    # Build the run-shell command: script_abs spawn <pane_path> <%%>
    # pane_path is single-quoted (with embedded single quotes escaped).
    # %% is substituted by tmux as the user's branch input; we wrap it in
    # double quotes so spaces survive. Branch names are restricted by git
    # to a safe character set, so this is sufficient.
    quoted_path=$(sq_escape "$pane_path")
    inner="$script_abs spawn '$quoted_path' \"%%\""
    quoted_inner=$(sq_escape "$inner")

    tmux command-prompt -p "branch:" "run-shell '$quoted_inner'"
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/tmux-worktree-window.sh scripts/tests/test-tmux-worktree-window.sh
git commit -m "Implement prompt subcommand issuing tmux command-prompt"
```

---

### Task 7: Wire into tmux.conf and smoke test

**Files:**
- Modify: `tmux/.tmux.conf:36-50` (the keybindings section)

- [ ] **Step 1: Add the binding**

Open `tmux/.tmux.conf`. After the `bind c new-window -c "#{pane_current_path}"` line (currently line 34), add:

```
# Worktree-aware new window: prompts for branch, opens a window in
# <main-repo>/.worktrees/<branch>. Creates or reuses the worktree.
bind g run-shell "~/dotfiles/scripts/tmux-worktree-window.sh prompt '#{pane_current_path}'"
```

Verify no other `bind g` exists by running:
```
grep -n '^bind g' tmux/.tmux.conf
```
Expected: exactly one line — the one you just added.

- [ ] **Step 2: Smoke test the script directly (no tmux required)**

```
./scripts/tmux-worktree-window.sh spawn /tmp/nonexistent foo 2>&1 || true
```
This will produce no visible output (since `tmux` isn't running, the `tmux display-message` calls will fail silently). That's fine — it confirms the script doesn't crash with `sh` errors.

Run the full test suite one more time:
```
bash scripts/tests/test-tmux-worktree-window.sh
```
Expected: all tests pass.

- [ ] **Step 3: Smoke test in a live tmux session (manual)**

In a real tmux session:
1. `cd` into any git repo.
2. Press `prefix + g`.
3. At the `branch:` prompt, type a new branch name like `wt-smoke-test` and Enter.
4. Expect: a new tmux window opens, named `wt-smoke-test`, with pwd `<repo>/.worktrees/wt-smoke-test`.
5. Verify: `git -C "$PWD" rev-parse --abbrev-ref HEAD` prints `wt-smoke-test`.
6. Close that window, `cd` somewhere that is NOT a git repo, press `prefix + g`. Expect: status line shows `not a git repo`.
7. Back in a repo, press `prefix + g`, hit Enter on an empty prompt. Expect: nothing happens, no error.
8. Clean up: from the main worktree, `git worktree remove .worktrees/wt-smoke-test && git branch -D wt-smoke-test`.

If any smoke step fails, debug and fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add tmux/.tmux.conf
git commit -m "Bind prefix+g to worktree-aware new-window helper"
```

---

## Self-review notes

- **Spec coverage:** keybinding (Task 7), prompt-for-branch flow (Task 6), sanitization (Task 2), worktree path (Task 5), branch resolution (Task 4), reuse-existing-path idempotency (Tasks 4 & 5), `not a git repo` error (Tasks 5 & 6), empty-input cancel (Task 5), invalid sanitized name (Task 5), git failures surfaced (Tasks 4 & 5), nested-worktree resolution (Task 3). All spec items covered.
- **Type/identifier consistency:** function names `sanitize_name`, `main_toplevel`, `ensure_worktree`, `cmd_prompt`, `cmd_spawn`, `sq_escape` used consistently across tasks. Test helpers `setup_test`, `teardown_test`, `assert_eq`, `assert_contains`, `assert_tmux_log_contains`, `source_script`, `make_repo`, `summary` defined in Tasks 1–3 and reused thereafter.
- **No placeholders.** Every step has complete code or exact commands.

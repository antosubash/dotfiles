# Ubuntu Setup Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scripts/setup-ubuntu.sh` a sectioned, re-runnable installer that reconciles an Ubuntu desktop to the repo. Fix the setup and update script bugs, close the tool gaps, add a keyboard power-user layer, and fix devbox1's rgb-off and boot problems.

**Architecture:**
- `scripts/lib/setup-common.sh` gains:
  - guards: `has_systemd`, `is_amd64`, `has_nvidia_gpu`, `needs_install`;
  - a section runner;
  - a rewritten `add_apt_source`;
  - new pins.
- A new `scripts/lib/installers.sh` holds the installers that desktop and server share.
- `setup-ubuntu.sh` becomes a list of `section_*` functions run by the runner.
- The new `scripts/setup-keyboard.sh` configures GNOME through `gsettings`.

**Tech Stack:** bash 5, apt/deb822, snap, gsettings/dconf, systemd, keyd, shellcheck, and the repo's bash test harness `scripts/tests/lib.sh`.

**Spec:** `docs/superpowers/specs/2026-10-16-ubuntu-setup-improvements-design.md`. Read it before starting any task.

## Global Constraints

- **No rc-file writes.** No Linux setup or update script may write to `~/.zshrc`, `~/.bashrc` or `~/.profile`. These are symlinks into the repo, so a write dirties tracked files. PATH comes from `shell/` files and `setup_path`.
- **Verified downloads.** Every downloaded binary, `.deb` or font has a pinned `*_VERSION`, `*_URL` and `*_SHA256` in `setup-common.sh`, and is installed through `download_verified`, `install_verified_binary` or `install_verified_deb`.
- **Vendor apt repos** go through `add_apt_source`, with the key fingerprint pinned in `setup-common.sh`. They are written as deb822 `.sources` under `/etc/apt/keyrings/<name>.gpg`.
- **Fingerprints:**

  | Variable | Value |
  |---|---|
  | `DOCKER_KEY_FINGERPRINT` | `9DC858229FC7DD38854AE2D88D81803C0EBFCD88` |
  | `GH_KEY_FINGERPRINT` | `2C6106201985B60E6C7AC87323F3D4EA75716059` |
  | `GOOGLE_KEY_FINGERPRINT` | `EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796` |
  | `CLAUDE_DESKTOP_KEY_FINGERPRINT` | `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE` |
  | `NVIDIA_CONTAINER_KEY_FINGERPRINT` | `C95B321B61E88C1809C4F759DDCAE044F796ECB0` |

- **.NET channels:** `7.0 8.0 9.0 10.0`. Only missing channels are installed.
- **NVIDIA:** anything NVIDIA-specific (the kernel guard and the container toolkit) runs only when `has_nvidia_gpu` is true.
- **Scripts:**
  - Use `#!/usr/bin/env bash`.
  - Library files are sourced, never executed.
  - shellcheck must pass with `-e SC1091 -e SC2155` at severity warning.
- **Commits:**
  - Format: `feat(setup): …`, `fix(update): …` and so on, one per task. Keep them small.
  - End every message with the line `Claude-Session: https://claude.ai/code/session_01HPoXhurXSdARhg9uNzYhTS`.
- **Tests** live in `scripts/tests/test-*.sh`. They use `scripts/tests/lib.sh` (`setup_test`, `teardown_test`, `assert_eq`, `assert_contains`, `assert_not_contains`, `summary`), run offline, and never call real `sudo`, `apt`, `gsettings` or `systemctl`. Fakes go in `$FAKE_BIN`, which `setup_test` creates and puts first on PATH.
- **Run tests with** `TMPDIR=/tmp/claude-1000/-home-anto-dotfiles/dac7ad38-6e40-4287-b6db-383129aa890d/scratchpad bash scripts/tests/<file>`.

## Review Focus

1. **`set -e` inside the runner's subshell is ignored if the subshell sits in an `&&`/`||` list.** A failing command mid-section must stop that section. → Task 1 test `test_failing_command_stops_its_section`.
2. **Running `setup-ubuntu.sh` twice** should install nothing the second time and print no errors. → Task 3 test `test_sections_are_idempotent_under_fakes` (sections with fake apt/dpkg report "Already installed").
3. **A vendor key file holding several keys, or a binary (non-armored) key,** must work with `add_apt_source`. Examples are Google's and GitHub CLI's key files. → Task 1 tests `test_add_apt_source_accepts_binary_and_multi_key_files`.
4. **A machine with no NVIDIA GPU, or with only a non-display NVIDIA device** (an audio function on a non-display PCI class), must skip every NVIDIA step. → Task 1 test `test_has_nvidia_gpu_*` and Task 3 test `test_nvidia_section_skips_without_gpu`.
5. **Re-running the keyboard setup** must not add duplicate custom shortcuts. → Task 6 test `test_custom_shortcut_is_not_duplicated`.

---

## File Structure

| File | Role |
|---|---|
| `scripts/lib/setup-common.sh` (modify) | Pins, fingerprints, download/verify primitives, guards, section runner, `add_apt_source`, `install_verified_deb` |
| `scripts/lib/installers.sh` (create) | Install functions shared by desktop and server: `apt_install_missing`, `snap_install_missing`, `ensure_user_in_group`, `install_docker`, `install_gh`, `install_rust`, `install_dotnet`, `install_pnpm`, `install_uv`, `install_pi`, `install_tpm`, `install_cli_extras`, `install_pinned_tools`, `install_fonts`, `configure_ufw`, `install_wireshark`, `install_nvidia_container_toolkit`, `install_desktop_apps` |
| `scripts/setup-ubuntu.sh` (rewrite) | `SECTIONS` array, `section_*` functions, `print_tool_versions`, `run_setup "$@"` |
| `scripts/setup-server.sh` (modify) | Uses `installers.sh`, has no rc-file writes, and its neovim download fails safely |
| `scripts/setup-keyboard.sh` (create) | GNOME keyboard layer |
| `config/keyd/default.conf` (create) | Caps Lock: tap = Esc, hold = Ctrl |
| `config/espanso/match/base.yml` (create) | Starter espanso matches |
| `docs/keyboard.md` (create) | Shortcut cheat sheet, with the old GNOME defaults for revert |
| `scripts/update-all.sh`, `scripts/update-quick.sh`, `scripts/setup-update.sh` (modify) | Update fixes |
| `shell/aliases.zsh`, `shell/constants.zsh`, `shell/completion.zsh`, `shell/.zshrc` (modify) | Shell gaps |
| `scripts/setup-rgb-off.sh`, `scripts/setup-dev-tuning.sh` (modify) | Fixes for this machine |
| `scripts/setup-terminal.sh`, `scripts/fix-fonts.sh` (modify) | Use `install_fonts` on Linux |
| `install.sh` (modify) | Link the espanso config |
| `.github/workflows/lint.yml`, `README.md` (modify) | CI job for the bash tests, docs |
| `scripts/tests/test-setup-runner.sh`, `test-setup-installers.sh`, `test-setup-ubuntu.sh`, `test-setup-keyboard.sh`, `test-no-rc-writes.sh`, `test-update-scripts.sh`, `test-shell-config.sh` (create); `test-setup-common.sh` (modify) | Tests |

Task order and parallelism:

- Task 1 comes first. Tasks 2, 6, 7 and 8 depend only on Task 1 and touch disjoint files, so they **may run in parallel after Task 1**.
- Task 3 needs Task 2.
- Task 4 needs Task 2.
- Task 5 needs Task 3.
- Task 9 comes last.
- **Hard tasks:** 1, 2, 3 and 6.

---

### Task 1 (hard): Library foundation in `setup-common.sh`

**Files:**
- Modify: `scripts/lib/setup-common.sh`
- Create: `scripts/tests/test-setup-runner.sh`
- Modify: `scripts/tests/test-setup-common.sh` (pin count, plus new tests)

**Interfaces:**
- **Produces:**
  - Guards:
    - `has_systemd` (honours `SYSTEMD_RUN_DIR`)
    - `is_amd64` (honours `SETUP_MACHINE`)
    - `has_nvidia_gpu` (honours `SYSFS_PCI_DEVICES`)
    - `needs_install CMD VERSION [ARGS...]`
  - Packages and sources:
    - `install_verified_deb URL SHA256`
    - `add_apt_source NAME KEY_URL FINGERPRINT URI SUITE [COMPONENTS]`. It returns 0 on success, and runs `apt update` only when something changed.
  - Section runner:
    - `skip_section REASON`
    - `parse_section_args ARGS...`, which sets the `SELECTED_SECTIONS` array and handles `--list`, `--only`, `--skip` and `-h`
    - `run_sections NAME...`, which fills `SECTION_RESULTS` and returns 1 if any section failed
    - `print_section_summary`
  - Run setup:
    - `setup_path`
    - `start_sudo_keepalive`
    - `setup_log NAME`
    - `run_setup ARGS...`
  - The new pins and fingerprints listed below.

- [ ] **Step 1: Write the failing runner tests.** Create `scripts/tests/test-setup-runner.sh`:

```bash
#!/usr/bin/env bash
# Tests for the section runner and guards in scripts/lib/setup-common.sh.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/lib/setup-common.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

load_lib() {
    # shellcheck disable=SC1090
    . "$SCRIPT"
    SECTIONS=(one two three)
    section_one() { echo "ran one" >> "$TMPDIR_ROOT/ran"; }
    section_two() { false; echo "after false" >> "$TMPDIR_ROOT/ran"; }
    section_three() { skip_section "not today"; }
}

test_list_prints_sections_in_order() {
    setup_test "--list prints sections"
    load_lib
    assert_eq "$(printf 'one\ntwo\nthree')" "$(parse_section_args --list)" "list output"
    teardown_test
}

test_only_and_skip_select_sections() {
    setup_test "--only / --skip"
    load_lib
    parse_section_args --only one,three
    assert_eq "one three" "${SELECTED_SECTIONS[*]}" "--only"
    parse_section_args --skip two
    assert_eq "one three" "${SELECTED_SECTIONS[*]}" "--skip"
    parse_section_args --only=two
    assert_eq "two" "${SELECTED_SECTIONS[*]}" "--only="
    teardown_test
}

test_unknown_section_is_an_error() {
    setup_test "unknown section"
    load_lib
    local out status
    out="$(parse_section_args --only nope 2>&1)"; status=$?
    assert_eq 2 "$status" "exit status"
    assert_contains "$out" "unknown section: nope" "message"
    teardown_test
}

test_failing_command_stops_its_section() {
    setup_test "failing command stops its section"
    load_lib
    set -e  # the runner must work whether or not the caller uses errexit
    run_sections one two three > "$TMPDIR_ROOT/out" 2>&1 && status=0 || status=$?
    set +e
    assert_eq 1 "$status" "run_sections status"
    assert_eq "ran one" "$(cat "$TMPDIR_ROOT/ran")" "two stopped at false"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "two" "summary lists two"
    assert_contains "${SECTION_RESULTS[*]}" "one|ok" "one ok"
    assert_contains "${SECTION_RESULTS[*]}" "two|failed" "two failed"
    assert_contains "${SECTION_RESULTS[*]}" "three|skipped" "three skipped"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "not today" "skip reason printed"
    teardown_test
}

test_has_nvidia_gpu_reads_sysfs() {
    setup_test "has_nvidia_gpu"
    load_lib
    local root="$TMPDIR_ROOT/pci"
    mkdir -p "$root/0000:00:02.0" "$root/0000:01:00.1"
    echo 0x8086 > "$root/0000:00:02.0/vendor"; echo 0x030000 > "$root/0000:00:02.0/class"
    echo 0x10de > "$root/0000:01:00.1/vendor"; echo 0x040300 > "$root/0000:01:00.1/class"
    SYSFS_PCI_DEVICES="$root" has_nvidia_gpu && r=yes || r=no
    assert_eq no "$r" "Intel GPU + NVIDIA audio function only"
    mkdir -p "$root/0000:01:00.0"
    echo 0x10de > "$root/0000:01:00.0/vendor"; echo 0x030000 > "$root/0000:01:00.0/class"
    SYSFS_PCI_DEVICES="$root" has_nvidia_gpu && r=yes || r=no
    assert_eq yes "$r" "NVIDIA VGA"
    SYSFS_PCI_DEVICES="$TMPDIR_ROOT/empty" has_nvidia_gpu && r=yes || r=no
    assert_eq no "$r" "no PCI tree"
    teardown_test
}

test_needs_install() {
    setup_test "needs_install"
    load_lib
    printf '#!/bin/sh\necho "tool version 1.2.3"\n' > "$FAKE_BIN/tool"; chmod +x "$FAKE_BIN/tool"
    needs_install tool 1.2.3 && r=yes || r=no; assert_eq no "$r" "pinned version installed"
    needs_install tool 1.2.4 && r=yes || r=no; assert_eq yes "$r" "other version installed"
    needs_install no-such-tool 1.0 && r=yes || r=no; assert_eq yes "$r" "missing"
    printf '#!/bin/sh\n[ "$1" = version ] && echo "go1.27.2"\n' > "$FAKE_BIN/gofake"; chmod +x "$FAKE_BIN/gofake"
    needs_install gofake 1.27.2 version && r=yes || r=no; assert_eq no "$r" "custom version args"
    teardown_test
}

test_guards_honour_overrides() {
    setup_test "has_systemd / is_amd64"
    load_lib
    SYSTEMD_RUN_DIR="$TMPDIR_ROOT/nope" has_systemd && r=yes || r=no; assert_eq no "$r" "no systemd dir"
    mkdir -p "$TMPDIR_ROOT/sd"
    SYSTEMD_RUN_DIR="$TMPDIR_ROOT/sd" has_systemd && r=yes || r=no; assert_eq yes "$r" "systemd dir"
    SETUP_MACHINE=aarch64 is_amd64 && r=yes || r=no; assert_eq no "$r" "aarch64"
    SETUP_MACHINE=x86_64 is_amd64 && r=yes || r=no; assert_eq yes "$r" "x86_64"
    teardown_test
}

test_list_prints_sections_in_order
test_only_and_skip_select_sections
test_unknown_section_is_an_error
test_failing_command_stops_its_section
test_has_nvidia_gpu_reads_sysfs
test_needs_install
test_guards_honour_overrides
summary
```

- [ ] **Step 2: Add the `add_apt_source` tests** to `scripts/tests/test-setup-common.sh`, next to its existing tests. Reuse its `setup_fakes`, where the fake `curl` serves `$FIXTURES/<basename>` and the fake `sudo` logs to `$CALLS` and runs the command. Add fakes for `apt`, `dpkg` and `tee`/`install` targets: redirect the paths with the env vars `APT_SOURCES_DIR` and `APT_KEYRINGS_DIR`, which `add_apt_source` must honour (defaults `/etc/apt/sources.list.d` and `/etc/apt/keyrings`).

```bash
make_key() {  # make_key NAME -> armored public key in $FIXTURES/NAME.asc, prints fingerprint
    local home="$TMPDIR_ROOT/gnupg-$1"; mkdir -p "$home"; chmod 700 "$home"
    GNUPGHOME="$home" gpg --batch --quiet --passphrase '' --quick-gen-key "$1 <$1@test>" ed25519 sign never
    GNUPGHOME="$home" gpg --batch --armor --export > "$FIXTURES/$1.asc"
    GNUPGHOME="$home" gpg --batch --export > "$FIXTURES/$1.gpg"
    GNUPGHOME="$home" gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}'
    gpgconf --homedir "$home" --kill all 2>/dev/null
}

test_add_apt_source_accepts_binary_and_multi_key_files() {
    setup_test "add_apt_source key formats"
    setup_fakes
    export APT_SOURCES_DIR="$TMPDIR_ROOT/sources" APT_KEYRINGS_DIR="$TMPDIR_ROOT/keyrings"
    mkdir -p "$APT_SOURCES_DIR" "$APT_KEYRINGS_DIR"
    printf '#!/bin/sh\necho "apt $*" >> "%s"\n' "$CALLS" > "$FAKE_BIN/apt"; chmod +x "$FAKE_BIN/apt"
    printf '#!/bin/sh\necho amd64\n' > "$FAKE_BIN/dpkg"; chmod +x "$FAKE_BIN/dpkg"
    local a b
    a="$(make_key alpha)"; b="$(make_key beta)"
    cat "$FIXTURES/alpha.asc" "$FIXTURES/beta.asc" > "$FIXTURES/multi.asc"
    add_apt_source multi https://x.test/multi.asc "$b" https://repo.test/deb stable main; assert_eq 0 $? "second key of a multi-key file"
    add_apt_source bin https://x.test/alpha.gpg "$a" https://repo.test/deb stable main; assert_eq 0 $? "binary key"
    add_apt_source flat https://x.test/alpha.asc "$a" https://repo.test/deb/amd64 / ""; assert_eq 0 $? "flat repo"
    assert_not_contains "$(cat "$APT_SOURCES_DIR/flat.sources")" "Components:" "flat repo has no Components"
    assert_contains "$(cat "$APT_SOURCES_DIR/flat.sources")" "Suites: /" "flat suite"
    add_apt_source bad https://x.test/alpha.asc "$b" https://repo.test/deb stable main 2>/dev/null; assert_eq 1 $? "wrong fingerprint rejected"
    teardown_test
}

test_add_apt_source_is_quiet_when_unchanged() {
    setup_test "add_apt_source idempotent"
    setup_fakes
    export APT_SOURCES_DIR="$TMPDIR_ROOT/sources" APT_KEYRINGS_DIR="$TMPDIR_ROOT/keyrings"
    mkdir -p "$APT_SOURCES_DIR" "$APT_KEYRINGS_DIR"
    printf '#!/bin/sh\necho "apt $*" >> "%s"\n' "$CALLS" > "$FAKE_BIN/apt"; chmod +x "$FAKE_BIN/apt"
    printf '#!/bin/sh\necho amd64\n' > "$FAKE_BIN/dpkg"; chmod +x "$FAKE_BIN/dpkg"
    local a; a="$(make_key alpha)"
    echo "deb [signed-by=/x] https://repo.test/deb stable main" > "$APT_SOURCES_DIR/vend.list"
    add_apt_source vend https://x.test/alpha.asc "$a" https://repo.test/deb stable main
    assert_eq 1 "$(grep -c '^apt update' "$CALLS")" "first run updates"
    assert_eq no "$([ -e "$APT_SOURCES_DIR/vend.list" ] && echo yes || echo no)" "legacy .list removed"
    add_apt_source vend https://x.test/alpha.asc "$a" https://repo.test/deb stable main
    assert_eq 1 "$(grep -c '^apt update' "$CALLS")" "second run does not update"
    teardown_test
}
```

  Also change `assert_eq 8 "$count"` to `assert_eq 16 "$count"`. The new `_URL` pins are ULAUNCHER, ESPANSO, NERDFONT_JETBRAINSMONO, NERDFONT_FIRACODE, MESLO_REGULAR, MESLO_BOLD, MESLO_ITALIC and MESLO_BOLD_ITALIC. Call the two new tests at the bottom, before `summary`.

- [ ] **Step 3: Run both test files to confirm they fail.** Use `bash scripts/tests/test-setup-runner.sh` and `bash scripts/tests/test-setup-common.sh` (with TMPDIR set as in Global Constraints). Expected: FAIL, with `parse_section_args: command not found` and the pin count at 8.

- [ ] **Step 4: Implement in `scripts/lib/setup-common.sh`.**

  Add the pins after the DuckDB block:

```bash
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
```

  `MESLO_BASE` does not end in `_URL`, so `pin_names` doesn't count it.

  Add the fingerprints next to the existing ones:

```bash
DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
GH_KEY_FINGERPRINT="2C6106201985B60E6C7AC87323F3D4EA75716059"
GOOGLE_KEY_FINGERPRINT="EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"
CLAUDE_DESKTOP_KEY_FINGERPRINT="31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"
NVIDIA_CONTAINER_KEY_FINGERPRINT="C95B321B61E88C1809C4F759DDCAE044F796ECB0"
```

  Replace `add_apt_source` with the version below. It is the same contract plus:

  - It checks that the fingerprint is a primary key **anywhere** in the file, armored or binary.
  - It supports flat repos.
  - It writes the `.sources` file before removing the legacy `.list` one.
  - It runs `apt update` only when something changed.
  - The path roots can be overridden for tests.

```bash
# add_apt_source NAME KEY_URL KEY_FINGERPRINT URI SUITE [COMPONENTS]
# Adds a vendor apt repository signed by the key with KEY_FINGERPRINT, which
# must be a primary key in the file at KEY_URL (armored or binary; vendors
# such as Google and GitHub ship several keys in one file). Writes the key as
# $APT_KEYRINGS_DIR/NAME.gpg and the source as $APT_SOURCES_DIR/NAME.sources;
# SUITE "/" with empty COMPONENTS writes a flat repository. A NAME.list left by
# the vendor's own instructions is removed once the .sources file is in place.
# Runs `apt update` only when the key or source changed.
add_apt_source() {
    local name="$1" key_url="$2" fingerprint="$3" uri="$4" suite="$5" components="${6:-}"
    local keyrings="${APT_KEYRINGS_DIR:-/etc/apt/keyrings}" sources="${APT_SOURCES_DIR:-/etc/apt/sources.list.d}"
    local keyring="$keyrings/$name.gpg" tmp status=0 changed=0
    tmp="$(mktemp -d)"
    if ! curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/key" "$key_url"; then
        echo "ERROR: could not download the $name signing key from $key_url." >&2
        status=1
    elif ! gpg --batch --show-keys --with-colons "$tmp/key" 2>/dev/null \
            | awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 }' \
            | grep -qx "$fingerprint"; then
        echo "ERROR: $key_url has no $name signing key with fingerprint $fingerprint." >&2
        status=1
    elif grep -q -- '-----BEGIN PGP' "$tmp/key"; then
        gpg --batch --dearmor -o "$tmp/key.gpg" "$tmp/key" || status=1
    else
        cp "$tmp/key" "$tmp/key.gpg"
    fi
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
    if [ -e "$sources/$name.list" ]; then
        sudo rm -f "$sources/$name.list"
        changed=1
    fi
    [ "$changed" -eq 0 ] || sudo apt update
}
```

  Note on the test fakes: `sudo install -o root -g root` fails as non-root. In the test's fake `sudo`, strip `-o root -g root` before running. Add this line to the fake sudo in `setup_fakes`: `set -- $(printf '%s\n' "$@" | sed '/^-o$/{N;d};/^-g$/{N;d}')`. Or simply: when `$1 = install`, run `install -D -m 0644 "${@: -2}"`. Pick whichever keeps the existing tests green.

  Add `install_verified_deb`:

```bash
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
```

  Add the guards and the runner at the end of the file:

```bash
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

SKIP_STATUS=3
SECTION_RESULTS=()
SELECTED_SECTIONS=()

# skip_section REASON: ends the current section as skipped.
skip_section() {
    echo "Skipping: $*"
    exit "$SKIP_STATUS"
}

section_usage() {
    echo "Usage: $(basename "$0") [--list] [--only a,b] [--skip a,b]"
    echo "Sections: ${SECTIONS[*]}"
}

_in_csv() { [[ ",$2," == *",$1,"* ]]; }

parse_section_args() {
    local only="" skip="" name s
    while [ $# -gt 0 ]; do
        case "$1" in
            --list) printf '%s\n' "${SECTIONS[@]}"; exit 0 ;;
            --only) only="${2:-}"; shift ;;
            --only=*) only="${1#*=}" ;;
            --skip) skip="${2:-}"; shift ;;
            --skip=*) skip="${1#*=}" ;;
            -h|--help) section_usage; exit 0 ;;
            *) echo "ERROR: unknown option: $1" >&2; section_usage >&2; exit 2 ;;
        esac
        shift
    done
    for name in ${only//,/ } ${skip//,/ }; do
        _in_csv "$name" "$(IFS=,; echo "${SECTIONS[*]}")" || {
            echo "ERROR: unknown section: $name" >&2; section_usage >&2; exit 2; }
    done
    SELECTED_SECTIONS=()
    for s in "${SECTIONS[@]}"; do
        if [ -n "$only" ] && ! _in_csv "$s" "$only"; then continue; fi
        _in_csv "$s" "$skip" && continue
        SELECTED_SECTIONS+=("$s")
    done
}

run_sections() {
    local s start status failed=0 errexit=0
    [[ $- == *e* ]] && errexit=1
    set +e  # a subshell in an && / || list would silently ignore its own set -e
    for s in "$@"; do
        echo ""
        echo "==> $s"
        start=$SECONDS
        ( set -euo pipefail; "section_${s//-/_}" )
        status=$?
        case "$status" in
            0) SECTION_RESULTS+=("$s|ok|$((SECONDS - start))s") ;;
            "$SKIP_STATUS") SECTION_RESULTS+=("$s|skipped|$((SECONDS - start))s") ;;
            *) SECTION_RESULTS+=("$s|failed ($status)|$((SECONDS - start))s"); failed=1 ;;
        esac
    done
    [ "$errexit" -eq 0 ] || set -e
    print_section_summary
    return "$failed"
}

print_section_summary() {
    local row
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
    mkdir -p "$dir"
    SETUP_LOG_FILE="$dir/$1-$(date +%Y%m%d-%H%M%S).log"
    exec > >(tee -a "$SETUP_LOG_FILE") 2>&1
    echo "Logging to $SETUP_LOG_FILE"
}

# run_setup ARGS...: parse args, check the host, then run the chosen sections.
run_setup() {
    parse_section_args "$@"
    if [ ! -r /etc/os-release ] || ! grep -qE '^ID(_LIKE)?=.*(debian|ubuntu)' /etc/os-release; then
        echo "ERROR: this script targets Debian/Ubuntu hosts." >&2
        exit 1
    fi
    setup_log "$(basename "$0" .sh)"
    start_sudo_keepalive
    setup_path
    run_sections "${SELECTED_SECTIONS[@]}"
}
```

- [ ] **Step 5: Run both test files and shellcheck.** Commands: `bash scripts/tests/test-setup-runner.sh`, `bash scripts/tests/test-setup-common.sh`, and `shellcheck -S warning -e SC1091 -e SC2155 scripts/lib/setup-common.sh`. If shellcheck is missing, install it with `pip install --user shellcheck-py`, or use `uvx shellcheck-py` / `uv tool run --from shellcheck-py shellcheck`. Expected: all PASS, shellcheck clean.

- [ ] **Step 6: Make sure the existing callers still work.**
  - `install_nodejs` and `install_tailscale` call `add_apt_source … nodistro main`, which is unchanged.
  - `install_nodejs` must now `sudo apt install -y nodejs` even when `add_apt_source` didn't run apt update. That is fine, because nothing changed.
  - Check `grep -rn add_apt_source scripts/`.

- [ ] **Step 7: Commit.** Message: `feat(setup): add section runner, environment guards and a stricter add_apt_source`.

---

### Task 2 (hard): Shared installers `scripts/lib/installers.sh`

**Files:**
- Create: `scripts/lib/installers.sh`
- Create: `scripts/tests/test-setup-installers.sh`

**Interfaces:**
- **Consumes:** everything from Task 1.
- **Produces:** the functions below. All are idempotent and return non-zero on failure.

| Function | Behaviour |
|---|---|
| `apt_install_missing PKG...` | Installs only packages that are not `install ok installed`, using `DEBIAN_FRONTEND=noninteractive` |
| `snap_install_missing SNAP...` | |
| `ensure_user_in_group GROUP` | User is `${SUDO_USER:-$USER}`. No-op when the group doesn't exist. |
| `install_docker` | Docker CE repo and packages, docker group, enabled service when `has_systemd`. Debian/Ubuntu aware. |
| `install_gh` | |
| `install_rust` | rustup with `--no-modify-path`, only when `rustup` is missing |
| `install_dotnet CHANNEL...` | Only missing channels, installer in a mktemp dir |
| `install_pnpm` | Restores the rc symlinks afterwards (moved from setup-ubuntu.sh) |
| `install_uv` | `UV_NO_MODIFY_PATH=1`, installs to `~/.local/bin` |
| `install_pi` | Pinned, `~/.local` prefix, checked with `needs_install "$HOME/.local/bin/pi" "$PI_CODING_AGENT_VERSION"` |
| `install_tpm` | |
| `install_cli_extras` | apt eza, bat, zoxide, atuin, plus `~/.local/bin/bat` → `batcat` |
| `install_pinned_go`, `install_pinned_yq`, `install_pinned_git_tools`, `install_pinned_k8s`, `install_pinned_tools` (all four) | Pinned binaries through `needs_install`. Each skips with a message (containing "x86_64") when not `is_amd64`. |
| `install_fonts` | Nerd Fonts plus MesloLGS from the pins, then `fc-cache` only when something was installed |
| `configure_ufw` | |
| `install_wireshark` | |
| `install_nvidia_container_toolkit` | No-op unless `has_nvidia_gpu` |
| `install_desktop_apps` | Brave snap, Google Chrome, Claude Desktop |

- [ ] **Step 1: Write the failing tests.** Create `scripts/tests/test-setup-installers.sh`. Use fakes for `sudo` (logs and runs the rest), `apt-get`/`apt` (log), `dpkg-query` (reads installed packages from `$TMPDIR_ROOT/installed`), `snap` (`list NAME` succeeds when NAME is in `$TMPDIR_ROOT/snaps`, `install` logs), `getent`, `id` and `usermod` (log).

```bash
#!/usr/bin/env bash
# Tests for scripts/lib/installers.sh with fake package managers.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/lib/installers.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

fake() {  # fake NAME BODY
    printf '#!/usr/bin/env bash\n%s\n' "$2" > "$FAKE_BIN/$1"; chmod +x "$FAKE_BIN/$1"
}

setup_fakes() {
    export CALLS="$TMPDIR_ROOT/calls" INSTALLED="$TMPDIR_ROOT/installed"
    : > "$CALLS"; : > "$INSTALLED"
    fake sudo 'echo "sudo $*" >> "$CALLS"; while [[ "$1" == *=* ]]; do export "$1"; shift; done; "$@"'
    fake apt-get 'echo "apt-get $*" >> "$CALLS"'
    fake apt 'echo "apt $*" >> "$CALLS"'
    fake dpkg-query 'grep -qx "${@: -1}" "$INSTALLED" && printf "install ok installed" || exit 1'
    fake snap '[ "$1" = list ] && { grep -qx "$2" "$TMPDIR_ROOT/snaps" 2>/dev/null; exit; }; echo "snap $*" >> "$CALLS"'
    fake usermod 'echo "usermod $*" >> "$CALLS"'
    : > "$TMPDIR_ROOT/snaps"
    # shellcheck disable=SC1090
    . "$(dirname "$SCRIPT")/setup-common.sh"; . "$SCRIPT"
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
    teardown_test
}

test_snap_install_missing() {
    setup_test "snap_install_missing"
    setup_fakes
    echo slack > "$TMPDIR_ROOT/snaps"
    snap_install_missing slack brave
    assert_not_contains "$(cat "$CALLS")" "snap install slack" "slack present"
    assert_contains "$(cat "$CALLS")" "snap install brave" "brave installed"
    teardown_test
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
    teardown_test
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
    teardown_test
}

test_nvidia_toolkit_skips_without_gpu() {
    setup_test "nvidia toolkit needs a GPU"
    setup_fakes
    SYSFS_PCI_DEVICES="$TMPDIR_ROOT/none" install_nvidia_container_toolkit > "$TMPDIR_ROOT/out"
    assert_eq 0 $? "returns 0"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "No NVIDIA GPU" "message"
    assert_eq "" "$(cat "$CALLS")" "no package calls"
    teardown_test
}

test_pinned_tools_skip_on_non_amd64() {
    setup_test "pinned tools on aarch64"
    setup_fakes
    SETUP_MACHINE=aarch64 install_pinned_tools > "$TMPDIR_ROOT/out"
    assert_eq 0 $? "returns 0"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "x86_64" "explains the skip"
    teardown_test
}

test_apt_install_missing_installs_only_missing
test_snap_install_missing
test_ensure_user_in_group
test_install_dotnet_only_missing_channels
test_nvidia_toolkit_skips_without_gpu
test_pinned_tools_skip_on_non_amd64
summary
```

- [ ] **Step 2: Run it.** `bash scripts/tests/test-setup-installers.sh` should FAIL (the file is missing).

- [ ] **Step 3: Implement `scripts/lib/installers.sh`.** Header comment: "Install steps shared by setup-ubuntu.sh and setup-server.sh. Source after setup-common.sh; it runs nothing on its own. Nothing here edits shell rc files: the dotfiles' shell/ files and setup_path already put every install directory on PATH."

  Implement each function:

```bash
apt_install_missing() {
    local pkg missing=()
    for pkg in "$@"; do
        [ "$(dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null)" = "install ok installed" ] || missing+=("$pkg")
    done
    if [ ${#missing[@]} -eq 0 ]; then
        echo "Already installed: $*"
        return 0
    fi
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

snap_install_missing() {
    local s
    for s in "$@"; do
        if snap list "$s" > /dev/null 2>&1; then echo "$s (snap) is already installed."; else sudo snap install "$s"; fi
    done
}

ensure_user_in_group() {
    local group="$1" user="${SUDO_USER:-$USER}"
    getent group "$group" > /dev/null || return 0
    id -nG "$user" | tr ' ' '\n' | grep -qx "$group" && return 0
    sudo usermod -aG "$group" "$user"
    echo "Added $user to the $group group; log out and back in for it to apply."
}

_os_codename() { (. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}"); }
_os_family() { (. /etc/os-release && if [ "$ID" = debian ]; then echo debian; else echo ubuntu; fi); }

install_docker() {
    local family; family="$(_os_family)"
    add_apt_source docker "https://download.docker.com/linux/$family/gpg" "$DOCKER_KEY_FINGERPRINT" \
        "https://download.docker.com/linux/$family" "$(_os_codename)" stable || return 1
    apt_install_missing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
    ensure_user_in_group docker
    if has_systemd; then sudo systemctl enable --now docker; fi
}

install_gh() {
    add_apt_source github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        "$GH_KEY_FINGERPRINT" https://cli.github.com/packages stable main || return 1
    apt_install_missing gh
}

install_rust() {
    command -v rustup > /dev/null 2>&1 && { echo "rustup is already installed."; return 0; }
    local tmp status=0; tmp="$(mktemp -d)"
    # --no-modify-path: the dotfiles rc files already source ~/.cargo/env.
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/rustup.sh" https://sh.rustup.rs \
        && sh "$tmp/rustup.sh" -y --no-modify-path || status=1
    rm -rf "$tmp"; return "$status"
}

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

install_uv() {
    command -v uv > /dev/null 2>&1 && { echo "uv is already installed."; return 0; }
    local tmp status=0; tmp="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/uv.sh" https://astral.sh/uv/install.sh \
        && env UV_NO_MODIFY_PATH=1 sh "$tmp/uv.sh" || status=1
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
    apt_install_missing eza bat zoxide atuin || return 1
    # Ubuntu ships bat as `batcat`; the shell config calls `bat`.
    if ! command -v bat > /dev/null 2>&1 && command -v batcat > /dev/null 2>&1; then
        mkdir -p "$HOME/.local/bin"; ln -sf "$(command -v batcat)" "$HOME/.local/bin/bat"
    fi
}

# Pinned x86_64 binaries, grouped by the setup-ubuntu.sh section that installs them.
_pinned_ok() { is_amd64 || { echo "Skipping pinned $1: the pinned builds are x86_64 only."; return 1; }; }

install_pinned_go() {
    _pinned_ok Go || return 0
    needs_install go "$GO_VERSION" version || return 0
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
```

  **Note:** `go` must be checked against `/usr/local/go/bin/go`, which `setup_path` puts on PATH. Check that each tool's real version output contains the bare pin by running them on this machine:

  - `go version`
  - `yq --version`
  - `lazygit --version`
  - `lazydocker --version`
  - `kubectl version --client`
  - `helm version`

  Adjust the args if one doesn't contain it.

  Also implement the following.

  **`install_pnpm`.** Move the block at `scripts/setup-ubuntu.sh:240-276` (the `rc_links` save/restore around `curl https://get.pnpm.io/install.sh | sh -`) into a function. Drop the trailing `grep … >> ~/.zshrc` lines, and download the installer to a temp file first. When `pnpm` already exists, it returns 0.

  **`configure_ufw`:**

```bash
configure_ufw() {
    has_systemd || { echo "No systemd; leaving the firewall alone."; return 0; }
    apt_install_missing ufw || return 1
    sudo ufw allow OpenSSH > /dev/null
    if sudo ufw status | grep -q '^Status: active'; then
        echo "UFW is already active; its rules are left as they are."
        return 0
    fi
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow in on tailscale0
    sudo ufw --force enable
}
```

  **`install_wireshark`:**

```bash
install_wireshark() {
    # Answer the "non-root capture" debconf question up front so apt never stops to ask.
    echo 'wireshark-common wireshark-common/install-setuid boolean true' | sudo debconf-set-selections
    apt_install_missing wireshark || return 1
    ensure_user_in_group wireshark
}
```

  **`install_nvidia_container_toolkit`:**

```bash
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
```

  **`install_desktop_apps`:**

```bash
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
```

  **Verify the Google and Claude key URLs** really contain the pinned fingerprints as primary keys:

```bash
curl -fsSL URL | gpg --show-keys --with-colons | awk -F: '$1=="pub"{w=1;next} $1=="fpr"&&w{print $10;w=0}'
```

  If Google's primary key differs, use the one that signs the current `Release` file (`gpg --verify` of `InRelease`) and update the pin.

  **`install_fonts`** (Linux):

```bash
install_fonts() {
    local dir="$HOME/.local/share/fonts" tmp name url sha new=0 file
    mkdir -p "$dir"
    apt_install_missing unzip fontconfig || return 1
    # Older setups unpacked Nerd Fonts into a NerdFonts/ subdirectory.
    if [ -d "$dir/NerdFonts" ]; then
        find "$dir/NerdFonts" -type f \( -name '*.ttf' -o -name '*.otf' \) -exec mv -t "$dir" {} +
        rmdir "$dir/NerdFonts" 2>/dev/null || true
    fi
    for name in JETBRAINSMONO FIRACODE; do
        local pattern; [ "$name" = JETBRAINSMONO ] && pattern='*JetBrainsMono*NerdFont*' || pattern='*FiraCode*NerdFont*'
        if find "$dir" -maxdepth 1 -type f -name "$pattern" | grep -q .; then continue; fi
        url="NERDFONT_${name}_URL"; sha="NERDFONT_${name}_SHA256"
        tmp="$(mktemp -d)"
        download_verified "${!url}" "${!sha}" "$tmp/font.zip" \
            && unzip -q -o "$tmp/font.zip" -d "$tmp/x" \
            && find "$tmp/x" -type f \( -name '*.ttf' -o -name '*.otf' \) -exec mv -t "$dir" {} + \
            && new=1
        rm -rf "$tmp"
    done
    for name in REGULAR BOLD ITALIC BOLD_ITALIC; do
        url="MESLO_${name}_URL"; sha="MESLO_${name}_SHA256"
        file="$dir/$(basename "${!url}" | sed 's/%20/ /g')"
        [ -f "$file" ] && continue
        download_verified "${!url}" "${!sha}" "$file" && new=1
    done
    if [ "$new" -eq 1 ]; then fc-cache -f "$dir"; fi
}
```

- [ ] **Step 4: Run the tests and shellcheck.** Commands: `bash scripts/tests/test-setup-installers.sh`, `bash scripts/tests/test-setup-common.sh`, and `shellcheck -S warning -e SC1091 -e SC2155 scripts/lib/installers.sh`. Expected: all PASS.

- [ ] **Step 5: Commit.** Message: `feat(setup): share desktop and server installers in scripts/lib/installers.sh`.

---

### Task 3 (hard): Rewrite `scripts/setup-ubuntu.sh` as sections

**Files:**
- Rewrite: `scripts/setup-ubuntu.sh`
- Create: `scripts/tests/test-setup-ubuntu.sh`
- Create: `scripts/tests/test-no-rc-writes.sh`

**Interfaces:**
- **Consumes:** Tasks 1 and 2, plus `scripts/setup-keyboard.sh` from Task 6. The `keyboard` section runs `bash "$HERE/setup-keyboard.sh"`. If Task 6 hasn't landed yet, the section calls `skip_section "setup-keyboard.sh not present"` when the file is missing.
- **Produces:** the CLI `setup-ubuntu.sh [--list] [--only a,b] [--skip a,b]`. With `SETUP_UBUNTU_SOURCE_ONLY=1`, sourcing the script defines everything without running. Section names are exactly: `base editor languages dotnet cli security ssh-firewall vpn shell git-tools docker node python k8s db-gis ollama apps keyboard fonts nvidia apt-hygiene`.

- [ ] **Step 1: Write the failing tests.**

  Create `scripts/tests/test-setup-ubuntu.sh`:

```bash
#!/usr/bin/env bash
# Tests for scripts/setup-ubuntu.sh's section layout (no real installs).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/setup-ubuntu.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

EXPECTED="base editor languages dotnet cli security ssh-firewall vpn shell git-tools docker node python k8s db-gis ollama apps keyboard fonts nvidia apt-hygiene"

test_list_names_every_section() {
    setup_test "--list"
    assert_eq "$EXPECTED" "$(bash "$SCRIPT" --list | tr '\n' ' ' | sed 's/ $//')" "sections"
    teardown_test
}

test_every_section_has_a_function() {
    setup_test "section functions exist"
    # shellcheck disable=SC1090
    SETUP_UBUNTU_SOURCE_ONLY=1 . "$SCRIPT"
    local s
    for s in $EXPECTED; do
        assert_eq function "$(type -t "section_${s//-/_}")" "section_$s"
    done
    teardown_test
}

test_unknown_option_fails() {
    setup_test "unknown section"
    bash "$SCRIPT" --only nope > /dev/null 2>&1
    assert_eq 2 $? "exit status"
    teardown_test
}

test_nvidia_section_skips_without_gpu() {
    setup_test "nvidia section without GPU"
    # shellcheck disable=SC1090
    SETUP_UBUNTU_SOURCE_ONLY=1 . "$SCRIPT"
    SYSFS_PCI_DEVICES="$TMPDIR_ROOT/none" run_sections nvidia > "$TMPDIR_ROOT/out" 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "nvidia|skipped" "skipped"
    assert_contains "$(cat "$TMPDIR_ROOT/out")" "No NVIDIA GPU" "reason"
    teardown_test
}

test_sections_are_idempotent_under_fakes() {
    setup_test "cli section with everything installed"
    # Everything reports installed and at its pin, so the section must make no install calls.
    export CALLS="$TMPDIR_ROOT/calls"; : > "$CALLS"
    printf '#!/bin/sh\necho "sudo $*" >> "%s"\n' "$CALLS" > "$FAKE_BIN/sudo"
    printf '#!/bin/sh\nprintf "install ok installed"\n' > "$FAKE_BIN/dpkg-query"
    for t in yq curlie bat; do printf '#!/bin/sh\necho "%s version 4.54.1"\n' "$t" > "$FAKE_BIN/$t"; done
    chmod +x "$FAKE_BIN"/*
    # shellcheck disable=SC1090
    SETUP_UBUNTU_SOURCE_ONLY=1 . "$SCRIPT"
    SETUP_MACHINE=x86_64 run_sections cli > /dev/null 2>&1
    assert_contains "${SECTION_RESULTS[*]}" "cli|ok" "cli ok"
    assert_not_contains "$(cat "$CALLS")" "install" "no install calls"
    teardown_test
}

test_list_names_every_section
test_every_section_has_a_function
test_unknown_option_fails
test_nvidia_section_skips_without_gpu
test_sections_are_idempotent_under_fakes
summary
```

  Create `scripts/tests/test-no-rc-writes.sh` as a contract test over the Linux setup and update scripts:

```bash
#!/usr/bin/env bash
# Contract: no Linux setup/update script writes to the shell rc files, which
# install.sh symlinks into this repo (a write would dirty tracked files).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "$HERE/.." && pwd)"
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
```

- [ ] **Step 2: Run both.** Expected: FAIL. `--list` doesn't exist yet, and the rc test finds the current `>> ~/.zshrc` lines.

- [ ] **Step 3: Rewrite `scripts/setup-ubuntu.sh`.** Keep every install it does today, plus the design's additions. Skeleton:

```bash
#!/usr/bin/env bash
# Sets up an Ubuntu desktop for development. Safe to re-run: each section
# installs only what's missing or below its pinned version, and a failing
# section doesn't stop the others. `--list` shows the sections; `--only a,b`
# and `--skip a,b` choose them. A log is kept in ~/.local/state/dotfiles/.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/setup-common.sh
. "$HERE/lib/setup-common.sh"
# shellcheck source=lib/installers.sh
. "$HERE/lib/installers.sh"

SECTIONS=(base editor languages dotnet cli security ssh-firewall vpn shell git-tools
    docker node python k8s db-gis ollama apps keyboard fonts nvidia apt-hygiene)

section_base() {
    sudo apt update
    apt_install_missing curl wget git htop btop fastfetch vim nano build-essential cmake \
        net-tools openssl unzip bc sqlite3 shellcheck ffmpeg python-is-python3 ca-certificates gnupg
}
section_editor() { apt_install_missing neovim; }
section_languages() {
    apt_install_missing python3 python3-full default-jdk
    install_pinned_go
    install_rust
}
section_dotnet() { install_dotnet 7.0 8.0 9.0 10.0; }
section_cli() {
    apt_install_missing httpie jq
    install_pinned_yq
    install_cli_extras
    if ! command -v curlie > /dev/null 2>&1; then go install github.com/rs/curlie@v1.6.0; fi
}
section_security() { apt_install_missing gnupg pass nmap; install_wireshark; }
section_ssh_firewall() {
    has_systemd || skip_section "no systemd"
    apt_install_missing openssh-server
    sudo systemctl enable --now ssh
    harden_sshd || echo "WARNING: SSH hardening was not applied; see the error above."
    configure_ufw
}
section_vpn() {
    command -v tailscale > /dev/null 2>&1 || install_tailscale
    apt_install_missing wireguard wireguard-tools
}
section_shell() {
    apt_install_missing tmux fzf ripgrep fd-find zsh
    if ! command -v fd > /dev/null 2>&1; then mkdir -p "$HOME/.local/bin"; ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd"; fi
    local zsh_path; zsh_path="$(command -v zsh)"
    [ "$(getent passwd "$USER" | cut -d: -f7)" = "$zsh_path" ] || sudo chsh -s "$zsh_path" "$USER"
    bash "$HERE/setup-oh-my-zsh.sh"
    install_tpm
}
section_git_tools() { install_gh; install_pinned_git_tools; }
section_docker() { install_docker; install_nvidia_container_toolkit; }
section_node() {
    command -v node > /dev/null 2>&1 || install_nodejs
    install_pnpm
    install_pi
}
section_python() { apt_install_missing python3-pip python3-venv; install_uv; }
section_k8s() { install_pinned_k8s; }
section_db_gis() {
    apt_install_missing postgresql-client gdal-bin libgdal-dev python3-gdal proj-bin libproj-dev \
        libgeos-dev spatialite-bin libspatialite-dev
}
section_ollama() {
    command -v ollama > /dev/null 2>&1 && { echo "Ollama is already installed."; return 0; }
    # Ollama has no apt repository; run the vendor installer from a file, not a pipe.
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/install.sh" https://ollama.com/install.sh && sh "$tmp/install.sh"
    local status=$?; rm -rf "$tmp"; return "$status"
}
section_apps() {
    apt_install_missing vlc thunderbird
    if apt-cache show gnome-browser-connector > /dev/null 2>&1; then
        apt_install_missing gnome-browser-connector
    else
        apt_install_missing chrome-gnome-shell
    fi
    has_systemd || skip_section "no systemd (snaps unavailable)"
    snap_install_missing slack discord zoom-client
    install_desktop_apps
}
section_keyboard() {
    [ -f "$HERE/setup-keyboard.sh" ] || skip_section "setup-keyboard.sh not present"
    bash "$HERE/setup-keyboard.sh"
}
section_fonts() { install_fonts; }
section_nvidia() {
    has_nvidia_gpu || skip_section "No NVIDIA GPU found"
    bash "$HERE/setup-nvidia-guard.sh"
}
section_apt_hygiene() {
    sudo rm -f /etc/apt/sources.list.d/*.curtin.orig
    local leftover
    leftover="$(find /etc/apt/sources.list.d -name '*.list' -printf '  %f\n')"
    [ -z "$leftover" ] || printf 'One-line .list sources still present (not managed here):\n%s\n' "$leftover"
}

print_tool_versions() {
    local t
    echo ""
    echo "Installed tools:"
    for t in git nvim python3 java go rustc dotnet node pnpm uv gh docker kubectl helm lazygit \
        lazydocker yq jq eza bat zoxide atuin fzf rg fd tmux zsh tailscale psql gdalinfo ollama ulauncher keyd; do
        if command -v "$t" > /dev/null 2>&1; then printf '  %-11s %s\n' "$t" "$("$t" --version 2>&1 | head -1)"
        else printf '  %-11s missing\n' "$t"; fi
    done
}

if [ "${SETUP_UBUNTU_SOURCE_ONLY:-}" != 1 ]; then
    run_setup "$@"
    status=$?
    print_tool_versions
    exit "$status"
fi
```

  **Also while writing it:**

  - Remove the old version printout (`:532-695`).
  - Remove the separate "Start services" block, because `install_docker` handles it.
  - Remove the font sections, now handled by `install_fonts`.
  - Don't add `export PATH=` anywhere in the file. `run_setup` → `setup_path` handles it.

- [ ] **Step 4: Run the tests, shellcheck and a dry run.**
  - `bash scripts/tests/test-setup-ubuntu.sh`
  - `bash scripts/tests/test-no-rc-writes.sh`. This passes only for `setup-ubuntu.sh` at this point. Temporarily restrict the file list? No: leave the test listing all files. Tasks 4 and 5 make it pass for the others, so note in the commit message that `test-no-rc-writes` goes green after Task 5.
  - `shellcheck -S warning -e SC1091 -e SC2155 scripts/setup-ubuntu.sh`
  - `bash scripts/setup-ubuntu.sh --list`

  Expected: the first and the last two PASS.

- [ ] **Step 5: Commit.** Message: `feat(setup): split setup-ubuntu.sh into re-runnable sections`.

---

### Task 4: `setup-server.sh` uses the shared installers

**Files:**
- Modify: `scripts/setup-server.sh`

**Interfaces:**
- **Consumes:** `installers.sh` from Task 2.

- [ ] **Step 1: Confirm the contract test fails** for `setup-server.sh`: `bash scripts/tests/test-no-rc-writes.sh` should list lines in setup-server.sh.

- [ ] **Step 2: Edit `setup-server.sh`.**
  - Source `installers.sh` after `setup-common.sh`.
  - Call `setup_path` right after the sudo preflight.
  - **Replace these blocks with installer calls:**

| Lines | Block | Replacement |
|---|---|---|
| :141-158 | .NET | `install_dotnet 7.0 8.0 9.0 10.0` |
| :160-191 | Go and Rust | `install_pinned_go; install_rust` |
| :199-215 | yq and curlie | `install_pinned_yq`, then `command -v curlie \|\| go install github.com/rs/curlie@v1.6.0` |
| :302-313 | tpm | `install_tpm` |
| :315-338 | atuin | `apt_install_missing atuin` when `apt-cache show atuin` succeeds. Keep the current verified GitHub-binary path only as the fallback when apt has no atuin (older releases), and add `-f` to both of its curls. |
| :340-354 | lazygit, lazydocker | `install_pinned_git_tools` |
| :356-387 | gh, Docker, docker group | `install_gh; install_docker` |
| :395-412 | pnpm | `install_pnpm` |
| :414-424 | uv | `install_uv` |
| kubectl/helm block | | `install_pinned_k8s` |
| :243-255 | UFW block | `configure_ufw`. Keep the server's comment about safe defaults. |

  - **Neovim (`:94-121`):**
    - Use `curl -fsSL` everywhere.
    - Download and extract into a temp dir first, then replace `/opt/nvim` only after `tar` succeeds: `sudo rm -rf /opt/nvim && sudo mv "$tmp/nvim-linux-$arch" /opt/nvim`.
    - When the GitHub API lookup returns no version, fall back to `apt_install_missing neovim`.
  - **Delete every** `>> ~/.zshrc`, `>> ~/.bashrc` and `for rc in ~/.zshrc ~/.bashrc` line.

- [ ] **Step 3: Check that `shell/.bashrc` puts the tool directories on PATH**, since servers often use bash: `~/.local/bin`, `~/.cargo/bin`, `/usr/local/go/bin`, `~/go/bin`, `~/.dotnet` and `$PNPM_HOME`. Run `grep -n 'PATH' shell/.bashrc`. Add any that are missing as one guarded line, for example:

```bash
for d in "$HOME/.local/bin" "$HOME/.cargo/bin" /usr/local/go/bin "$HOME/go/bin" "$HOME/.dotnet" "$HOME/.local/share/pnpm"; do
    [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac
done
export PATH DOTNET_ROOT="$HOME/.dotnet"
```

- [ ] **Step 4: Verify.**
  - `bash -n scripts/setup-server.sh`
  - `shellcheck -S warning -e SC1091 -e SC2155 scripts/setup-server.sh`
  - `bash scripts/tests/test-no-rc-writes.sh`. It should now list only update-script lines, if any.

- [ ] **Step 5: Commit.** Message: `fix(server): use shared installers and stop writing to tracked rc files`.

---

### Task 5: Update scripts

**Files:**
- Modify: `scripts/update-all.sh`, `scripts/update-quick.sh`, `scripts/setup-update.sh`
- Create: `scripts/tests/test-update-scripts.sh`

**Interfaces:**
- **Consumes:** the CLI `setup-ubuntu.sh --only` from Task 3.

- [ ] **Step 1: Write the failing tests** in `scripts/tests/test-update-scripts.sh`.
  - Source `update-all.sh` with `UPDATE_ALL_SOURCE_ONLY=1`. Add that guard around its `main "$@"` call at the bottom of the script.
  - Test `update_dotfiles` with `HOME` pointed at a temp dir containing a `dotfiles` git repo:
    - **Dirty tree:** create an untracked change, then `update_dotfiles`. The function returns 0, the output contains `skipping`, and the repo HEAD is unchanged.
    - **No remote:** `git pull` fails. The function returns 0 and the output contains `could not`.
  - Test `cleanup` with fakes for `docker`, `sudo`, `apt`, `pip3` (exits 1) and `dpkg`. Set `OS=linux`. The `docker` fake log must contain `image prune -f` and `builder prune -f --filter until=168h`, and must not contain `--volumes` or `system prune`. `cleanup` returns 0 even though pip3 fails.
  - Test `setup-update.sh`: `grep -c -- '--full' scripts/setup-update.sh` is 0, and `grep -cE 'go-up|pip-up' scripts/setup-update.sh` is 0.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement the changes.**
  - **`update-all.sh` / `update_dotfiles`:**
    - When `git -C "$HOME/dotfiles" status --porcelain` isn't empty, `log_warning "dotfiles has local changes; skipping git pull"` and return 0.
    - Otherwise run `git pull --ff-only origin main || log_warning "could not fast-forward dotfiles; skipping"`.
    - Use `git -C`, not `cd`.
  - **`update-all.sh` / security:** `gpg --refresh-keys || log_warning …`.
  - **`update-all.sh` / `cleanup`:**
    - `pip3 cache purge || true`.
    - Replace `docker system prune -f --volumes` with `docker image prune -f` and `docker builder prune -f --filter until=168h`.
    - Linux only:
      - `rc="$(dpkg -l | awk '/^rc/{print $2}')"; [ -z "$rc" ] || sudo apt-get purge -y $rc` (ignore SC2086 with a comment);
      - `sudo find /var/crash -name '*.crash' -mtime +14 -delete 2>/dev/null || true`;
      - print `du -sh ~/.cache` and `docker system df` as information only.
  - **`update-all.sh` / new `reconcile_pinned_tools`** (Linux only, when `$HOME/dotfiles/scripts/setup-ubuntu.sh` exists): run `bash "$HOME/dotfiles/scripts/setup-ubuntu.sh" --only languages,cli,git-tools,k8s,node || log_warning "some pinned tools failed to update"`. Call it from the main flow after the dotfiles update.
  - **`update-all.sh` / summary:** track failures. Wrap each top-level step as `step_name || FAILED_STEPS+=(name)`. The summary prints `completed with failures: …` when `FAILED_STEPS` isn't empty, and the script exits 1 in that case.
  - **`update-all.sh` / flags:**
    - `--dry-run` prints what each step would do. That means the step list, with `apt list --upgradable` on Linux, then exit 0. Keep it simple.
    - `--quick` skips `cleanup`.
  - **`update-quick.sh`:** on Linux, remove the `npm update -g` call. Leave a comment: "global npm tools are pinned and reconciled by `update` (setup-ubuntu.sh --only node)".
  - **`setup-update.sh`:**
    - The `update-full`/`upf` aliases call `update` with no `--full`.
    - Remove the `go-up` and `pip-up` aliases.
    - Remove `update_shell_configs`' writes to `.bashrc` (the aliases already live in the file it generates).
    - Rename the generated `~/.local/bin/update-manager` to `~/.local/bin/dotfiles-update`, and delete an old `~/.local/bin/update-manager` it created before. Remove it only if it contains the string `dotfiles`.
    - Update any alias that pointed at `update-manager`.

- [ ] **Step 4: Run** `bash scripts/tests/test-update-scripts.sh`, `bash scripts/tests/test-no-rc-writes.sh` and shellcheck on the three files. Expected: PASS.

- [ ] **Step 5: Commit.** Message: `fix(update): keep updates running past failures and stop pruning Docker volumes`.

---

### Task 6 (hard): Keyboard power-user layer

**Files:**
- Create: `scripts/setup-keyboard.sh`, `config/keyd/default.conf`, `config/espanso/match/base.yml`, `docs/keyboard.md`, `scripts/tests/test-setup-keyboard.sh`
- Modify: `install.sh` (link the espanso config)

**Interfaces:**
- **Consumes:** from Task 1, `install_verified_deb`, the pins and `has_systemd`. From Task 2, `apt_install_missing` (source `installers.sh`).
- **Produces:** `scripts/setup-keyboard.sh`. With `SETUP_KEYBOARD_SOURCE_ONLY=1` it can be sourced. It defines `set_custom_shortcut ID NAME COMMAND BINDING`, `configure_shortcuts`, `configure_workspaces`, `configure_keyd`, `install_ulauncher`, `install_gpaste` and `install_espanso`.

- [ ] **Step 1: Write the failing tests** in `scripts/tests/test-setup-keyboard.sh`.
  - Use a fake `gsettings` backed by a key/value file `$TMPDIR_ROOT/gs` with lines `schema[:path] key value`:
    - `get` prints the stored value, or `@as []` for `custom-keybindings` when unset.
    - `set` replaces the line.
    - `list-keys` succeeds.

```bash
fake gsettings '
db="$TMPDIR_ROOT/gs"; touch "$db"
cmd="$1"; schema="$2"; key="${3:-}"
case "$cmd" in
  get) v="$(grep -F "$schema $key " "$db" | tail -1 | cut -d" " -f3-)"; [ -n "$v" ] && echo "$v" || echo "@as []" ;;
  set) grep -vF "$schema $key " "$db" > "$db.tmp"; mv "$db.tmp" "$db"; echo "$schema $key $4" >> "$db" ;;
  list-keys|list-schemas) exit 0 ;;
esac'
```

  - Tests:
    - **`test_custom_shortcut_is_not_duplicated`:** call `set_custom_shortcut dotfiles-ulauncher Ulauncher ulauncher-toggle '<Alt>space'` twice. The `custom-keybindings` value contains `dotfiles-ulauncher/` exactly once, and the binding stored at that path is `<Alt>space`.
    - **`test_custom_shortcut_appends_to_existing_list`:** pre-store `org.gnome.settings-daemon.plugins.media-keys custom-keybindings ['/x/custom0/']`, then add one. The list contains both.
    - **`test_workspaces`:** `configure_workspaces` sets `org.gnome.mutter dynamic-workspaces false`, `num-workspaces 6`, `switch-to-workspace-3 ['<Super>3']`, `move-to-workspace-6 ['<Super><Shift>6']` and `switch-to-application-1 []`.
    - **`test_shortcuts`:** `configure_shortcuts` sets these:

| Schema | Key | Value |
|---|---|---|
| `org.gnome.desktop.wm.keybindings` | `activate-window-menu` | `[]` |
| `org.gnome.desktop.wm.keybindings` | `close` | `['<Super>q', '<Alt>F4']` |
| `org.gnome.settings-daemon.plugins.media-keys` | `www` | `['<Super>b']` |
| `org.gnome.settings-daemon.plugins.media-keys` | `home` | `['<Super>e']` |
| `org.gnome.shell.keybindings` | `toggle-message-tray` | `['<Super>m']` |

      It also adds the terminal custom shortcut `<Super>Return` → `alacritty`.
    - **`test_skips_without_gnome`:** `env -u DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP=KDE bash scripts/setup-keyboard.sh` exits 0 and prints `GNOME`.
    - **`test_keyd_config_maps_capslock`:** `config/keyd/default.conf` contains `capslock = overload(control, esc)`, and `[ids]` followed by `*`.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**

  `config/keyd/default.conf`:

```ini
# Caps Lock: tap for Esc, hold for Ctrl. Installed to /etc/keyd/default.conf
# by scripts/setup-keyboard.sh; applies to every keyboard, in Wayland, X and TTYs.
[ids]
*

[main]
capslock = overload(control, esc)
```

  `config/espanso/match/base.yml`:

```yaml
# Starter espanso matches, linked to ~/.config/espanso/match/base.yml by install.sh.
matches:
  - trigger: ":date"
    replace: "{{date}}"
    vars:
      - name: date
        type: date
        params: { format: "%d.%m.%Y" }
  - trigger: ":isodate"
    replace: "{{date}}"
    vars:
      - name: date
        type: date
        params: { format: "%Y-%m-%d" }
  - trigger: ":time"
    replace: "{{time}}"
    vars:
      - name: time
        type: date
        params: { format: "%H:%M" }
  - trigger: ":mail"
    replace: "{{mail}}"
    vars:
      - name: mail
        type: shell
        params: { cmd: "git config --global user.email" }
  - trigger: ":shrug"
    replace: "¯\\_(ツ)_/¯"
```

  `scripts/setup-keyboard.sh`: the structure follows. The functions are written out in full.

```bash
#!/usr/bin/env bash
# Keyboard-driven GNOME setup. Everything it changes, with GNOME's defaults
# for undoing it, is listed in docs/keyboard.md.
#   Alt+Space        Ulauncher            Caps Lock   Esc on tap, Ctrl on hold (keyd)
#   Super+1..6       workspace 1..6       Super+Shift+1..6  move window there
#   Super+Return     Alacritty            Super+B / Super+E  browser / files
#   Super+Q          close window         Super+V      clipboard history (GPaste)
#   espanso          :date :isodate :time :mail :shrug
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/setup-common.sh
. "$HERE/lib/setup-common.sh"
# shellcheck source=lib/installers.sh
. "$HERE/lib/installers.sh"

MEDIA_KEYS=org.gnome.settings-daemon.plugins.media-keys
CUSTOM_BASE=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings
WM_KEYS=org.gnome.desktop.wm.keybindings

# set_custom_shortcut ID NAME COMMAND BINDING: creates or updates the custom
# shortcut at a fixed path named after ID, so re-runs never add duplicates.
set_custom_shortcut() {
    local id="$1" name="$2" command="$3" binding="$4" list path
    path="$CUSTOM_BASE/$id/"
    list="$(gsettings get "$MEDIA_KEYS" custom-keybindings)"
    if [[ "$list" != *"'$path'"* ]]; then
        case "$list" in
            "@as []"|"[]") list="['$path']" ;;
            *) list="${list%]}, '$path']" ;;
        esac
        gsettings set "$MEDIA_KEYS" custom-keybindings "$list"
    fi
    local schema="$MEDIA_KEYS.custom-keybinding:$path"
    gsettings set "$schema" name "$name"
    gsettings set "$schema" command "$command"
    gsettings set "$schema" binding "$binding"
}

configure_shortcuts() {
    gsettings set "$WM_KEYS" activate-window-menu "[]"          # frees Alt+Space for Ulauncher
    gsettings set "$WM_KEYS" close "['<Super>q', '<Alt>F4']"
    gsettings set "$MEDIA_KEYS" www "['<Super>b']"
    gsettings set "$MEDIA_KEYS" home "['<Super>e']"
    gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"  # frees Super+V for GPaste
    set_custom_shortcut dotfiles-terminal "Terminal" alacritty "<Super>Return"
    set_custom_shortcut dotfiles-ulauncher "Ulauncher" ulauncher-toggle "<Alt>space"
}

configure_workspaces() {
    local i
    gsettings set org.gnome.mutter dynamic-workspaces false
    gsettings set org.gnome.desktop.wm.preferences num-workspaces 6
    # The Ubuntu dock binds Super+1..9 to launching dock apps; hand them to workspaces.
    if gsettings list-keys org.gnome.shell.extensions.dash-to-dock > /dev/null 2>&1; then
        gsettings set org.gnome.shell.extensions.dash-to-dock hot-keys false
    fi
    for i in 1 2 3 4 5 6; do
        gsettings set org.gnome.shell.keybindings "switch-to-application-$i" "[]"
        gsettings set "$WM_KEYS" "switch-to-workspace-$i" "['<Super>$i']"
        gsettings set "$WM_KEYS" "move-to-workspace-$i" "['<Super><Shift>$i']"
    done
}

configure_keyd() {
    apt_install_missing keyd || return 1
    if ! cmp -s "$DOTFILES_DIR/config/keyd/default.conf" /etc/keyd/default.conf; then
        sudo install -D -m 0644 "$DOTFILES_DIR/config/keyd/default.conf" /etc/keyd/default.conf
        has_systemd && sudo systemctl enable --now keyd && sudo keyd reload
    fi
}

install_ulauncher() {
    if needs_install ulauncher "$ULAUNCHER_VERSION"; then
        install_verified_deb "$ULAUNCHER_URL" "$ULAUNCHER_SHA256" || return 1
    fi
    # Start hidden at login. Ulauncher 5 positions its window correctly only under XWayland.
    mkdir -p "$HOME/.config/autostart"
    cat > "$HOME/.config/autostart/ulauncher.desktop" <<'EOF'
[Desktop Entry]
Name=Ulauncher
Exec=env GDK_BACKEND=x11 /usr/bin/ulauncher --hide-window
Icon=ulauncher
Type=Application
X-GNOME-Autostart-enabled=true
EOF
    pgrep -x ulauncher > /dev/null || (GDK_BACKEND=x11 setsid ulauncher --hide-window > /dev/null 2>&1 &)
}

install_gpaste() {
    apt_install_missing gpaste-2 gnome-shell-extension-gpaste || return 1
    local uuid
    uuid="$(gnome-extensions list 2>/dev/null | grep -i gpaste | head -1)"
    if [ -z "$uuid" ]; then
        echo "WARNING: the GPaste shell extension isn't visible yet; log out and in, then re-run."
        return 0
    fi
    gnome-extensions enable "$uuid" || echo "WARNING: could not enable $uuid on this GNOME version."
    gsettings set org.gnome.GPaste show-history '<Super>v'
}

install_espanso() {
    if needs_install espanso "$ESPANSO_VERSION"; then
        install_verified_deb "$ESPANSO_URL" "$ESPANSO_SHA256" || return 1
    fi
    # The Wayland build reads input devices directly and needs this capability.
    sudo setcap "cap_dac_override+p" "$(command -v espanso)"
    espanso service register > /dev/null 2>&1 || true
    espanso service status > /dev/null 2>&1 || espanso service start
}

main() {
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [[ "${XDG_CURRENT_DESKTOP:-}" != *GNOME* ]]; then
        echo "Not in a GNOME session; skipping the keyboard setup."
        return 0
    fi
    local status=0
    configure_keyd || status=1
    install_ulauncher || status=1
    configure_shortcuts || status=1
    configure_workspaces || status=1
    install_gpaste || status=1
    install_espanso || status=1
    echo ""
    echo "Keyboard shortcuts: see docs/keyboard.md"
    return "$status"
}

[ "${SETUP_KEYBOARD_SOURCE_ONLY:-}" = 1 ] || main "$@"
```

  `install.sh`: after the Powerlevel10k block, add:

```bash
# espanso text expansion matches
if [ "$(uname)" = Linux ]; then
    mkdir -p "$HOME/.config/espanso/match"
    backup_and_symlink "$DOTFILES_DIR/config/espanso/match/base.yml" "$HOME/.config/espanso/match/base.yml"
fi
```

  `docs/keyboard.md`: a table of every shortcut with columns **Keys / Action / Set by / GNOME default (to undo)**. List every `gsettings` key the script changes with its stock value, so it can be reverted with `gsettings reset <schema> <key>`. Also give the `sudo rm /etc/keyd/default.conf && sudo systemctl restart keyd` undo for keyd. The defaults, read from this machine before the change:

| Schema | Key | Default |
|---|---|---|
| `org.gnome.desktop.wm.keybindings` | `switch-input-source` | `['<Super>space', 'XF86Keyboard']` (not changed) |
| `org.gnome.desktop.wm.keybindings` | `activate-window-menu` | `['<Alt>space']` |
| `org.gnome.desktop.wm.keybindings` | `close` | `['<Alt>F4']` |
| `org.gnome.mutter` | `dynamic-workspaces` | `true` |
| `org.gnome.shell.keybindings` | `toggle-message-tray` | `['<Super>v', '<Super>m']` |
| `org.gnome.shell.keybindings` | `switch-to-application-N` | `['<Super>N']` |
| `org.gnome.shell.extensions.dash-to-dock` | `hot-keys` | `true` |

  Run `gsettings get` on this machine for each key before changing it, and record the real values.

- [ ] **Step 4: Run** `bash scripts/tests/test-setup-keyboard.sh` and shellcheck on the script. Expected: PASS.

- [ ] **Step 5: Commit.** Message: `feat(keyboard): add Ulauncher, keyd, workspace and launch shortcuts, GPaste and espanso`.

---

### Task 7: Shell config gaps

**Files:**
- Modify: `shell/aliases.zsh`, `shell/constants.zsh`, `shell/completion.zsh`, `shell/.zshrc`
- Create: `scripts/tests/test-shell-config.sh`

- [ ] **Step 1: Write the failing test** `scripts/tests/test-shell-config.sh`:

```bash
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
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`aliases.zsh`:** `alias dc="docker compose"`, `alias dup="docker compose up -d"`, `alias ddown="docker compose down"`.
  - **`constants.zsh`:** `export TOOL_NEOFETCH="fastfetch"`. Then `grep -rn TOOL_NEOFETCH shell/` and keep the users of the variable working.
  - **`completion.zsh`:** inside the fzf block, after `[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh`, add:

```zsh
    # Debian/Ubuntu's fzf package ships its zsh widgets here (Ctrl-T, Alt-C;
    # Ctrl-R is taken over by atuin when it's installed, see .zshrc).
    for f in /usr/share/doc/fzf/examples/key-bindings.zsh /usr/share/doc/fzf/examples/completion.zsh; do
        [ -f "$f" ] && source "$f"
    done
```

    `completion.zsh` is sourced before the atuin block in `.zshrc`. Confirm the order with `grep -n 'completion.zsh\|atuin' shell/.zshrc`. atuin must come later so it owns Ctrl-R.
  - **`.zshrc`:**
    - Delete the 4-line "added by Docker Desktop" block at the end. It points at `/Volumes/ext1` and runs a second `compinit`.
    - After the atuin block, add:

```zsh
# zoxide — `z <dir>` jumps to frecent directories, `zi` picks one with fzf.
if command -v zoxide > /dev/null 2>&1; then
    eval "$(zoxide init zsh)"
fi
```

- [ ] **Step 4: Verify.**
  - Run `bash scripts/tests/test-shell-config.sh` (PASS).
  - Run `for i in 1 2 3; do /usr/bin/time -f %e zsh -i -c exit; done` and compare with the 0.50 s baseline. It must not be slower than 0.55 s.

- [ ] **Step 5: Commit.** Message: `fix(shell): fix compose aliases, load apt fzf bindings and zoxide, drop the macOS Docker block`.

---

### Task 8: rgb-off and boot chain (this machine)

**Files:**
- Modify: `scripts/setup-rgb-off.sh`, `scripts/setup-dev-tuning.sh`

- [ ] **Step 1: Reproduce and find the cause** of the error with superpowers:systematic-debugging. Read the evidence first:
  - `journalctl -u rgb-off -b --no-pager`
  - `systemctl cat rgb-off`

  The log shows that the args were built from the first detection pass:

  ```
  --device 0 --mode direct --color 000000 … --device 5 --mode off
  ```

  The `exec openrgb` call then ran a **second** detection, in which I2C timed out, and failed with `Error: Empty device ID`.

  Check `openrgb --help` for how `--device` is parsed. In OpenRGB 0.9 and later, `--device` takes an index or a **name**, and "Empty device ID" fires when the index is not in the current device list. Confirm that with `openrgb --noautoconnect --device 99 --mode off` (no root needed to see the parse error).

- [ ] **Step 2: Fix `rgb-off`** (the heredoc in `setup-rgb-off.sh`). Make the apply step robust to the device count changing between passes:
  - Apply each device in **its own** `openrgb --noautoconnect --device N …` call.
  - Wrap each call in `timeout 30`.
  - Continue past failures, counting them.
  - Exit 0 if at least one device was turned off. Exit 1 only when none was, and print the device list.

  Also, in the unit:
  - Add `TimeoutStartSec=120`.
  - Add `After=systemd-modules-load.service systemd-udev-settle.service`.
  - Keep `Type=exec`. Add `Nice=10`, so the I2C probing doesn't compete with login.

  Keep the existing comments' style.

- [ ] **Step 3: Boot chain.** In `setup-dev-tuning.sh`, add a step guarded by `[ "$(cat /sys/class/dmi/id/chassis_type 2>/dev/null)" = 3 ]` (desktop tower) or a `--desktop` flag. The step:
  - records `systemd-analyze critical-chain docker.service` in the output;
  - runs `sudo systemctl disable NetworkManager-wait-online.service`;
  - prints a note that `sudo systemctl enable NetworkManager-wait-online.service` reverts it.

- [ ] **Step 4: Verify.** Run `bash -n` on both files, plus shellcheck. Running them needs root, so the actual run happens in the final apply step.

- [ ] **Step 5: Commit.** Message: `fix(rgb): turn each device off separately so a late I2C timeout can't fail the whole run`, and in the body note the boot-chain change. Or make two commits.

---

### Task 9: CI, README, fonts reuse

**Files:**
- Modify: `.github/workflows/lint.yml`, `README.md`, `scripts/setup-terminal.sh`, `scripts/fix-fonts.sh`

- [ ] **Step 1: Fonts reuse.**
  - `setup-terminal.sh:196-240` is the Linux font block. Replace it with: source `lib/setup-common.sh` and `lib/installers.sh`, then call `install_fonts`. Leave the macOS branch unchanged.
  - Make `fix-fonts.sh` a thin wrapper that sources the libs and calls `install_fonts`.
  - On Linux, `setup-terminal.sh:366-368` only advises installing eza and bat. Change it to `install_cli_extras`, or remove that advice.

- [ ] **Step 2: CI.** Add this job to `lint.yml`:

```yaml
  shell-tests:
    name: Setup and shell tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - name: Install zsh
        run: sudo apt-get update && sudo apt-get install -y zsh
      - name: Run setup, update and shell tests
        run: |
          set -e
          for t in test-setup-common test-setup-runner test-setup-installers test-setup-ubuntu \
                   test-no-rc-writes test-update-scripts test-shell-config test-setup-keyboard; do
            echo "== $t"; bash "scripts/tests/$t.sh"
          done
```

  Don't add the other existing `test-*.sh` files. They depend on node or pi and aren't part of this change. Run the loop locally first to confirm it passes on a clean checkout.

- [ ] **Step 3: README.**
  - In the Ubuntu section, document `--list`, `--only` and `--skip` and the log location, plus `setup-keyboard.sh` with a link to `docs/keyboard.md`.
  - Mention that NVIDIA steps run only when an NVIDIA GPU is detected.
  - Mention that `update` reconciles pinned tools.
  - Mention `setup-dev-tuning.sh` and `setup-always-on.sh`, which are currently undocumented.

- [ ] **Step 4: Run all eight test files.** Run shellcheck over `scripts/` and `install.sh` exactly as CI does: `shellcheck -S warning -e SC1091 -e SC2155 scripts/*.sh scripts/lib/*.sh install.sh`. Expected: all PASS.

- [ ] **Step 5: Commit.** Message: `ci: run the setup and shell tests; docs: document setup sections and keyboard layer`.

---

## After all tasks (lead, not a subagent)

1. **Full suite:** all eight test files, plus shellcheck.
2. **Partial live run** without root: `bash scripts/setup-ubuntu.sh --only cli,fonts` (sudo is needed for apt, so this may prompt). Instead, run `SETUP_UBUNTU_SOURCE_ONLY=1` checks, then do the real run in the apply step.
3. **Ship.**
4. **Apply on devbox1:**
   - The user runs one sudo command:

     ```
     ! sudo -v && bash <worktree>/scripts/setup-ubuntu.sh && bash <worktree>/scripts/setup-rgb-off.sh && bash <worktree>/scripts/setup-dev-tuning.sh
     ```

   - Then verify:
     - `systemctl --failed`
     - `ls /etc/apt/sources.list.d`
     - `command -v eza bat zoxide atuin ulauncher keyd espanso`
     - `gsettings get` on each shortcut
     - zsh startup time
     - `systemctl status rgb-off`
     - a second run of `setup-ubuntu.sh` that does no installs

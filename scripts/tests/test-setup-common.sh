#!/usr/bin/env bash
# Tests for scripts/lib/setup-common.sh: the pin table, verified downloads and
# the SSH hardening guard. Offline by default; VERIFY_DOWNLOADS=1 also downloads
# every pinned file and checks it against its pinned sha256.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/lib/setup-common.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

load_lib() {
    # shellcheck disable=SC1090
    . "$SCRIPT"
}

# Fake curl serves files from $FIXTURES by URL basename, logging each URL.
# Fake sudo logs and runs its command, except creating /run/sshd.
setup_fakes() {
    export FIXTURES="$TMPDIR_ROOT/fixtures" CALLS="$TMPDIR_ROOT/calls.log"
    mkdir -p "$FIXTURES"
    : > "$CALLS"
    cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
out=""
while [ $# -gt 1 ]; do
    case "$1" in -o) out="$2"; shift ;; esac
    shift
done
printf 'curl %s\n' "$1" >> "$CALLS"
cp "$FIXTURES/$(basename "$1")" "$out"
EOF
    cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$CALLS"
[ "$*" = "mkdir -p /run/sshd" ] && exit 0
"$@"
EOF
    cat > "$FAKE_BIN/sshd" <<'EOF'
#!/usr/bin/env bash
printf 'sshd %s\n' "$*" >> "$CALLS"
exit "${SSHD_EXIT:-0}"
EOF
    cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$CALLS"
EOF
    cat > "$FAKE_BIN/getent" <<'EOF'
#!/usr/bin/env bash
printf '%s:x:1000:1000::%s:/bin/bash\n' "$2" "$FAKE_HOME"
EOF
    chmod +x "$FAKE_BIN"/*
    export FAKE_HOME="$TMPDIR_ROOT/home"
    mkdir -p "$FAKE_HOME/.ssh"
    export SSHD_HARDENING_CONF="$TMPDIR_ROOT/10-hardening.conf"
    unset SUDO_USER
    load_lib
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

# Names of the pins the library defines (NAME for each NAME_URL=...).
pin_names() {
    sed -nE 's/^([A-Z0-9_]+)_URL=.*/\1/p' "$SCRIPT"
}

test_every_pin_is_https_with_a_sha256() {
    setup_test "every pin is https with a sha256"
    load_lib
    local name url_var sha_var count=0
    for name in $(pin_names); do
        url_var="${name}_URL" sha_var="${name}_SHA256"
        assert_contains "${!url_var}" "https://" "$url_var"
        assert_eq "yes" "$([[ ${!sha_var:-} =~ ^[0-9a-f]{64}$ ]] && echo yes)" "$sha_var is a sha256"
        count=$((count + 1))
    done
    assert_eq 8 "$count" "number of pinned downloads"
    teardown_test
}

test_download_verified_accepts_match_and_rejects_mismatch() {
    setup_test "download_verified checks the sha256"
    setup_fakes
    printf 'payload\n' > "$FIXTURES/tool"
    local good
    good="$(sha "$FIXTURES/tool")"

    download_verified https://example.test/tool "$good" "$TMPDIR_ROOT/ok" 2>/dev/null
    assert_eq 0 "$?" "matching hash succeeds"
    assert_eq "payload" "$(cat "$TMPDIR_ROOT/ok")" "file kept"

    download_verified https://example.test/tool "$(printf '0%.0s' {1..64})" "$TMPDIR_ROOT/bad" 2>/dev/null
    assert_eq 1 "$?" "mismatched hash fails"
    assert_eq "no" "$([ -e "$TMPDIR_ROOT/bad" ] && echo yes || echo no)" "mismatched file removed"
    teardown_test
}

test_install_verified_binary_handles_each_format() {
    setup_test "install_verified_binary installs raw, .gz and .tar.gz members"
    setup_fakes
    mkdir -p "$TMPDIR_ROOT/src/linux-amd64" "$TMPDIR_ROOT/dest"
    printf 'raw\n' > "$FIXTURES/rawtool"
    printf 'gz\n' | gzip > "$FIXTURES/gztool.gz"
    printf 'tar\n' > "$TMPDIR_ROOT/src/linux-amd64/tartool"
    tar -czf "$FIXTURES/tartool.tar.gz" -C "$TMPDIR_ROOT/src" linux-amd64/tartool

    install_verified_binary https://example.test/rawtool "$(sha "$FIXTURES/rawtool")" "$TMPDIR_ROOT/dest/raw"
    install_verified_binary https://example.test/gztool.gz "$(sha "$FIXTURES/gztool.gz")" "$TMPDIR_ROOT/dest/gz"
    install_verified_binary https://example.test/tartool.tar.gz "$(sha "$FIXTURES/tartool.tar.gz")" \
        "$TMPDIR_ROOT/dest/tar" linux-amd64/tartool
    assert_eq "raw gz tar" "$(cat "$TMPDIR_ROOT/dest/raw" "$TMPDIR_ROOT/dest/gz" "$TMPDIR_ROOT/dest/tar" | tr '\n' ' ' | sed 's/ $//')" "installed contents"
    assert_eq "yes" "$([ -x "$TMPDIR_ROOT/dest/tar" ] && echo yes)" "installed executable"
    assert_not_contains "$(cat "$CALLS")" "sudo" "no sudo for a writable directory"

    install_verified_binary https://example.test/rawtool "$(printf 'f%.0s' {1..64})" "$TMPDIR_ROOT/dest/evil" 2>/dev/null
    assert_eq 1 "$?" "bad hash fails"
    assert_eq "no" "$([ -e "$TMPDIR_ROOT/dest/evil" ] && echo yes || echo no)" "nothing installed on bad hash"
    teardown_test
}

test_harden_sshd_skips_without_authorized_keys() {
    setup_test "harden_sshd skips without an authorized key"
    setup_fakes
    local out
    out="$(harden_sshd 2>&1)"
    assert_contains "$out" "leaving SSH password login on" "warns when the file is missing"
    printf '# just a comment\n\n' > "$FAKE_HOME/.ssh/authorized_keys"
    out="$(harden_sshd 2>&1)"
    assert_contains "$out" "leaving SSH password login on" "warns when the file has no keys"
    assert_eq "no" "$([ -e "$SSHD_HARDENING_CONF" ] && echo yes || echo no)" "no config written"
    assert_not_contains "$(cat "$CALLS")" "systemctl" "ssh not reloaded"
    teardown_test
}

test_harden_sshd_writes_validates_and_reloads() {
    setup_test "harden_sshd writes, validates and reloads"
    setup_fakes
    printf 'ssh-ed25519 AAAATEST me@laptop\n' > "$FAKE_HOME/.ssh/authorized_keys"
    harden_sshd > /dev/null
    assert_eq 0 "$?" "succeeds"
    local conf
    conf="$(cat "$SSHD_HARDENING_CONF")"
    assert_contains "$conf" "PasswordAuthentication no" "password auth off"
    assert_contains "$conf" "KbdInteractiveAuthentication no" "keyboard-interactive off"
    assert_contains "$conf" "PermitRootLogin no" "root login off"
    assert_contains "$(cat "$CALLS")" "sshd -t" "config validated"
    assert_contains "$(cat "$CALLS")" "systemctl try-reload-or-restart ssh" "ssh reloaded"

    : > "$CALLS"
    harden_sshd > /dev/null
    assert_eq "" "$(cat "$CALLS")" "re-run changes nothing"
    teardown_test
}

test_harden_sshd_backs_out_when_sshd_rejects_config() {
    setup_test "harden_sshd backs out an invalid config"
    setup_fakes
    printf 'ssh-ed25519 AAAATEST me@laptop\n' > "$FAKE_HOME/.ssh/authorized_keys"
    SSHD_EXIT=1 harden_sshd > /dev/null 2>&1
    assert_eq 1 "$?" "fails"
    assert_eq "no" "$([ -e "$SSHD_HARDENING_CONF" ] && echo yes || echo no)" "config removed"
    assert_not_contains "$(cat "$CALLS")" "systemctl" "ssh not reloaded"
    teardown_test
}

test_pinned_downloads_match() {
    setup_test "pinned downloads match their sha256"
    load_lib
    local name url_var sha_var file
    for name in $(pin_names); do
        url_var="${name}_URL" sha_var="${name}_SHA256"
        file="$TMPDIR_ROOT/$(basename "${!url_var}")"
        if curl -fsSL -o "$file" "${!url_var}"; then
            assert_eq "${!sha_var}" "$(sha "$file")" "${!url_var}"
            printf '  %-10s %s  %s\n' "$name" "$(sha "$file")" "${!url_var}"
        else
            assert_eq "downloaded" "failed" "${!url_var}"
        fi
        rm -f "$file"
    done
    teardown_test
}

test_every_pin_is_https_with_a_sha256
test_download_verified_accepts_match_and_rejects_mismatch
test_install_verified_binary_handles_each_format
test_harden_sshd_skips_without_authorized_keys
test_harden_sshd_writes_validates_and_reloads
test_harden_sshd_backs_out_when_sshd_rejects_config
[ "${VERIFY_DOWNLOADS:-0}" = 1 ] && test_pinned_downloads_match

summary

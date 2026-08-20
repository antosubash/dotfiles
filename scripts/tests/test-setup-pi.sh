#!/usr/bin/env bash
# Self-contained tests for scripts/setup-pi.sh.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/setup-pi.sh"
PASS=0
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }
assert_eq() {
    if [ "$1" = "$2" ]; then pass; else fail "${3:-values differ}: expected [$1], got [$2]"; fi
}
assert_link() {
    local path="$1" target="$2"
    if [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ]; then pass; else fail "expected symlink $path -> $target"; fi
}

HOME_DIR="$TMP/home"
PI_DIR="$TMP/custom-pi"
mkdir -p "$HOME_DIR"

run_setup() {
    HOME="$HOME_DIR" PI_CODING_AGENT_DIR="$PI_DIR" bash "$SCRIPT"
}

# A custom agent directory receives every managed resource.
run_setup >/dev/null
for resource in settings.json APPEND_SYSTEM.md prompts skills agents extensions; do
    assert_link "$PI_DIR/$resource" "$ROOT/pi/agent/$resource"
done

# Re-running is idempotent and does not manufacture backups for managed links.
run_setup >/dev/null
assert_eq 0 "$(find "$HOME_DIR/.dotfiles_backup" -mindepth 1 -maxdepth 1 -print | wc -l)" "idempotent setup backups"

# A concurrent setup fails fast and leaves the owner-created lock untouched.
mkdir "${PI_DIR}.setup.lock"
if run_setup >/dev/null 2>"$TMP/setup-lock.log"; then
    fail "concurrent setup unexpectedly succeeded"
else
    pass
fi
assert_eq 1 "$(grep -c 'Refusing concurrent Pi setup' "$TMP/setup-lock.log")" "setup lock diagnostic"
[ -d "${PI_DIR}.setup.lock" ] && pass || fail "setup lock was removed by a competing run"
rm -rf "${PI_DIR}.setup.lock"
run_setup >/dev/null

# Existing files are moved aside, never overwritten, and both generations stay
# readable when the setup is run again in the same second.
rm "$PI_DIR/settings.json"
printf 'first-settings\n' > "$PI_DIR/settings.json"
run_setup >"$TMP/setup-1.log"
rm "$PI_DIR/settings.json"
printf 'second-settings\n' > "$PI_DIR/settings.json"
run_setup >"$TMP/setup-2.log"
backups=("$HOME_DIR/.dotfiles_backup"/pi-settings.json-*)
assert_eq 2 "${#backups[@]}" "backup count"
assert_eq first-settings "$(cat "${backups[0]}")" "first backup preserved"
assert_eq second-settings "$(cat "${backups[1]}")" "second backup preserved"

printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

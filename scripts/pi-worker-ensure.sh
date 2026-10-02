#!/usr/bin/env bash
# Make sure the background pi issue worker serves one repository, setting it up if needed.
#
#   pi-worker-ensure.sh OWNER/REPO [--app-url URL] [--check-only]
#
# Idempotent. In order:
#   1. installs the worker (scripts/setup-pi-issue-worker.sh) if `pi-issue-worker` is missing;
#   2. creates ~/.config/pi-issue-worker/<repo>.env from an existing profile (or .env.example)
#      when the repo has no profile — repository, URL, default branch, sandbox off, optional app URL;
#   3. runs the read-only `--check` for that profile (GitHub access, clone, pi login + model);
#   4. enables the supervisor service and restarts it when a profile was added or it isn't running
#      (in-flight jobs resume from their saved sessions);
#   5. waits until the worker has created its `pi-*` labels on the repo (proof it's polling).
# --check-only stops after step 3 (no service changes). PI_WORKER_CONFIG_DIR overrides the profile dir.
# Exits non-zero with the reason if any step fails.
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${PI_WORKER_CONFIG_DIR:-$HOME/.config/pi-issue-worker}"
SERVICE="pi-issue-worker-supervisor.service"

repo="${1:-}"; shift || true
app_url=""
check_only=0
while [ $# -gt 0 ]; do
    case "$1" in
        --app-url) app_url="$2"; shift 2 ;;
        --check-only) check_only=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2
fi

step() { printf '• %s\n' "$*"; }
fail() { printf '✗ %b\n' "$*" >&2; exit 1; }

# 1. Installed?
if ! command -v pi-issue-worker >/dev/null 2>&1; then
    step "installing the pi issue worker"
    "$DOTFILES_DIR/scripts/setup-pi-issue-worker.sh" >/dev/null || fail "worker install failed (run scripts/setup-pi-issue-worker.sh to see why)"
fi

# 1b. Can pi sanitize evidence? Every run cleans its screenshots with ffmpeg inside bwrap, from a
# namespaced systemd unit. Ubuntu's apparmor_restrict_unprivileged_userns=1 (kernel 7.0+) blocks that,
# which blocks every issue at its last step. Probe the way the service runs.
if command -v systemd-run >/dev/null 2>&1 && command -v bwrap >/dev/null 2>&1; then
    if ! systemd-run --user --collect --wait -q -p PrivateTmp=true \
        bwrap --unshare-all --ro-bind /usr /usr --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
        --proc /proc --dev /dev /usr/bin/true >/dev/null 2>&1; then
        fail "bwrap can't create a namespace under systemd, so every pi run would block at evidence.\nFix (host-wide, run in a terminal with sudo):\n  echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-pi-issue-worker-userns.conf && sudo sysctl -p /etc/sysctl.d/60-pi-issue-worker-userns.conf\nthen rerun this script. See pi/github-issue-worker/docs/troubleshooting.md."
    fi
fi

# 2. Profile for this repo?
mkdir -p "$CONFIG_DIR"; chmod 700 "$CONFIG_DIR"
profile_file="$(grep -lx "PI_WORKER_REPOSITORY=$repo" "$CONFIG_DIR"/*.env 2>/dev/null | head -1 || true)"
added=0
if [ -z "$profile_file" ]; then
    gh repo view "$repo" --json name >/dev/null 2>&1 || fail "gh can't access $repo"
    base="$(gh repo view "$repo" --json defaultBranchRef -q .defaultBranchRef.name)"
    name="${repo#*/}"
    profile_file="$CONFIG_DIR/$name.env"
    [ -e "$profile_file" ] && profile_file="$CONFIG_DIR/${repo%%/*}-$name.env"
    template="$(ls "$CONFIG_DIR"/*.env 2>/dev/null | head -1 || true)"
    [ -n "$template" ] || template="$DOTFILES_DIR/pi/github-issue-worker/.env.example"
    step "adding profile $(basename "$profile_file") (from $(basename "$template"))"
    # Never inherit another repo's token or data directory.
    sed -E 's/^(GH_TOKEN|PI_WORKER_DATA_DIR)=/# \1=/' "$template" > "$profile_file"
    chmod 600 "$profile_file"
    set_kv() {  # replace KEY=… or a commented "# KEY=…", else append
        local key="$1" val="$2"
        if grep -qE "^#? ?$key=" "$profile_file"; then
            python3 - "$profile_file" "$key" "$val" <<'EOF'
import re, sys
path, key, val = sys.argv[1:]
lines = open(path).read().splitlines()
for i, line in enumerate(lines):
    if re.match(rf"^#? ?{re.escape(key)}=", line):
        lines[i] = f"{key}={val}"
        break
open(path, "w").write("\n".join(lines) + "\n")
EOF
        else
            printf '%s=%s\n' "$key" "$val" >> "$profile_file"
        fi
    }
    set_kv PI_WORKER_REPOSITORY "$repo"
    set_kv PI_WORKER_REPOSITORY_URL "https://github.com/$repo.git"
    set_kv PI_WORKER_BASE_BRANCH "$base"
    set_kv PI_WORKER_SANDBOX 0
    if [ -n "$app_url" ]; then
        set_kv PI_WORKER_APP_URL "$app_url"
    else
        sed -i -E 's/^PI_WORKER_APP_URL=/# PI_WORKER_APP_URL=/' "$profile_file"
    fi
    added=1
fi
profile="$(basename "$profile_file" .env)"

# 3. Read-only check for this profile.
step "checking profile $profile"
if out="$(pi-issue-worker-supervisor --config-dir "$CONFIG_DIR" --profile "$profile" --check 2>&1)"; then
    printf '%s\n' "$out" | grep -q "Ready: $repo" || fail "check didn't report Ready for $repo:\n$out"
elif printf '%s\n' "$out" | grep -q "Worker profile is already running"; then
    # The live service holds this profile's lock: it's already up (and passed its own startup check).
    step "profile $profile is already running in the service"
else
    fail "check failed for $profile:\n$(printf '%s\n' "$out" | grep -v '^\s*at ' | tail -5)"
fi

if [ "$check_only" = 1 ]; then
    printf '✓ profile %s is valid for %s (service not touched: --check-only)\n' "$profile" "$repo"
    exit 0
fi

# 4. Service running with this profile loaded?
command -v systemctl >/dev/null 2>&1 || fail "no systemd: run 'pi-issue-worker-supervisor' yourself"
systemctl --user enable "$SERVICE" >/dev/null 2>&1 || true
if [ "$added" = 1 ] || ! systemctl --user is-active --quiet "$SERVICE"; then
    step "restarting $SERVICE (in-flight jobs resume)"
    systemctl --user restart "$SERVICE"
fi
since="$(date '+%Y-%m-%d %H:%M:%S')"

# 5. Polling? The worker creates its labels on the first poll.
for _ in $(seq 1 36); do
    if gh label list -R "$repo" --search pi-ready --json name -q '.[].name' 2>/dev/null | grep -qx pi-ready; then
        systemctl --user is-active --quiet "$SERVICE" || fail "$SERVICE stopped:\n$(journalctl --user -u "$SERVICE" -n 15 --no-pager)"
        printf '✓ pi worker is serving %s (profile %s)\n' "$repo" "$profile"
        exit 0
    fi
    if ! systemctl --user is-active --quiet "$SERVICE"; then
        fail "$SERVICE stopped:\n$(journalctl --user -u "$SERVICE" --since "$since" --no-pager | tail -15)"
    fi
    sleep 5
done
fail "worker is running but hasn't created labels on $repo after 3 minutes:\n$(journalctl --user -u "$SERVICE" --since "$since" --no-pager | grep -i "$profile\|error" | tail -10)"

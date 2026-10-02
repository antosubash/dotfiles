#!/usr/bin/env bash
# Turn Claude Code plugins on or off for one repo, without touching global settings.
#
# Niche plugins (figma, grafana-mcp, pydantic-ai, chrome-devtools-mcp, ...) are off in
# ~/.claude/settings.json so they don't load into every session. This writes per-repo
# overrides to <repo>/.claude/settings.local.json, which is personal and never committed
# (added to .git/info/exclude if the repo's .gitignore doesn't already cover it).
#
# Usage:
#   claude-plugins.sh enable  figma grafana-mcp      # in the current repo
#   claude-plugins.sh disable figma
#   claude-plugins.sh list
#   claude-plugins.sh --repo ~/Repos/IIASA.GeoWiki enable grafana-mcp
#
# Short names get "@claude-plugins-official" appended; pass a full "name@marketplace" otherwise.
set -euo pipefail

repo="$PWD"
if [ "${1:-}" = "--repo" ]; then
    repo="$2"; shift 2
fi
action="${1:-}"; shift || true

case "$action" in
    enable|disable|list) ;;
    *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

repo="$(git -C "$repo" rev-parse --show-toplevel)"
file="$repo/.claude/settings.local.json"
if git -C "$repo" ls-files --error-unmatch .claude/settings.local.json >/dev/null 2>&1; then
    echo "error: $repo commits .claude/settings.local.json, so a change here would be shared." >&2
    echo "       Untrack it first: git rm --cached .claude/settings.local.json, then add it to .gitignore." >&2
    exit 1
fi
mkdir -p "$repo/.claude"
[ -f "$file" ] || echo '{}' > "$file"
if ! git -C "$repo" check-ignore -q .claude/settings.local.json; then
    echo ".claude/settings.local.json" >> "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)/info/exclude"
fi

python3 - "$file" "$action" "$@" <<'EOF'
import json, sys
path, action, names = sys.argv[1], sys.argv[2], sys.argv[3:]
with open(path) as fh:
    data = json.load(fh)
plugins = data.setdefault("enabledPlugins", {})
for n in names:
    key = n if "@" in n else f"{n}@claude-plugins-official"
    plugins[key] = action == "enable"
if action != "list":
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
for k, v in sorted(plugins.items()):
    print(f"  {'on ' if v else 'off'}  {k}")
EOF

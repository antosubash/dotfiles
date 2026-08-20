#!/usr/bin/env bash
# Remove clean linked worktrees whose exact branch HEAD belongs to an old,
# merged GitHub pull request. Local branches are intentionally preserved.
set -u

DAYS=14
DRY_RUN=0
REPO=""
REMOVED=0
KEPT=0
ERRORS=0

usage() {
    cat <<'EOF'
Usage: cleanup-merged-worktrees [--days N] [--dry-run] [--repo PATH]

Removes linked worktrees in one repository only when all of these are true:
  - the worktree is clean and on a branch;
  - GitHub has a merged PR whose head SHA exactly matches the branch HEAD;
  - the PR was merged at least N days ago (default: 14).

Local branches are preserved. Worktrees are never force-removed.

Options:
  --days N       Minimum age in days since PR merge (default: 14)
  --dry-run      List removable worktrees without changing anything
  --repo PATH    Repository or linked-worktree path (default: current repo)
  -h, --help     Show this help
EOF
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --days) DAYS="${2:?--days needs a non-negative integer}"; shift ;;
            --days=*) DAYS="${1#*=}" ;;
            --dry-run) DRY_RUN=1 ;;
            --repo) REPO="${2:?--repo needs a path}"; shift ;;
            --repo=*) REPO="${1#*=}" ;;
            -h|--help) usage; exit 0 ;;
            *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
        esac
        shift
    done
    case "$DAYS" in
        ''|*[!0-9]*) printf -- '--days must be a non-negative integer\n' >&2; exit 2 ;;
    esac
    if [ "${#DAYS}" -gt 5 ] || [ "$((10#$DAYS))" -gt 36500 ]; then
        printf -- '--days must not exceed 36500\n' >&2
        exit 2
    fi
    DAYS=$((10#$DAYS))
}

process_worktree() {
    local path="$1" branchref="$2" branch head prs match number merged_at url

    [ -n "$path" ] || return 0
    [ "$path" != "$PRIMARY" ] || return 0
    if [ "$path" = "$REPO" ] || { [ -n "$CALLER_TOP" ] && [ "$path" = "$CALLER_TOP" ]; }; then
        printf 'kept    %s (selected/current worktree)\n' "$path"
        KEPT=$((KEPT + 1))
        return 0
    fi
    if [ ! -d "$path" ]; then
        printf 'kept    %s (missing path)\n' "$path"
        KEPT=$((KEPT + 1))
        return 0
    fi
    if [ -z "$branchref" ]; then
        printf 'kept    %s (detached HEAD)\n' "$path"
        KEPT=$((KEPT + 1))
        return 0
    fi
    branch="${branchref#refs/heads/}"
    if [ -n "$(git -C "$path" status --porcelain --untracked-files=all 2>/dev/null)" ]; then
        printf 'kept    %s (%s is dirty)\n' "$path" "$branch"
        KEPT=$((KEPT + 1))
        return 0
    fi
    head="$(git -C "$path" rev-parse HEAD 2>/dev/null)" || {
        printf 'error   %s (cannot resolve HEAD)\n' "$path" >&2
        ERRORS=$((ERRORS + 1))
        return 0
    }
    if ! prs="$(cd "$path" && gh pr list --repo "$GH_REPO" --state merged --head "$branch" \
        --json number,mergedAt,url,headRefOid --limit 100 2>/dev/null)"; then
        printf 'error   %s (%s: GitHub query failed)\n' "$path" "$branch" >&2
        ERRORS=$((ERRORS + 1))
        return 0
    fi
    match="$(jq -c --arg head "$head" --argjson cutoff "$CUTOFF" '
        [.[] | select(.headRefOid == $head)
             | select((.mergedAt | fromdateiso8601) <= $cutoff)]
        | sort_by(.mergedAt) | last // empty
    ' <<<"$prs" 2>/dev/null)"
    if [ -z "$match" ]; then
        printf 'kept    %s (%s has no exact merged PR at least %s days old)\n' "$path" "$branch" "$DAYS"
        KEPT=$((KEPT + 1))
        return 0
    fi
    number="$(jq -r '.number' <<<"$match")"
    merged_at="$(jq -r '.mergedAt' <<<"$match")"
    url="$(jq -r '.url' <<<"$match")"
    if [ "$DRY_RUN" -eq 1 ]; then
        printf 'would-remove %s (%s, PR #%s merged %s, %s)\n' "$path" "$branch" "$number" "$merged_at" "$url"
        return 0
    fi
    if git -C "$REPO" worktree remove "$path"; then
        printf 'removed %s (%s, PR #%s merged %s)\n' "$path" "$branch" "$number" "$merged_at"
        REMOVED=$((REMOVED + 1))
    else
        printf 'error   %s (%s changed or removal was refused)\n' "$path" "$branch" >&2
        ERRORS=$((ERRORS + 1))
    fi
}

main() {
    parse_args "$@"
    CALLER_TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    REPO="${REPO:-.}"
    REPO="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)" || {
        printf 'not a git repository: %s\n' "$REPO" >&2
        exit 2
    }
    local common line path="" branchref=""
    common="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)" || exit 2
    PRIMARY="$(dirname "$common")"

    command -v gh >/dev/null 2>&1 || { printf 'required command not found: gh\n' >&2; exit 2; }
    command -v jq >/dev/null 2>&1 || { printf 'required command not found: jq\n' >&2; exit 2; }
    (cd "$REPO" && gh auth status >/dev/null 2>&1) || { printf 'GitHub CLI is not authenticated\n' >&2; exit 2; }
    GH_REPO="$(cd "$REPO" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || {
        printf 'cannot resolve GitHub repository\n' >&2
        exit 2
    }
    [ -n "$GH_REPO" ] || { printf 'cannot resolve GitHub repository\n' >&2; exit 2; }
    CUTOFF=$(( $(date +%s) - DAYS * 86400 ))

    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            worktree\ *)
                if [ -n "$path" ]; then process_worktree "$path" "$branchref"; fi
                path="${line#worktree }"
                branchref=""
                ;;
            branch\ *) branchref="${line#branch }" ;;
            '')
                if [ -n "$path" ]; then process_worktree "$path" "$branchref"; fi
                path=""
                branchref=""
                ;;
        esac
    done < <(git -C "$REPO" worktree list --porcelain)
    if [ -n "$path" ]; then process_worktree "$path" "$branchref"; fi

    printf 'summary: removed=%s kept=%s errors=%s%s\n' \
        "$REMOVED" "$KEPT" "$ERRORS" "$([ "$DRY_RUN" -eq 1 ] && printf ' dry-run' || true)"
    [ "$ERRORS" -eq 0 ]
}

if [ -z "${_WORKTREE_CLEANUP_SOURCE_ONLY:-}" ]; then
    main "$@"
fi

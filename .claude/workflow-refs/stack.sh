#!/usr/bin/env bash
# Start, stop and list the local app stack that /qa and /vf launch.
#
# Every process started through `start` carries CLAUDE_STACK_TAG=<tag> and
# CLAUDE_STACK_NAME=<name> in its environment. Children inherit both, so `stop`
# finds the whole stack (API, workers, their prefork children, an embedded
# scheduler, the UI) by scanning process environments, even after the launching
# shell is gone and they have been re-parented to init/systemd. A pidfile only
# covers the one process it names; that is how orphaned worker sets piled up.
#
# Usage:
#   stack.sh tag                              # default tag: this worktree's absolute git dir
#   stack.sh start <tag> <name> <log> <cmd>   # run <cmd> (one string, via bash -c) in the background
#   stack.sh stop <tag> [timeout-seconds]     # TERM every tagged process, KILL leftovers after timeout
#   stack.sh status <tag>                     # list tagged processes
#
# `start` refuses (exit 3) when a process with the same tag and name is already
# running, so re-running a start step can never create a second copy.
set -euo pipefail

TAG_VAR=CLAUDE_STACK_TAG
NAME_VAR=CLAUDE_STACK_NAME

die() { echo "stack.sh: $*" >&2; exit 2; }

default_tag() {
  git rev-parse --absolute-git-dir 2>/dev/null || pwd -P
}

# Print "<pid> <name>" for every live process carrying the tag (excluding this script).
tagged() {
  local tag=$1 pid env name
  if [ -d /proc/self ]; then
    # environ is NUL-separated: -z makes each variable a record, -x matches it whole.
    # Unreadable (other users') or vanished processes are skipped via 2>/dev/null.
    { grep -lzxF "$TAG_VAR=$tag" /proc/[0-9]*/environ 2>/dev/null || true; } | while read -r env; do
      pid=${env#/proc/}; pid=${pid%/environ}
      [ "$pid" = "$$" ] && continue
      name=$(grep -az "^$NAME_VAR=" "$env" 2>/dev/null | tr -d '\0' | cut -d= -f2-) || true
      echo "$pid ${name:--}"
    done
  else
    # macOS: `ps -E` appends the environment to the command column.
    { ps -Aww -E -o pid=,command= | grep -F " $TAG_VAR=$tag " || true; } | while read -r pid rest; do
      [ "$pid" = "$$" ] && continue
      name=$(grep -oE "$NAME_VAR=[^ ]+" <<<"$rest" | head -1 | cut -d= -f2-)
      echo "$pid ${name:--}"
    done
  fi
}

cmd_start() {
  [ $# -ge 4 ] || die "start <tag> <name> <log> <cmd>"
  local tag=$1 name=$2 log=$3 cmd=$4 running pid
  running=$(tagged "$tag" | awk -v n="$name" '$2 == n {print $1}' | tr '\n' ' ')
  if [ -n "$running" ]; then
    echo "stack.sh: '$name' is already running for this stack (pids: $running). Run 'stack.sh stop' first." >&2
    exit 3
  fi
  mkdir -p "$(dirname "$log")"
  local launcher=()
  command -v setsid >/dev/null && launcher=(setsid)
  "${launcher[@]}" nohup env "$TAG_VAR=$tag" "$NAME_VAR=$name" bash -c "$cmd" >"$log" 2>&1 </dev/null &
  pid=$!
  echo "$pid"
}

cmd_stop() {
  [ $# -ge 1 ] || die "stop <tag> [timeout]"
  local tag=$1 timeout=${2:-20} pids waited=0 found
  pids=$(tagged "$tag" | awk '{print $1}')
  if [ -z "$pids" ]; then
    echo "stack.sh: nothing running for $tag"
    return 0
  fi
  found=$(wc -w <<<"$pids")
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  while [ "$waited" -lt "$timeout" ]; do
    pids=$(tagged "$tag" | awk '{print $1}')
    [ -z "$pids" ] && break
    sleep 1; waited=$((waited + 1))
  done
  # Workers can fork replacements while shutting down, so re-scan until clean.
  for _ in 1 2 3; do
    pids=$(tagged "$tag" | awk '{print $1}')
    [ -z "$pids" ] && break
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    sleep 1
  done
  pids=$(tagged "$tag" | awk '{print $1}')
  if [ -n "$pids" ]; then
    echo "stack.sh: still running after KILL: $pids" >&2
    exit 1
  fi
  echo "stack.sh: stopped $found process(es) for $tag"
}

cmd_status() {
  [ $# -ge 1 ] || die "status <tag>"
  local rows
  rows=$(tagged "$1")
  if [ -z "$rows" ]; then
    echo "stack.sh: nothing running for $1"
    return 0
  fi
  while read -r pid name; do
    printf '%-8s %-14s %s\n' "$pid" "$name" "$(ps -o etime=,args= -p "$pid" 2>/dev/null | cut -c1-150)"
  done <<<"$rows"
}

sub=${1:-}; shift || true
case "$sub" in
  tag) default_tag ;;
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  status) cmd_status "$@" ;;
  *) die "usage: stack.sh {tag|start|stop|status} ..." ;;
esac

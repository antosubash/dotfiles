#!/usr/bin/env bash
# Fake app launcher for tests: serves $FAKE_PORT with python's http.server, exits on SIGTERM, optionally fails.
set -u
[ "${FAKE_FAIL:-}" = "1" ] && { echo "boom: dependency missing" >&2; exit 3; }
mkdir -p "${FAKE_WWW:?}"; echo ok > "$FAKE_WWW/index.html"
python3 -m http.server "${FAKE_PORT:?}" --bind 127.0.0.1 --directory "$FAKE_WWW" >/dev/null 2>&1 &
child=$!
trap 'kill $child 2>/dev/null; echo "launcher stopped"; exit 0' TERM INT
wait $child

#!/usr/bin/env bash
# Enforce the 300-line cap on Pi integration source and test files.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIMIT=300
FAIL=0
while IFS= read -r file; do
    lines=$(wc -l < "$ROOT/$file")
    if [ "$lines" -gt "$LIMIT" ]; then
        printf 'FAIL: %s has %d lines (limit %d)\n' "$file" "$lines" "$LIMIT" >&2
        FAIL=1
    fi
done < <(git -C "$ROOT" ls-files 'pi/*.ts' 'pi/*.py' 'scripts/tests/*.ts' 'scripts/tests/*.py')
if [ "$FAIL" -eq 0 ]; then
    printf 'PASS: every Pi source and test file is within %d lines\n' "$LIMIT"
fi
exit "$FAIL"

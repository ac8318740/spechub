#!/usr/bin/env bash
# Runs every tests/test-*.sh suite and reports a combined result.
#
# Run it:  bash tests/run-all.sh
# Exit code is 0 when every suite passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

total_pass=0
total_fail=0
suite_count=0
suite_fail=0

for suite in "$SCRIPT_DIR"/test-*.sh; do
  name="$(basename "$suite")"
  suite_count=$((suite_count + 1))
  echo "=== $name ==="
  out="$(bash "$suite")"
  echo "$out"
  result_line="$(echo "$out" | grep -E '^Result: ' | tail -1)"
  if [ -z "$result_line" ]; then
    echo "FATAL: $name printed no Result line" >&2
    suite_fail=$((suite_fail + 1))
    echo ""
    continue
  fi
  passed="$(echo "$result_line" | sed -E 's/^Result: ([0-9]+) passed, ([0-9]+) failed$/\1/')"
  failed="$(echo "$result_line" | sed -E 's/^Result: ([0-9]+) passed, ([0-9]+) failed$/\2/')"
  total_pass=$((total_pass + passed))
  total_fail=$((total_fail + failed))
  if [ "$failed" -ne 0 ]; then
    suite_fail=$((suite_fail + 1))
  fi
  echo ""
done

echo "----------------------------------------"
printf 'Overall: %d passed, %d failed (%d/%d suites clean)\n' "$total_pass" "$total_fail" "$((suite_count - suite_fail))" "$suite_count"
[ "$total_fail" -eq 0 ] && [ "$suite_fail" -eq 0 ]

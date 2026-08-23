#!/usr/bin/env bash
# Runs every tests/test-*.sh suite and reports a combined result.
#
# Run it:  bash tests/run-all.sh
# Exit code is 0 when every suite passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

total_pass=0
total_fail=0
total_skipped=0
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
  # A suite's Result line is either "Result: N passed, M failed" or, when it
  # skipped checks (e.g. an optional renderer is missing), "Result: N passed,
  # M failed, K skipped". Match both so a trailing skipped count never falls
  # through to the unmatched branch, where sed would echo the line unchanged
  # and hand an unset-variable arithmetic expression to `set -u`.
  if [[ "$result_line" =~ ^Result:\ ([0-9]+)\ passed,\ ([0-9]+)\ failed(,\ ([0-9]+)\ skipped)?$ ]]; then
    passed="${BASH_REMATCH[1]}"
    failed="${BASH_REMATCH[2]}"
    skipped="${BASH_REMATCH[4]:-0}"
  else
    echo "FATAL: $name printed an unparseable Result line: $result_line" >&2
    suite_fail=$((suite_fail + 1))
    echo ""
    continue
  fi
  total_pass=$((total_pass + passed))
  total_fail=$((total_fail + failed))
  total_skipped=$((total_skipped + skipped))
  if [ "$failed" -ne 0 ]; then
    suite_fail=$((suite_fail + 1))
  fi
  echo ""
done

echo "----------------------------------------"
if [ "$total_skipped" -gt 0 ]; then
  printf 'Overall: %d passed, %d failed, %d skipped (%d/%d suites clean)\n' "$total_pass" "$total_fail" "$total_skipped" "$((suite_count - suite_fail))" "$suite_count"
else
  printf 'Overall: %d passed, %d failed (%d/%d suites clean)\n' "$total_pass" "$total_fail" "$((suite_count - suite_fail))" "$suite_count"
fi
[ "$total_fail" -eq 0 ] && [ "$suite_fail" -eq 0 ]

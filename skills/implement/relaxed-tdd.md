# Relaxed TDD

This file holds what changes in step 5 of `SKILL.md` when
`spechub/project.yaml` sets `workflow.tdd.strict: false`. Read it only then.

`workflow.tdd.strict: false`, relaxed TDD, runs step 2 before step 1. It
skips nothing. Relaxed TDD means nobody writes the tests first, and the
first three subagents still run.

The frontend-verifier's gate is the same under either setting.

The format step stays immediately before the checker, so under relaxed
it formats the new tests as well.

Relaxed costs the test-writer some of its independence, and you state that
cost rather than hide it. The implementation already sits in the working
tree when the test-writer runs. Tell it to write the tests from the node's
requirements, and to leave the implementation unread.

Under strict there is no implementation for it to read, which is the
stronger guarantee.

The checker's gate moves with the setting. Under `true` the new tests failed
before the executor and pass after it.

Under `false` nothing can show them failing without the implementation. The
checker then holds the new tests to existing and passing. It holds the full
suite to passing, and the test count to not dropping.

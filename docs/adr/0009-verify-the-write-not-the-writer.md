# The config writer verifies its result instead of predicting it

`spechub config set` writes a key into `spechub/project.yaml` by splicing the
new value over the old value's bytes, so a hand-edited file keeps its comments
and its spacing. Before writing, it parses what it built and compares that data
against what the YAML document interface would have produced. The two must
agree, or the write falls back to the document interface.

The comparison covers the whole file, not the key that changed.

## Considered options

The first version predicted safety with guards on the node it was replacing.
Three rounds of that shipped four ways to corrupt a user's file, each behind a
green success message and exit code 0.

A folded or literal block scalar's byte range runs past its trailing newline,
so the splice ate the line break and destroyed the following key. An existing
empty value has a zero-width range, so the write produced `test:npm test`. A
new value spanning lines landed at column zero. A scalar inside a flow
collection passed every guard, and a value holding a comma truncated the key
and invented a second one beside it.

Each guard was correct. Each author read the node and not the context around
it. A user would have found the fifth shape.

## Consequences

The writer costs one extra parse per write, which nobody running a command by
hand will notice.

A key-only comparison passes every test in the suite and every input a 2020
case sweep could reach. The writer compares the whole file anyway. Narrowing it
means arguing about shapes nobody has constructed yet, and that argument has
already been wrong four times.

Do not narrow it to the changed key on the grounds that no test covers the
difference. No test can.

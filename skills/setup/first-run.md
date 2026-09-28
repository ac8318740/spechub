# Setup: first run

`SKILL.md` decides when to read this file: Step 2 found no `spechub/project.yaml`, so the first-run path runs Steps 3 to 6 from here.

The file keeps its schema on both paths, so nothing migrates. `docs/config-reference.md`
lists every key it can hold.

## Step 3: Detect the project type and propose defaults

Scan the project root for `pyproject.toml`, `package.json`, `go.mod` and
`Cargo.toml`. If the root gives nothing away, infer the type from `$ARGUMENTS`.
Read the matching profile from the plugin's `profiles/` directory.

Show a summary:

```
Profile:      [detected]
Directories:  src/, tests/
Commands:     [from profile]
Frontend:     [if applicable]
Workflow:     strict TDD, strict orchestrator, spec sync on, grilling via question tool
```

## Step 4: Ask what to customise

Call AskUserQuestion with EXACTLY this JSON. It holds two questions in one call:

```json
{
  "questions": [
    {
      "question": "Customize project setup? Select items to change, or skip to keep defaults.",
      "header": "Setup",
      "multiSelect": true,
      "options": [
        {"label": "Profile & paths", "description": "Change language/framework, source dir, test dir"},
        {"label": "Commands", "description": "Adjust test, build, lint, typecheck, format commands"},
        {"label": "Frontend", "description": "Change directory, dev server, commands"}
      ]
    },
    {
      "question": "Customize workflow? Select items to change, or skip to keep defaults.",
      "header": "Workflow",
      "multiSelect": true,
      "options": [
        {"label": "Grilling", "description": "How grilling asks its questions – a question tool (default) or plain prose"},
        {"label": "TDD strictness", "description": "Relaxed writes the tests after the code; all three phases still run"},
        {"label": "Orchestrator", "description": "Allow direct code work instead of subagent delegation"},
        {"label": "Spec sync", "description": "Disable automatic spec sync on commit"}
      ]
    }
  ]
}
```

Read `answers["0"]` as the setup selections and `answers["1"]` as the workflow
selections. An empty selection means the defaults stand.

## Step 5: Customise the selected sections

Ask one follow-up question at a time through AskUserQuestion. Skip every item the
user did not select.

- **Profile & paths** – ask the language or framework, then the source and test
  directories.

- **Commands** – show the proposed commands and ask what to adjust.
- **Frontend** – show the proposed frontend settings and ask what to adjust.
- **Grilling** – ask `tool`, the host's question tool, against `inline` prose.
  Recommend `tool`. It writes `workflow.grilling.questions`.

- **TDD strictness** – ask strict against relaxed, and write
  `workflow.tdd.strict`.

    Strict runs the test-writer first, so the tests exist before the code.
    Relaxed runs the task-executor first and the test-writer after it. Relaxed
    drops no phase, and all three agents run under both.

    Recommend strict, because the relaxed test-writer works beside an
    implementation it must not read.

- **Orchestrator** – ask strict against relaxed.
- **Spec sync** – ask enabled against disabled.
- **Python venv** – ask the activation command. Ask it only for a Python profile.

Leave the whole `frontend.browser` block out here. Step 10 owns it, and both
paths reach Step 10 through the health check.

## Step 6: Write the config

1. Create the `spechub/` directory.
2. Write `spechub/project.yaml` from the profile and the answers.
3. Leave the project CLAUDE.md alone. The SessionStart hook loads the
   orchestrator instructions.

4. Remove a legacy `@import` line from the project CLAUDE.md, if one is there.
   It points at `.../plugins/cache/ac8318740-plugins/spechub/<version>/CLAUDE.md`.

Then go to Step 7. Everything a fresh project still lacks shows up there as a
failing row.

## What Steps 7 and 8 show after a first run

A `no-project` row means Step 6 wrote no config. Go back to Step 3 and write it.

On a first run the menu carries several rows, and only one of them failed. A
fresh project has no domain map, so `domain-map` fails. It selects no output
style, so `output-style` reports `info`.

A fresh project that configures a frontend adds `preferred-browser-mode` and
`frontend-verification`, both `info` as well, because it has named no browser
mode and turned no verification on.

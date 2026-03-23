---
name: init
description: Initialize SpecHub in a project. Detects project type, proposes smart defaults, lets you customize specific sections. Run this first in any new project.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## How This Works

1. Detect project type and propose defaults
2. Show the user a summary of all defaults
3. Ask which sections to customize (multi-select)
4. Walk through ONLY the selected sections one at a time
5. Write the config and report

## Step 1: Detect and Propose Defaults

Scan the project root for indicators:

- `pyproject.toml` or `setup.py` or `requirements.txt` → Python
- `package.json` with TypeScript → Node/TypeScript
- Both Python AND frontend `package.json` → Fullstack Python
- `go.mod` → Go, `Cargo.toml` → Rust
- Empty project → infer from `$ARGUMENTS` or ask

Read the matching profile from the plugin's `profiles/` directory. Detect tooling (test runner, linter, formatter, framework). Build the full proposed config from defaults.

## Step 2: Present Defaults and Ask What to Customize

Show a clean summary of ALL proposed defaults, then use **AskUserQuestion** to ask which sections to customize.

The summary should look like:

```
Here are the proposed defaults for your project:

1. Profile:      Node/TypeScript
2. Directories:  src/ (source), tests/ (tests)
3. Commands:     npm test, npm run build, eslint, tsc, prettier
4. Frontend:     directory: ./, dev: localhost:3000, React
5. Workflow tier: feature (tasks + TDD pipeline)
6. TDD:          strict (test-first)
7. Orchestrator: strict (delegates to subagents)
8. Spec sync:    enabled (auto-update specs on commit)
9. Playwright:   install for frontend verification
```

**AskUserQuestion:** "Which sections do you want to customize? Everything else keeps the defaults shown above."

Options should include each section as a selectable option, plus:
- "All good – use all defaults" (recommended)
- Each numbered section as an option (e.g., "1. Profile", "2. Directories", etc.)

**STOP HERE. Wait for the user's answer.**

## Step 3: Customize Selected Sections

For each section the user selected, ask ONE question at a time using **AskUserQuestion**. Skip sections the user didn't select – those keep defaults.

**CRITICAL: Ask one question per turn. STOP and wait for the answer before asking the next question.**

### If "Profile" selected:

**AskUserQuestion:** "What language/framework?"

Options: Python, Node/TypeScript, Fullstack Python, Go, Rust, Other

**STOP. Wait for answer.** Then re-read the matching profile.

### If "Directories" selected:

**AskUserQuestion:** "Source and test directories?"

Show current defaults. Options: "Use defaults", "Let me specify"

**STOP. Wait for answer.**

### If "Commands" selected:

**AskUserQuestion:** "Adjust any commands?"

Show the proposed commands as a list (test, build, lint, typecheck, format). Options: "Use these", "Let me adjust"

**STOP. Wait for answer.**

### If "Frontend" selected:

**AskUserQuestion:** "Frontend settings?"

Show: directory, dev server URL, framework, dev command. Options: "Use these", "Let me adjust"

**STOP. Wait for answer.**

### If "Workflow tier" selected:

**AskUserQuestion:** "Minimum workflow tier?"

| Tier | What it does | Good for |
|------|-------------|----------|
| **patch** | Just implement, spec sync at commit | Scripts, small tools |
| **feature** | Tasks + TDD pipeline | Most projects |
| **project** | Design + tasks + TDD | Complex projects |
| **initiative** | Full proposal → design → tasks → archive | Large systems |

**STOP. Wait for answer.**

### If "TDD" selected:

**AskUserQuestion:** "TDD strictness?"

Options: "Strict – test-first" (recommended), "Relaxed"

**STOP. Wait for answer.**

### If "Orchestrator" selected:

**AskUserQuestion:** "Orchestrator mode?"

Options: "Strict – delegates all code work" (recommended), "Relaxed – can code directly"

**STOP. Wait for answer.**

### If "Spec sync" selected:

**AskUserQuestion:** "Enable spec sync on commit?"

Options: "Yes" (recommended), "No"

**STOP. Wait for answer.**

### If "Playwright" selected (only if frontend configured):

**AskUserQuestion:** "Install Playwright for frontend verification?"

Options: "Yes", "No, skip for now"

**STOP. Wait for answer.**

### Python venv (ask automatically for Python projects, no selection needed):

**AskUserQuestion:** "Virtual environment activation command?"

Options: "`source .venv/bin/activate`", "Different path", "No venv"

**STOP. Wait for answer.**

## Step 4: Write Everything

### Write Configuration

1. Create `spechub/` directory if it doesn't exist
2. Assemble `spechub/project.yaml` from defaults + customizations
3. Run `spechub init` if not already initialized

### Add SpecHub to CLAUDE.md

1. Determine the absolute path to the spechub plugin's CLAUDE.md
2. If project CLAUDE.md exists: prepend `@import` if not already present
3. If it doesn't exist: create it with the import line
4. Import: `@<absolute-path-to-spechub-plugin>/CLAUDE.md`
5. If spec sync enabled, add:
   ```
   **MANDATORY: Every commit that changes source code MUST run spec sync before completing. This is non-negotiable. Plan for it at the start of every task and execute it as the final step before the commit is created. See the spechub orchestrator instructions for details.**
   ```

### Install Playwright (if enabled)

1. `npm init playwright@latest`
2. `npx playwright install chromium`
3. Scaffold helpers via `/spechub:playwright-helpers`
4. Set `frontend.helpers_dir` in project.yaml

### Test Baseline (if tests exist)

**AskUserQuestion:** "Set up test baseline?"

Options: "Yes", "No"

### Report

```
## SpecHub Initialized

Profile:      [profile]
Source:       [source dir]
Tests:        [tests dir]
Workflow:     [tier] (auto-select on)
TDD:          [strict/relaxed]
Orchestrator: [strict/relaxed]
Spec sync:    [enabled/disabled]
Frontend:     [verified/not configured]
Config:       spechub/project.yaml
CLAUDE.md:    import added

Next: describe what you want to build, or run /spechub:bootstrap for existing code.
```

## project.yaml Schema Reference

```yaml
profile: node-typescript

workflow:
  default_tier: feature
  auto_select: true
  spec_sync: true
  tdd:
    strict: true
    orchestrator_strict: true
  frontend_verification: true

commands:
  test: "npm test"
  test_collect: null
  build: "npm run build"
  lint: "npm run lint -- --fix"
  typecheck: "npx tsc --noEmit"
  format: "npx prettier --write ."

directories:
  source: "src/"
  tests: "tests/"

test_markers:
  exclude: null

venv:
  activate: null

frontend:
  directory: "frontend/"
  dev_server_url: "http://localhost:3000"
  dev_server_check: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
  helpers_dir: "frontend/tests/helpers/"
  commands:
    build: "npx tsc --noEmit"
    lint: "npm run lint -- --fix"
    test: "npm test"
    dev: "npm run dev"
  framework: "react"
```

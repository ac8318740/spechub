---
name: init
description: Initialize SpecHub in a project. Walks through project setup step by step – language, commands, directories, workflow preferences. Run this first in any new project.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## What This Skill Does

Sets up SpecHub in the current project through a guided, step-by-step configuration flow. Each section is presented as its own question – never dump the whole config at once.

## Interactive Setup Flow

Walk through each section below **one question at a time**. Use **AskUserQuestion** for each step. Always provide a recommended default based on detection.

### Step 1: Language and Framework

Scan the project root for indicators:

- `pyproject.toml` or `setup.py` or `requirements.txt` → Python
- `package.json` with TypeScript → Node/TypeScript
- Both Python AND frontend `package.json` → Fullstack Python
- `go.mod` → Go
- `Cargo.toml` → Rust
- Empty project → ask the user

If `$ARGUMENTS` specifies a profile, use that instead.

**Ask:** "What language/framework is this project?"

Options: detected language (recommended), other common options, "Other (I'll specify)"

Read the matching profile from the plugin's `profiles/` directory as the starting template.

### Step 2: Source and Test Directories

Detect from existing files, or use profile defaults.

**Ask:** "Where does source code live, and where should tests go?"

Show detected/default values:
- Source: `src/` (or detected path)
- Tests: `tests/` (or detected path)

Options: "Use these defaults", "Let me specify"

### Step 3: Commands

Based on the profile and detected tooling (test runner, linter, formatter, build tool), propose commands.

**Ask for each command group separately if non-obvious**, or present them together if the profile is a clean match:

- **Test**: e.g., `pytest tests/ --tb=short -x` or `npx vitest run`
- **Build**: e.g., `npm run build` or `null`
- **Lint**: e.g., `ruff check --fix` or `npx next lint --fix`
- **Typecheck**: e.g., `mypy .` or `npx tsc --noEmit`
- **Format**: e.g., `ruff format` or `npx prettier --write .`

**Ask:** "Here are the proposed commands based on [profile]. Adjust any?"

Show as a clean list. Options: "Use these", "Let me adjust (I'll give feedback)"

### Step 4: Frontend Configuration

If frontend detected (or project type implies it):

**Ask:** "Frontend detected. Confirm these settings?"

- Directory: `frontend/` (or `.` for Next.js)
- Dev server URL: `http://localhost:3000`
- Framework: React/Vue/etc.
- Dev command: `npm run dev` / `npx next dev`

Options: "Use these", "Let me adjust"

If no frontend detected, skip this step.

### Step 5: Virtual Environment (Python only)

If Python project:

**Ask:** "Use a virtual environment? If so, what's the activation command?"

Options: "`source .venv/bin/activate`" (recommended), "Different path", "No venv"

### Step 6: Workflow – Default Tier

**Ask:** "What's the minimum workflow tier for this project?"

| Tier | What it does | Good for |
|------|-------------|----------|
| **patch** | Just implement, spec sync at commit | Scripts, small tools |
| **feature** (recommended) | Tasks + TDD pipeline | Most projects |
| **project** | Design + tasks + TDD | Complex projects |
| **initiative** | Full proposal → design → tasks → archive | Large systems |

Options: "patch", "feature" (recommended), "project", "initiative"

### Step 7: Workflow – TDD Strictness

**Ask:** "Require test-first TDD for feature-tier work and above?"

- **Yes (recommended)** – test-writer runs before task-executor. Tests must fail first.
- **No** – TDD pipeline still runs but test-first order is relaxed.

### Step 8: Workflow – Orchestrator Mode

**Ask:** "Should the orchestrator delegate all code work to subagents?"

- **Yes (recommended for larger projects)** – You coordinate, subagents implement. Prevents context overload.
- **No** – Orchestrator can read/write code directly for small tasks. TDD pipeline still applies.

### Step 9: Workflow – Spec Sync

**Ask:** "Enable automatic spec sync on commit? This keeps living specs in sync with code changes."

- **Yes (recommended)** – Every commit that changes source code updates living specs automatically.
- **No** – Specs only update when you run `/spechub:sync` manually.

### Step 10: Frontend Verification (if frontend)

If frontend was configured in Step 4:

**Ask:** "Enable Playwright-based frontend verification? This takes screenshots and verifies UI changes automatically."

- **Yes** – Install Playwright and scaffold helper library.
- **No** – Skip for now. Can add later with `/spechub:playwright-helpers`.

## After All Questions

### Write Configuration

1. Create `spechub/` directory if it doesn't exist
2. Assemble `spechub/project.yaml` from all answers
3. Run `spechub init` if `spechub/` wasn't already initialized

### Add SpecHub to CLAUDE.md

1. Determine the absolute path to the spechub plugin's CLAUDE.md. Use `${CLAUDE_PLUGIN_ROOT}` if available, otherwise resolve the path from the plugin directory.

2. Check if the project has a CLAUDE.md at the project root:
   - If it exists: check for existing `@` import. If not present, prepend it.
   - If it doesn't exist: create it with the import line.

3. The import line:
   ```
   @<absolute-path-to-spechub-plugin>/CLAUDE.md
   ```

4. If spec sync is enabled, also add:
   ```
   **MANDATORY: Every commit that changes source code MUST run spec sync before completing. This is non-negotiable. Plan for it at the start of every task and execute it as the final step before the commit is created. See the spechub orchestrator instructions for details.**
   ```

### Install Playwright (if enabled)

If frontend verification was enabled in Step 10:

1. Run `npm init playwright@latest` (or `npx playwright install` if partially set up)
2. Install browser binaries: `npx playwright install chromium`
3. Scaffold helper library via `/spechub:playwright-helpers`
4. Set `frontend.helpers_dir` in project.yaml

### Set Up Test Baseline

If tests exist and a test command is configured:

**Ask:** "Set up test baseline? This tracks minimum test count to prevent test deletion."

If yes: run the test collect command, write count to `.test-baseline`.

### Report

Show a summary of everything configured:

```
## SpecHub Initialized

Profile:      node-typescript
Source:       src/
Tests:        tests/
Workflow:     feature tier (auto-select on)
TDD:          strict
Orchestrator: strict
Spec sync:    enabled
Frontend:     verified (Playwright)
Config:       spechub/project.yaml
CLAUDE.md:    import added

Next: describe what you want to build, or run /spechub:bootstrap for existing code.
```

## project.yaml Schema

```yaml
# Generated by /spechub:init
profile: python  # or node-typescript, fullstack-python, etc.

workflow:
  default_tier: feature          # patch/feature/project/initiative
  auto_select: true              # let orchestrator pick above minimum
  spec_sync: true                # mandatory spec sync at commit time
  tdd:
    strict: true                 # require TDD pipeline for feature+
    orchestrator_strict: true    # orchestrator delegates all code work
  frontend_verification: true    # require Phase 4 when frontend files change

commands:
  test: "pytest tests/ --tb=short -x"
  test_collect: "pytest tests/ --co -q 2>/dev/null | tail -1 | grep -oP '\\d+'"
  build: null
  lint: "ruff check --fix"
  typecheck: "mypy ."
  format: "ruff format"

directories:
  source: "src/"
  tests: "tests/"

test_markers:
  exclude: "slow,integration"

venv:
  activate: "source .venv/bin/activate"

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

## Key Rules

- **One question at a time.** Never dump the whole config and ask "looks good?"
- **Always show a recommended default.** The user should be able to accept defaults quickly.
- **Skip irrelevant steps.** No venv question for Node projects. No frontend steps if no frontend.
- **Detect before asking.** If you can figure it out from files, propose it – don't make the user type it.

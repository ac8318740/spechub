---
name: init
description: Initialize SpecHub in a project. Detects project type, generates spechub/project.yaml with build/test/lint commands and workflow config, and sets up SpecHub. Run this first in any new project.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## What This Skill Does

Sets up SpecHub in the current project by:
1. Detecting the project type and language
2. Generating `spechub/project.yaml` with the correct commands and workflow settings
3. Running `spechub init` if not already initialized
4. Adding the SpecHub `@import` line to the project's CLAUDE.md
5. Optionally enabling spec sync and setting up `.test-baseline`

## Steps

### 1. Detect Project Type

Scan the project root for:

- `pyproject.toml` or `setup.py` or `requirements.txt` -> Python
- `package.json` with TypeScript in dependencies -> Node/TypeScript
- Both Python AND a frontend directory with `package.json` -> Fullstack Python
- `go.mod` -> Go
- `Cargo.toml` -> Rust

If `$ARGUMENTS` specifies a profile (e.g., "python", "node-typescript", "fullstack-python"), use that instead of auto-detection.

### 2. Check for Frontend

Look for frontend indicators:
- `frontend/` or `client/` or `web/` directory with its own `package.json`
- React/Vue/Svelte/Next.js in dependencies
- `src/app/` or `src/pages/` directory (Next.js/Remix patterns)

If frontend detected, note the:
- Frontend directory path
- Dev server URL (default: http://localhost:3000)
- Framework (React, Vue, etc.)

### 3. Present Configuration

Read the matching profile from the plugin's `profiles/` directory and customize based on detection:

- Adjust paths if source code isn't in `src/` (e.g., `lib/`, `app/`)
- Adjust test directory if not `tests/` (e.g., `__tests__/`, `test/`)
- Detect test runner (pytest, vitest, jest, mocha)
- Detect linter (ruff, eslint, biome)
- Detect formatter (ruff format, prettier, biome)

Present the proposed `spechub/project.yaml` to the user for review using **AskUserQuestion**:

"Here's the proposed project configuration. Approve or provide feedback?"

Options: "Looks good, write it", "Let me adjust (I'll give feedback)"

### 4. Write Configuration

Once approved:

1. Create `spechub/` directory if it doesn't exist
2. Write `spechub/project.yaml`
3. Run `spechub init` if `spechub/` wasn't already initialized

### 5. Add SpecHub to CLAUDE.md

The orchestrator instructions live in the spechub plugin's `CLAUDE.md`. To activate them, add an `@import` line to the project's CLAUDE.md.

1. Determine the absolute path to the spechub plugin's CLAUDE.md. Use `${CLAUDE_PLUGIN_ROOT}` if available, otherwise resolve the path from the plugin directory.

2. Check if the project has a CLAUDE.md at the project root:
   - If it exists: read it and check if it already contains an `@` import pointing to spechub's CLAUDE.md. If not, prepend the import line.
   - If it doesn't exist: create it with the import line.

3. The import line should be:
   ```
   @<absolute-path-to-spechub-plugin>/CLAUDE.md
   ```

4. If spec sync is enabled (Step 6a), also add this mandatory instruction after the import:

   ```
   **MANDATORY: Every commit that changes source code MUST run spec sync before completing. This is non-negotiable. Plan for it at the start of every task and execute it as the final step before the commit is created. See the spechub orchestrator instructions for details.**
   ```

5. Show the user what was added and where. Explain that this single line loads the orchestrator instructions (TDD pipeline, delegation pattern, quality gates, etc.) and that removing it disables the orchestrator without uninstalling the plugin.

### 6. Workflow Configuration

Ask the user about workflow preferences:

#### 6a. Spec Sync

"Enable automatic spec sync on commit? This keeps living specs in sync with code changes automatically. (Recommended)"

Options: "Yes, enable it", "No, skip"

If yes: set `workflow.spec_sync: true` in project.yaml.

#### 6b. Default Workflow Tier

"What's the minimum workflow tier for this project?"

| Tier | What it does | Good for |
|------|-------------|----------|
| **patch** (lightest) | Just implement, spec sync at commit | Small projects, scripts |
| **feature** (default) | Tasks + TDD pipeline | Most projects |
| **project** | Design + tasks + TDD | Complex projects |
| **initiative** | Full proposal → design → tasks → archive | Large systems |

Default to `feature` if the user doesn't pick.

#### 6c. TDD Strictness

"Require strict TDD (test-first) for feature tier and above? (Recommended)"

Options: "Yes, strict TDD", "No, relaxed"

#### 6d. Orchestrator Strictness

"Require the orchestrator to delegate all code work to subagents? (Recommended for larger projects)"

Options: "Yes, strict orchestrator", "No, allow direct code work"

### 7. Install Playwright (Optional)

If the project has a frontend (detected in Step 2), ask the user:

"Install Playwright for frontend visual verification? This lets SpecHub take screenshots and verify UI changes automatically. Recommended for projects with a frontend."

Options: "Yes, install it", "No, skip"

If yes:
1. Run `npm init playwright@latest` (or `npx playwright install` if already partially set up)
2. Install browser binaries: `npx playwright install chromium`
3. Scaffold the helper library using `/spechub:playwright-helpers`:
   - Create `<frontend.directory>/tests/helpers/` (or the path from project.yaml)
   - Generate `verify-helpers.js` with project-specific `DEV_URL`
   - Generate `VERIFICATION-KNOWLEDGE.md` empty template
   - Generate TypeScript helper stubs (navigation, components, assertions, screenshots)
4. Set `frontend.helpers_dir` in `spechub/project.yaml`
5. Note in the report that Playwright and helper library are configured

If no:
- Frontend visual verification will FAIL when UI files change (there is no LOW CONFIDENCE mode)
- The user can install later with `npx playwright install` and run `/spechub:playwright-helpers`

### 8. Set Up Test Baseline

Ask the user: "Set up test baseline? This tracks minimum test count to prevent test deletion."

If yes:
1. Run the test collect command
2. Write the count to `.test-baseline`

### 9. Report

- Path to `spechub/project.yaml`
- Profile used
- Commands configured
- Workflow tier: default tier, auto-select enabled/disabled
- Whether spec sync is enabled
- Whether TDD is strict
- Whether frontend visual verification is enabled
- CLAUDE.md import added (path shown)
- Next steps: run `/spechub:bootstrap` to generate initial living specs, or start building with `/spechub:propose`

## project.yaml Schema

```yaml
# Generated by /spechub:init
profile: python  # or node-typescript, fullstack-python, etc.

workflow:
  default_tier: feature          # minimum tier for all work (patch/feature/project/initiative)
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

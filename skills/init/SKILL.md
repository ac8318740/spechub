---
name: init
description: Initialize SpecHub in a project. Walks through project setup step by step – language, commands, directories, workflow preferences. Run this first in any new project.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## CRITICAL INSTRUCTION

**This is a multi-turn interactive setup. You MUST ask ONE question at a time and STOP to wait for the user's answer before proceeding to the next question. Do NOT present the full config. Do NOT batch questions. Do NOT skip ahead. Each step below is a separate conversation turn.**

**FORBIDDEN: Generating a complete project.yaml and asking "looks good?" That defeats the purpose of this skill. If you do this, you have failed.**

## How This Works

1. Detect what you can from the project files
2. Ask question 1 → STOP → wait for answer
3. Ask question 2 → STOP → wait for answer
4. Continue until all questions are answered
5. Write the config and report

## Question Sequence

### Q1: Language and Framework

Scan the project root for: `pyproject.toml`, `setup.py`, `requirements.txt` (Python), `package.json` with TypeScript (Node/TS), `go.mod` (Go), `Cargo.toml` (Rust). If `$ARGUMENTS` specifies a profile, use that.

Use **AskUserQuestion**: "What language/framework is this project?"

Provide options based on detection. If empty project, list common choices. Include a recommended option.

**STOP HERE. Wait for the user's answer. Do not proceed to Q2 until you have it.**

After the user answers, read the matching profile from the plugin's `profiles/` directory.

### Q2: Source and Test Directories

Use **AskUserQuestion**: "Where should source code and tests live?"

Show the profile defaults (e.g., `src/` and `tests/`). Options: "Use defaults", "Let me specify".

**STOP HERE. Wait for the user's answer.**

### Q3: Commands

Based on the profile and any detected tooling, propose the commands.

Use **AskUserQuestion**: "Here are the proposed build/test/lint commands. Adjust any?"

Show as a clean list:
- Test: (proposed)
- Build: (proposed)
- Lint: (proposed)
- Typecheck: (proposed)
- Format: (proposed)

Options: "Use these", "Let me adjust"

**STOP HERE. Wait for the user's answer.**

### Q4: Frontend (skip if not applicable)

If the language/framework implies a frontend (Next.js, React, Vue, etc.) or a frontend directory was detected:

Use **AskUserQuestion**: "Frontend settings – confirm or adjust?"

Show:
- Directory: (detected or default)
- Dev server URL: http://localhost:3000
- Framework: (detected)
- Dev command: (proposed)

Options: "Use these", "Let me adjust"

**STOP HERE. Wait for the user's answer.**

Skip this question entirely for backend-only projects.

### Q5: Virtual Environment (Python only, skip otherwise)

Use **AskUserQuestion**: "Virtual environment activation command?"

Options: "`source .venv/bin/activate`" (recommended), "Different path", "No venv"

**STOP HERE. Wait for the user's answer.**

### Q6: Default Workflow Tier

Use **AskUserQuestion**: "What's the minimum workflow tier?"

| Tier | What it does | Good for |
|------|-------------|----------|
| **patch** | Just implement, spec sync at commit | Scripts, small tools |
| **feature** | Tasks + TDD pipeline | Most projects |
| **project** | Design + tasks + TDD | Complex projects |
| **initiative** | Full proposal → design → tasks → archive | Large systems |

Recommend "feature" as default.

**STOP HERE. Wait for the user's answer.**

### Q7: TDD Strictness

Use **AskUserQuestion**: "Require test-first TDD for feature-tier work and above?"

Options: "Yes, strict TDD" (recommended), "No, relaxed"

**STOP HERE. Wait for the user's answer.**

### Q8: Orchestrator Mode

Use **AskUserQuestion**: "Should the orchestrator delegate all code work to subagents?"

Options: "Yes, strict" (recommended for larger projects), "No, allow direct code work"

**STOP HERE. Wait for the user's answer.**

### Q9: Spec Sync

Use **AskUserQuestion**: "Enable automatic spec sync on commit?"

Options: "Yes" (recommended), "No"

**STOP HERE. Wait for the user's answer.**

### Q10: Frontend Verification (skip if no frontend)

Use **AskUserQuestion**: "Enable Playwright-based frontend verification?"

Options: "Yes, install Playwright", "No, skip for now"

**STOP HERE. Wait for the user's answer.**

## After All Questions

### Write Configuration

1. Create `spechub/` directory if it doesn't exist
2. Assemble `spechub/project.yaml` from all answers
3. Run `spechub init` if not already initialized

### Add SpecHub to CLAUDE.md

1. Determine the absolute path to the spechub plugin's CLAUDE.md
2. Check if project CLAUDE.md exists at root:
   - Exists: prepend `@import` if not already present
   - Doesn't exist: create it with the import
3. Import line: `@<absolute-path-to-spechub-plugin>/CLAUDE.md`
4. If spec sync enabled, add mandatory instruction:
   ```
   **MANDATORY: Every commit that changes source code MUST run spec sync before completing. This is non-negotiable. Plan for it at the start of every task and execute it as the final step before the commit is created. See the spechub orchestrator instructions for details.**
   ```

### Install Playwright (if enabled in Q10)

1. Run `npm init playwright@latest`
2. Install chromium: `npx playwright install chromium`
3. Scaffold helpers via `/spechub:playwright-helpers`
4. Set `frontend.helpers_dir` in project.yaml

### Test Baseline (if tests exist)

Use **AskUserQuestion**: "Set up test baseline to prevent test deletion?"

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

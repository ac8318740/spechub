---
name: init
description: Initialize SpecHub in a project. Detects project type, proposes smart defaults, lets you customize specific sections.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Read, Write, Edit, Bash, Glob, Grep
---

## User Input

```text
$ARGUMENTS
```

## Step 1: Detect and Propose Defaults

Scan the project root for `pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, etc. If empty, infer from `$ARGUMENTS`. Read the matching profile from the plugin's `profiles/` directory.

Show a summary:

```
Profile:      [detected]
Directories:  src/, tests/
Commands:     [from profile]
Frontend:     [if applicable]
Workflow:     auto-select on, thorough clarification, strict TDD, strict orchestrator, spec sync on
```

## Step 2: Ask What to Customize

Call AskUserQuestion with EXACTLY this JSON (two questions in one call):

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
        {"label": "Frontend", "description": "Change directory, dev server, framework"}
      ]
    },
    {
      "question": "Customize workflow? Select items to change, or skip to keep defaults.",
      "header": "Workflow",
      "multiSelect": true,
      "options": [
        {"label": "Quick path", "description": "Allow quick path for small changes (default: on)"},
        {"label": "Clarification", "description": "How much to ask before drafting proposals, designs, and tasks"},
        {"label": "TDD strictness", "description": "Switch from strict (test-first) to relaxed"},
        {"label": "Orchestrator", "description": "Allow direct code work instead of subagent delegation"},
        {"label": "Spec sync", "description": "Disable automatic spec sync on commit"}
      ]
    }
  ]
}
```

Parse answers: answers["0"] = Setup selections, answers["1"] = Workflow selections. If nothing selected, use all defaults.

## Step 3: Customize Selected Sections

For each selected item, ask one follow-up question at a time via AskUserQuestion. Skip unselected items.

- **Profile & paths**: Ask language/framework, then source/test dirs
- **Commands**: Show proposed commands, ask to adjust
- **Frontend**: Show frontend settings, ask to adjust
- **Quick path**: Ask if small changes (bug fixes, typos, config tweaks) should skip the full TDD pipeline. Default: yes (auto-select on). If no, all changes go through the full pipeline.
- **Clarification**: Ask 3 questions (one per phase) using AskUserQuestion with up to 4 questions per call. Each question asks the default clarification level for that phase (propose, design, tasks). Options: `none` (never ask), `critical` (only scope/architecture-changing), `thorough` (recommended – ask about anything ambiguous), `exhaustive` (ask about everything). Users can override per-run with flags like `--exhaustive`.
- **TDD strictness**: Ask strict vs relaxed
- **Orchestrator**: Ask strict vs relaxed
- **Spec sync**: Ask enabled vs disabled
- **Python venv** (auto for Python): Ask activation command

## Step 4: Write Config

1. Create `spechub/` directory
2. Write `spechub/project.yaml` from defaults + customizations
3. Add `@import` to project CLAUDE.md pointing to the plugin's CLAUDE.md
4. If spec sync enabled, add mandatory spec sync instruction to CLAUDE.md

## Step 5: Set Up Browser Verification

If the project has a frontend configured:

### 5a. Install agent-browser

```bash
which agent-browser
```

If not found:

```bash
npm install -g agent-browser
```

### 5b. Create agent-browser.json

Write `agent-browser.json` in the project root:

```json
{
  "cdp": "9555"
}
```

### 5c. Create verification knowledge base

Create `<helpers_dir>/VERIFICATION-KNOWLEDGE.md` with the empty template (see browser-helpers skill for the template).

### 5d. Check browser connectivity

```bash
curl -s --max-time 3 http://localhost:9555/json/version
```

Report the result but don't block on it – the browser doesn't need to be connected during init. Just tell the user:

- **JSON response**: "Browser connected – you're ready for frontend verification."
- **Connection refused**: "No browser detected. The frontend-verifier will launch headless Chromium automatically when needed. For a better experience with your real browser, see `/spechub:config check` for setup instructions."

## Step 6: Report

```
## SpecHub Initialized

Profile:      [profile]
Source:       [source dir]
Tests:        [tests dir]
Workflow:     [auto-select on/off]
Clarify:      propose=[level], design=[level], tasks=[level]
TDD:          [strict/relaxed]
Orchestrator: [strict/relaxed]
Spec sync:    [enabled/disabled]
Frontend:     [verified/not configured]
Browser:      [agent-browser installed / not applicable]
Config:       spechub/project.yaml
CLAUDE.md:    import added

Next: describe what you want to build, or run /spechub:bootstrap for existing code.
```

## project.yaml Schema

```yaml
profile: node-typescript

workflow:
  auto_select: true
  spec_sync: true
  clarification:
    propose: thorough    # none | critical | thorough | exhaustive
    design: thorough
    tasks: thorough
  tdd:
    strict: true
    orchestrator_strict: true
  frontend_verification: true

commands:
  test: "npm test"
  build: "npm run build"
  lint: "npm run lint -- --fix"
  typecheck: "npx tsc --noEmit"
  format: "npx prettier --write ."

directories:
  source: "src/"
  tests: "tests/"

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

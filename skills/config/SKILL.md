---
name: config
description: View, modify, or health-check SpecHub project configuration. Use to change workflow settings, check for missing infrastructure, or walk through setup of browser verification and other tools.
argument-hint: "[show | set <key> <value> | reset | check]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## What This Skill Does

Read, modify, or health-check `spechub/project.yaml`. The `check` command is the main addition – it audits the project for missing infrastructure and walks the user through fixing it.

## Commands

### `show` (default if no arguments)

Read `spechub/project.yaml` and display the current configuration:

```
## SpecHub Configuration

Profile:      node-typescript
Source:        src/
Tests:         tests/

Workflow:
  Auto-select:   on (quick path for small changes)
  Spec sync:     enabled
  TDD:           strict
  Orchestrator:  strict (delegates all code work)

Frontend:
  Directory:     frontend/
  Dev server:    http://localhost:3000
  Framework:     react
  Verification:  enabled
  Browser:       agent-browser installed, CDP on 9555

Full config: spechub/project.yaml
```

### `check`

Audit the project for missing infrastructure and offer to fix each issue. Run these checks in order:

#### 1. project.yaml exists

```bash
cat spechub/project.yaml
```

If missing: "No project.yaml found. Run `/spechub:init` to set up."

#### 2. agent-browser (if frontend configured)

```bash
which agent-browser
```

If missing, offer to install:

```
agent-browser is not installed. It's needed for frontend verification.
Install it now? (npm install -g agent-browser)
```

If user agrees, run `npm install -g agent-browser`.

#### 3. agent-browser.json (if frontend configured)

```bash
cat agent-browser.json
```

If missing, offer to create it:

```
No agent-browser.json found in project root. This tells agent-browser which CDP port to use.
Create it now? ({"cdp": "9555"})
```

If user agrees, write the file.

#### 4. Browser connectivity (if frontend configured)

```bash
curl -s --max-time 3 http://localhost:9555/json/version
```

Report status and offer guidance:

- **JSON response**: "Browser connected via CDP on port 9555."
- **Connection refused**: Offer two options via AskUserQuestion:

```json
{
  "question": "No browser detected on CDP port 9555. How do you want to handle frontend verification?",
  "options": [
    {"label": "Headless (automatic)", "description": "The frontend-verifier will launch headless Chromium when needed. No setup required."},
    {"label": "Remote browser (SSH tunnel)", "description": "Connect to Chrome on another machine via SSH tunnel. Best experience – uses your real browser."},
    {"label": "Skip for now", "description": "I'll set this up later."}
  ]
}
```

If "Remote browser" selected, show the setup instructions from the browser-debug reference:

```
To connect your browser via SSH tunnel:

1. On your local machine, launch Chrome with:
   chrome --remote-debugging-port=9555 --user-data-dir=<path> --remote-allow-origins=*

2. Start an SSH reverse tunnel:
   ssh -N -R 9555:127.0.0.1:9555 <user>@<vm-ip>

3. Verify from this VM:
   curl -s http://localhost:9555/json/version

For a one-click setup on Windows, see the browser-debug skill.
```

#### 5. Verification knowledge base (if frontend configured)

```bash
cat <helpers_dir>/VERIFICATION-KNOWLEDGE.md
```

If missing, offer to create it with the empty template.

#### 6. Chromium available (if frontend configured and no remote browser)

Check if headless Chromium can be launched:

```bash
which chromium || which chromium-browser || which google-chrome || which google-chrome-stable
```

If none found: "No Chromium/Chrome binary found. The frontend-verifier needs one to run headless. Install with: `sudo apt install chromium-browser` (Ubuntu/Debian) or `sudo dnf install chromium` (Fedora)."

#### 7. Summary

```
## Config Health Check

✓ project.yaml exists
✓ agent-browser installed
✓ agent-browser.json configured
✓ Browser: connected (remote) | available (headless) | not configured
✓ Verification knowledge base exists
✓ Chromium binary available

[Any items that need attention]
```

### `set <key> <value>`

Modify a setting. Supported keys:

| Key | Values | Description |
|-----|--------|-------------|
| `workflow.auto_select` | `true`, `false` | Allow quick path for small changes |
| `workflow.spec_sync` | `true`, `false` | Mandatory spec sync at commit |
| `workflow.tdd.strict` | `true`, `false` | Require TDD pipeline |
| `workflow.tdd.orchestrator_strict` | `true`, `false` | Orchestrator delegates all code work |
| `workflow.frontend_verification` | `true`, `false` | Require frontend verification |
| `workflow.clarification.propose` | `none`, `critical`, `thorough`, `exhaustive` | Clarification level for proposals |
| `workflow.clarification.design` | `none`, `critical`, `thorough`, `exhaustive` | Clarification level for designs |
| `workflow.clarification.tasks` | `none`, `critical`, `thorough`, `exhaustive` | Clarification level for tasks |

Examples:
- `/spechub:config set workflow.auto_select false`
- `/spechub:config set workflow.tdd.strict false`
- `/spechub:config set workflow.spec_sync false`

### `reset`

Reset all workflow settings to defaults:

```yaml
workflow:
  auto_select: true
  spec_sync: true
  clarification:
    propose: thorough
    design: thorough
    tasks: thorough
  tdd:
    strict: true
    orchestrator_strict: true
  frontend_verification: true
```

## Steps

### 1. Read Current Config

Read `spechub/project.yaml`. If it doesn't exist, tell the user to run `/spechub:init` first.

### 2. Execute Command

- **show**: Display formatted config summary
- **check**: Run health checks, offer fixes interactively
- **set**: Parse the key path, validate the value, update the YAML, write it back
- **reset**: Replace the `workflow` section with defaults, preserve all other sections

### 3. Confirm

After any modification:
1. Write the updated `spechub/project.yaml`
2. Show the changed setting and its new value
3. Note any implications (e.g., "Auto-select is now off – all changes will go through the full TDD pipeline")

## Validation Rules

- Boolean values accept: `true`/`false`, `on`/`off`, `yes`/`no` (normalize to `true`/`false`)
- Clarification levels must be one of: `none`, `critical`, `thorough`, `exhaustive`
- If `workflow` section doesn't exist in project.yaml, create it with defaults before applying changes
- Never modify non-workflow sections of project.yaml (use init for that)

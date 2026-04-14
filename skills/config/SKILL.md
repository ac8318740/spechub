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
  Browser:       remote (SSH tunnel) | headless (auto) | local (display) | not configured
  CDP port:      9555

Full config: spechub/project.yaml
```

#### Prompt for incomplete config

After displaying the config, scan for missing or incomplete settings. If any gaps are found, use AskUserQuestion to offer to fix them. Collect all gaps into a single prompt.

**Gaps to detect** (check in order, skip items that don't apply):

1. **frontend configured but `workflow.frontend_verification` is not `true`** – verification is available but not enabled
2. **frontend configured but `frontend.browser.mode` is not set** – browser environment unknown
3. **frontend configured but `frontend.browser.cdp_port` is not set** – using default 9555 but not explicit
4. **`agent-browser.json` missing** (if frontend configured) – `cat agent-browser.json`
5. **agent-browser CLI not installed** (if frontend configured) – `which agent-browser`
6. **No `frontend.helpers_dir`** (if frontend configured) – verification knowledge base location not set

If gaps are found, show a single AskUserQuestion:

```json
{
  "question": "Some config is incomplete. Want to set these up now?",
  "multiSelect": true,
  "options": [
    {"label": "Enable frontend verification", "description": "Set workflow.frontend_verification to true"},
    {"label": "Set browser mode", "description": "Choose remote (SSH tunnel), headless (auto), or local (display)"},
    {"label": "Set CDP port", "description": "Confirm or change the CDP port (default: 9555)"},
    {"label": "Create agent-browser.json", "description": "CDP config file for agent-browser CLI"},
    {"label": "Install agent-browser", "description": "npm install -g agent-browser"},
    {"label": "Skip", "description": "Leave config as-is"}
  ]
}
```

Only include options for the gaps that actually exist. If no gaps, don't prompt – just show the config.

For each selected item, apply the fix:

- **Enable frontend verification**: set `workflow.frontend_verification: true` in project.yaml
- **Set browser mode**: ask a follow-up AskUserQuestion with remote/headless/local options (same as the `check` command's browser connectivity section). Store in project.yaml and walk through setup if remote is chosen.
- **Set CDP port**: ask for the port number, default 9555. Store in project.yaml and update `agent-browser.json` if it exists.
- **Create agent-browser.json**: write `{"cdp": "<cdp_port>"}` to project root
- **Install agent-browser**: run `npm install -g agent-browser`

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

If "Remote browser" selected, set `frontend.browser.mode: remote` in project.yaml and walk through setup:

```
To connect your browser via SSH tunnel:

1. On the machine with the browser, launch Chrome with remote debugging:

   chrome --remote-debugging-port=9555 --user-data-dir=/tmp/chrome-debug --remote-allow-origins=*

   On Windows:
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9555 --user-data-dir="%TEMP%\chrome-debug" --remote-allow-origins=*

2. Start an SSH reverse tunnel from the browser machine to this dev machine:

   ssh -N -R 9555:127.0.0.1:9555 <user>@<dev-machine-ip>

3. Verify from this machine:

   curl -s http://localhost:9555/json/version
```

**Common gotchas** (show these after the setup steps):

- `--remote-allow-origins=*` is required – without it, Chrome rejects tunnelled CDP connections
- The tunnel must use `127.0.0.1`, not `localhost` – Chrome binds to IPv4 only, and some systems resolve `localhost` to IPv6
- VS Code/Cursor may auto-forward port 9555 and interfere – check the IDE's forwarded ports panel and remove it if so
- If Chrome was closed but background processes remain, the port won't bind – kill all Chrome processes first

If "Headless" selected, set `frontend.browser.mode: headless` in project.yaml. No further setup needed – the frontend-verifier launches Chromium automatically.

If "Skip for now" selected, leave `frontend.browser.mode` unset.

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
✓ Browser: connected (remote) | available (headless) | available (local) | not configured
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
| `frontend.browser.mode` | `remote`, `headless`, `local` | Browser environment for verification |
| `frontend.browser.cdp_port` | number | CDP port (default: 9555) |

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

- **show**: Display formatted config summary, then prompt to fix any gaps
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
- Browser mode must be one of: `remote`, `headless`, `local`
- If `workflow` section doesn't exist in project.yaml, create it with defaults before applying changes
- The `set` command only modifies workflow and frontend.browser sections. For other sections, use init

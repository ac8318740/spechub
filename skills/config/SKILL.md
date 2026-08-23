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
  Spec sync:     enabled
  Grilling:      tool (question tool, inline fallback)
  TDD:           strict
  Orchestrator:  strict (delegates all code work)
  Handoff:       agent=claude, ack_turns=5, self_invoke=true, nudge_warn=200000, nudge_severe=500000, nudge_step=100000

Frontend:
  Directory:     frontend/
  Dev server:    http://localhost:3000
  Framework:     react
  Verification:  enabled
  Browser:       remote (Playwriter bridge) | headless (auto) | local (display) | not configured
  CDP port:      <from project.yaml, default 19988 for remote, 9555 otherwise>

Full config: spechub/project.yaml
```

#### Prompt for incomplete config

After displaying the config, scan for missing or incomplete settings. If any gaps are found, use AskUserQuestion to offer to fix them. Collect all gaps into a single prompt.

**Gaps to detect** (check in order, skip items that don't apply):

1. **frontend configured but `workflow.frontend_verification` is not `true`** – verification is available but not enabled
2. **frontend configured but `frontend.browser.mode` is not set** – browser environment unknown
3. **frontend configured but `frontend.browser.cdp_port` is not set** – default `19988` applies for `mode: remote`, `9555` for `headless`/`local`, but not explicit
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
    {"label": "Set CDP port", "description": "Confirm or change the CDP port (default: 19988 for remote, 9555 otherwise)"},
    {"label": "Create agent-browser.json", "description": "CDP config file for agent-browser CLI"},
    {"label": "Install agent-browser", "description": "npm install -g agent-browser"},
    {"label": "Skip", "description": "Leave config as-is"}
  ]
}
```

Only include options for the gaps that actually exist. If no gaps, don't prompt – just show the config.

For each selected item, apply the fix:

- **Enable frontend verification**: set `workflow.frontend_verification: true` in project.yaml
- **Set browser mode**: ask a follow-up AskUserQuestion with remote/headless/local options (same as the `check` command's browser connectivity section). Store in project.yaml and walk through setup if remote is chosen. If remote, also ask about fallback behavior (headless or none).
- **Set CDP port**: ask for the port number. Default is `19988` when `frontend.browser.mode` is `remote`, otherwise `9555`. Store in project.yaml and update `agent-browser.json` if it exists.
- **Create agent-browser.json**: write `{"cdp": "<cdp_port>"}` to project root, using `frontend.browser.cdp_port` from project.yaml
- **Install agent-browser**: run `npm install -g agent-browser`

### `check`

Audit the project for missing infrastructure and offer to fix each issue. Run these checks in order:

#### 1. project.yaml exists

```bash
cat spechub/project.yaml
```

If missing: "No project.yaml found. Run `/spechub:init` to set up."

#### 2. domain-map.yaml exists

```bash
cat spechub/domain-map.yaml
```

Applies to every project, not just those with a frontend.

If missing, spec sync is silently dead – `/spechub:commit`, `/spechub:archive`, `/spechub:bootstrap` and `/spechub:pre-commit-review` all read this file and skip when it is absent, so living specs never update. Projects initialized before SpecHub generated this file are the common case.

Offer to build it:

```
No spechub/domain-map.yaml found. Without it, spec sync skips every commit
and your living specs never update.
Generate one now by exploring the codebase?
```

If the user agrees, run Step 5 of the `init` skill – explore `directories.source`, propose domains, confirm, write the file.

If `spechub/specs/` already contains domain directories, propose those names first and map paths to them. Renaming a domain here orphans its existing `spec.md`.

#### 3. agent-browser (if frontend configured)

```bash
which agent-browser
```

If missing, offer to install:

```
agent-browser is not installed. It's needed for frontend verification.
Install it now? (npm install -g agent-browser)
```

If user agrees, run `npm install -g agent-browser`.

#### 4. agent-browser.json (if frontend configured)

```bash
cat agent-browser.json
```

If missing, offer to create it:

```
No agent-browser.json found in project root. This tells agent-browser which CDP port to use.
Create it now? ({"cdp": "<frontend.browser.cdp_port from project.yaml>"})
```

If user agrees, write the file. Use `frontend.browser.cdp_port` from project.yaml; if unset, default to `19988` when `frontend.browser.mode` is `remote`, otherwise `9555`.

#### 5. Browser connectivity (if frontend configured)

Read `frontend.browser.cdp_port` from project.yaml (with the mode-aware default above) and use it as `<cdp_port>`:

```bash
curl -s --max-time 3 http://localhost:<cdp_port>/json/version
```

Report status and offer guidance:

- **JSON response**: "Browser connected via CDP on port `<cdp_port>`."
- **Connection refused**: Offer two options via AskUserQuestion:

```json
{
  "question": "No browser detected on the configured CDP port. How do you want to handle frontend verification?",
  "options": [
    {"label": "Headless (automatic)", "description": "The frontend-verifier will launch headless Chromium when needed. No setup required."},
    {"label": "Remote browser (Playwriter bridge)", "description": "Drive Chrome on another machine via the Playwriter extension over SSH. Best experience – uses your real browser."},
    {"label": "Skip for now", "description": "I'll set this up later."}
  ]
}
```

If "Remote browser" selected, set `frontend.browser.mode: remote` and `frontend.browser.cdp_port: 19988` in project.yaml (update `agent-browser.json` to match), then walk through setup. Remote mode uses the Playwriter bridge – Chrome on the browser machine is driven via the Playwriter extension's `chrome.debugger` API. No CDP listener is opened on Chrome itself.

```
To connect your browser via the Playwriter bridge:

1. On the browser machine, install Node 18+ and Playwriter:

   npm install -g playwriter

2. In Chrome on the browser machine (preferably a dedicated profile), install the Playwriter extension and pin it:

   https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe

3. Run two long-running processes on the browser machine:

   Relay:         playwriter serve --host 127.0.0.1
   Reverse tunnel: ssh -N -R 19988:127.0.0.1:19988 <user>@<dev-machine>

4. In Chrome, click the Playwriter toolbar icon on each tab you want automated.

5. Verify from this (dev) machine:

   curl -s http://localhost:19988/json/version
```

**Common gotchas** (show these after the setup steps):

- Port `19988` is hardcoded by Playwriter – it is not configurable.
- The relay must run on the same host as Chrome. The Playwriter extension hard-rejects any `/extension` client that is not `127.0.0.1`.
- Each tab needs the extension icon clicked once. `chrome://` and `about:` pages cannot be attached.
- If port 19988 is busy on the browser machine from a stale relay, run `playwriter serve --host 127.0.0.1 --replace` to kick the previous one.

For a persistent, zero-window Windows laptop setup – auto-reconnecting scheduled tasks, ssh-agent key persistence, one-time admin registration – see `plugins/spechub/docs/playwriter-bridge-windows.md`. It ships the three PowerShell scripts (`relay.ps1`, `tunnel.ps1`, `register-tasks.ps1`) under `plugins/spechub/assets/playwriter-bridge/`.

If "Headless" selected, set `frontend.browser.mode: headless` in project.yaml. No further setup needed – the frontend-verifier launches Chromium automatically.

If "Skip for now" selected, leave `frontend.browser.mode` unset.

#### 6. Verification knowledge base (if frontend configured)

```bash
cat <helpers_dir>/VERIFICATION-KNOWLEDGE.md
```

If missing, offer to create it with the empty template.

#### 7. Chromium available (if frontend configured and no remote browser)

Check if headless Chromium can be launched:

```bash
which chromium || which chromium-browser || which google-chrome || which google-chrome-stable
```

If none found: "No Chromium/Chrome binary found. The frontend-verifier needs one to run headless. Install with: `sudo apt install chromium-browser` (Ubuntu/Debian) or `sudo dnf install chromium` (Fedora)."

#### 8. Summary

```
## Config Health Check

✓ project.yaml exists
✓ domain-map.yaml exists ([n] domains) – spec sync active
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
| `workflow.spec_sync` | `true`, `false` | Mandatory spec sync at commit |
| `workflow.tdd.strict` | `true`, `false` | Require TDD pipeline |
| `workflow.tdd.orchestrator_strict` | `true`, `false` | Orchestrator delegates all code work |
| `workflow.frontend_verification` | `true`, `false` | Require frontend verification |
| `workflow.grilling.questions` | `tool`, `inline` | How grilling presents a round – the host's question tool, or prose. `tool` falls back to inline when a round exceeds 4 questions or a question has no discrete options |
| `workflow.maps.tracker` | `github`, `files` | Which tracker holds the map's node records. Unset means the map skill picks when a map is first created, and writes the choice here |
| `workflow.maps.persist` | `true`, `false` | Keep the map's archived node records under `spechub/archive/` instead of deleting them (files tracker only, default `false`) |
| `workflow.handoff.agent` | command template string | Command used to launch a handoff target agent when herdr is unavailable. A template, not a bare name, so flags fit (e.g. a model or permission-mode flag) – default `claude` |
| `workflow.handoff.ack_turns` | number | Turns after message delivery before a handoff reports silence (default `5`) |
| `workflow.handoff.self_invoke` | `true`, `false` | Whether the agent may invoke the handoff skill itself. Checked behaviourally at the skill's first step, since frontmatter model-invocation flags are static and cannot be toggled per project (default `true`) |
| `workflow.handoff.nudge_warn` | number | Context tokens at which the context-pressure hook starts nudging, and the ladder's first rung. Small-context models want lower values (default `200000`) |
| `workflow.handoff.nudge_severe` | number | Context tokens at which the nudge escalates to severe, and the ladder's second rung (default `500000`) |
| `workflow.handoff.nudge_step` | number | How far apart the rungs sit above the last one, so a long session is nudged once per step rather than on every stop (default `100000`) |
| `workflow.handoff.context_thresholds` | list of numbers or percentage strings | Replaces the default `nudge_warn`/`nudge_severe` rungs with an explicit ladder, e.g. `[150000, 300000]` or `["40%", "70%"]`. `nudge_step` still extends it past the last listed rung, and `nudge_severe` then only picks the wording |
| `workflow.handoff.context_window` | number | The window a percentage rung is a percentage of. Unset, it is inferred from the session's model id: `[1m]` in the id means 1,000,000; the haiku line and the 4.x families (`claude-opus-4-8`, `claude-haiku-4-5-...`, `claude-sonnet-4-5`) mean 200,000; anything else – the 5.x families, or no model id at all – means 1,000,000 |
| `frontend.browser.mode` | `remote`, `headless`, `local` | Browser environment for verification |
| `frontend.browser.fallback` | `headless`, `none` | What to do when primary mode unavailable |
| `frontend.browser.cdp_port` | number | CDP port – default `19988` for `mode: remote`, `9555` for `headless`/`local` |

The nudge fires only on the session's own stop. Teammates and subagents are never nudged, because neither can hand the user's work over.

The ladder is per session, and so is the quiet marker a finished handoff or compaction leaves behind to silence the rest of the session. Both reset when the session compacts: a compaction throws away the context the recorded rung described, so the ladder starts again from its first rung.

Examples:
- `/spechub:config set workflow.tdd.strict false`
- `/spechub:config set workflow.spec_sync false`

### `reset`

Reset all workflow settings to defaults:

```yaml
workflow:
  spec_sync: true
  grilling:
    questions: tool
  tdd:
    strict: true
    orchestrator_strict: true
  frontend_verification: true
  handoff:
    agent: "claude"
    ack_turns: 5
    self_invoke: true
    nudge_warn: 200000
    nudge_severe: 500000
    nudge_step: 100000
```

## Steps

### 1. Read Current Config

Read `spechub/project.yaml`. If it doesn't exist, tell the user to run `/spechub:init` first.

### 2. Execute Command

- **show**: Display formatted config summary, then prompt to fix any gaps
- **check**: Run health checks, offer fixes interactively
- **set**: Parse the key path, validate the value, update the YAML, write it back
- **reset**: Replace the `workflow` section with defaults, preserve all other sections. Also preserve `workflow.maps` – it records the tracker choice the map skill persisted, and losing it strands node records on a backend no session looks at

### 3. Confirm

After any modification:
1. Write the updated `spechub/project.yaml`
2. Show the changed setting and its new value
3. Note any implications (e.g., "Spec sync is now off – living specs will no longer update at commit time")

## Validation Rules

- Boolean values accept: `true`/`false`, `on`/`off`, `yes`/`no` (normalize to `true`/`false`)
- Browser mode must be one of: `remote`, `headless`, `local`
- Browser fallback must be one of: `headless`, `none`
- If `workflow` section doesn't exist in project.yaml, create it with defaults before applying changes
- The `set` command only modifies workflow and frontend.browser sections. For other sections, use init

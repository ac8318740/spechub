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
Workflow:     strict TDD, strict orchestrator, spec sync on, grilling via question tool
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
        {"label": "Grilling", "description": "How grilling presents question rounds – question tool (default) or inline prose"},
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
- **Grilling**: Ask `tool` (the host's question tool, recommended) vs `inline` (prose rounds). Sets `workflow.grilling.questions`.
- **TDD strictness**: Ask strict vs relaxed
- **Orchestrator**: Ask strict vs relaxed
- **Spec sync**: Ask enabled vs disabled
- **Python venv** (auto for Python): Ask activation command

## Step 4: Write Config

1. Create `spechub/` directory
2. Write `spechub/project.yaml` from defaults + customizations
3. Leave project CLAUDE.md alone – orchestrator instructions load automatically via the SessionStart hook
4. If a project CLAUDE.md contains a legacy `@import .../plugins/cache/ac8318740-plugins/spechub/<version>/CLAUDE.md` line, remove it (stale reference from older SpecHub versions)

## Step 5: Generate the Domain Map

`spechub/domain-map.yaml` maps source paths to spec domains. Spec sync, `/spechub:archive`, `/spechub:bootstrap` and `/spechub:pre-commit-review` all read it. Without it, every spec-sync path skips silently and living specs never update – so init must always produce one.

### 5a. Propose domains

Launch an **Explore subagent** over `directories.source` to propose domains. Ask it for the top-level functional areas – not one domain per directory, and not one domain for the whole tree. For each: a kebab-case name, the paths that belong to it, and a one-line description of what it owns.

Guidance for the subagent:

- Group by responsibility, not by layer. `auth`, `billing`, `search` – not `models`, `controllers`, `utils`.
- Prefer directory prefixes over file lists. Paths are matched as prefixes.
- Aim for 3 to 10 domains. Fewer means spec sync can't tell changes apart; more means every commit touches several.
- Leave tests, config, build files and docs unmapped. Consumers skip anything outside all domains.

### 5b. Confirm with the user

Print the proposed map and use **AskUserQuestion** to confirm: "Use this domain map, or adjust it?"

Options: "Use it", "Adjust (I'll give feedback)".

If the codebase is empty or too small to have domains – a greenfield project – say so and write the starter form in 5c instead. Do not invent domains for code that does not exist yet.

### 5c. Write it

Write `spechub/domain-map.yaml`:

```yaml
# Domain Map: maps source paths to spec domains
# Read by spec sync, /spechub:archive, /spechub:bootstrap

domains:
  <domain-name>:
    paths:
      - <path prefix>
    description: <what this domain owns>
```

For a greenfield project, write the header plus a single commented example under `domains:` and tell the user to fill it in, or to run `/spechub:init` again once there is code to map.

## Step 6: Set Up Browser Verification

If the project has a frontend configured:

### 6a. Install agent-browser

```bash
which agent-browser
```

If not found:

```bash
npm install -g agent-browser
```

### 6b. Create verification knowledge base

Create `<helpers_dir>/VERIFICATION-KNOWLEDGE.md`:

```markdown
# Verification Knowledge Base

Evolving reference for browser-based verification. Updated by the frontend-verifier agent after each run.

## URL Patterns

<!-- Add URL patterns and routing rules here -->

## Element Patterns

<!-- Add stable element identifiers discovered during testing.
     Prefer data-testid attributes – they survive refactors.
     Record the accessible name/role from agent-browser snapshots. -->

## Gotchas & Lessons Learned

<!-- Add issues and workarounds discovered during testing -->

## Proven Verification Sequences

<!-- Add step sequences that work reliably.
     Example: "To verify login: open /login, snapshot, fill @username, fill @password, click @submit, wait 2s, snapshot again, check for dashboard heading" -->
```

### 6c. Browser environment setup

Ask the user which browser environment they'll use via AskUserQuestion:

```json
{
  "question": "How will you connect a browser for frontend verification?",
  "options": [
    {"label": "Remote browser (Playwriter bridge)", "description": "Best experience – drive Chrome on your desktop/laptop via the Playwriter extension over SSH. Choose this if you develop on a remote VM."},
    {"label": "Headless (automatic)", "description": "The frontend-verifier launches headless Chromium when needed. No setup required. Choose this for CI or if you don't need to see the browser."},
    {"label": "Local with display", "description": "Launch a visible browser on this machine. Choose this for desktop Linux, macOS, or WSL with display access."},
    {"label": "Skip for now", "description": "I'll set this up later via /spechub:config set frontend.browser.mode"}
  ]
}
```

Store the choice in `project.yaml` under `frontend.browser.mode` (`remote`, `headless`, or `local`). Also store `frontend.browser.cdp_port`: `19988` for `remote`, `9555` for `headless`/`local`.

After the mode is chosen, write `agent-browser.json` in the project root with the matching port:

```json
{
  "cdp": "<cdp_port>"
}
```

**If "Remote browser" selected**, ask about fallback behavior:

```json
{
  "question": "When the remote browser isn't connected, what should the frontend-verifier do?",
  "options": [
    {"label": "Fall back to headless", "description": "Launch headless Chromium automatically. Verification still runs, just without your real browser."},
    {"label": "Fail", "description": "Report FAIL so you know the bridge is down. Choose this if headless results aren't useful for your app."}
  ]
}
```

If "Fall back to headless", set `frontend.browser.fallback: headless`. If "Fail", set `frontend.browser.fallback: none`.

Then walk through remote setup. Remote mode uses the Playwriter bridge – Chrome on the browser machine is driven via the Playwriter extension's `chrome.debugger` API. No CDP listener is opened on Chrome itself.

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

Show these gotchas after the steps:

- Port `19988` is hardcoded by Playwriter – it is not configurable.
- The relay must run on the same host as Chrome. The Playwriter extension hard-rejects any `/extension` client that is not `127.0.0.1`.
- Each tab needs the extension icon clicked once. `chrome://` and `about:` pages cannot be attached.
- If port 19988 is busy on the browser machine from a stale relay, run `playwriter serve --host 127.0.0.1 --replace` to kick the previous one.

For a persistent, zero-window Windows laptop setup – auto-reconnecting scheduled tasks, ssh-agent key persistence, one-time admin registration – see `plugins/spechub/docs/playwriter-bridge-windows.md`. It ships the three PowerShell scripts (`relay.ps1`, `tunnel.ps1`, `register-tasks.ps1`) under `plugins/spechub/assets/playwriter-bridge/`.

Then verify connectivity:

```bash
curl -s --max-time 3 http://localhost:19988/json/version
```

- **JSON response**: "Bridge connected – you're ready for frontend verification."
- **Connection refused**: "No bridge detected yet. That's fine – connect when you're ready to verify. Run `/spechub:config check` to test connectivity later."

**If "Headless" selected**: No setup needed. Tell the user: "The frontend-verifier will launch headless Chromium automatically when needed."

**If "Local with display" selected**: Check for a Chromium binary and note that the frontend-verifier will launch it when needed.

**If "Skip"**: Leave `frontend.browser` unset and skip writing `agent-browser.json`. Tell the user to run `/spechub:config set frontend.browser.mode <mode>` later.

## Step 7: Report

```
## SpecHub Initialized

Profile:      [profile]
Source:       [source dir]
Tests:        [tests dir]
Grilling:     [tool/inline]
TDD:          [strict/relaxed]
Orchestrator: [strict/relaxed]
Spec sync:    [enabled/disabled]
Frontend:     [verified/not configured]
Browser:      [agent-browser installed / not applicable]
Config:       spechub/project.yaml
Domain map:   spechub/domain-map.yaml ([n] domains / starter – fill in)
CLAUDE.md:    untouched (orchestrator loads via SessionStart hook)

Next: describe what you want to build, or run /spechub:bootstrap for existing code.
```

## project.yaml Schema

Note: `frontend.browser.cdp_port` defaults to `19988` when `mode: remote` (Playwriter bridge) and `9555` otherwise.

```yaml
profile: node-typescript

workflow:
  spec_sync: true
  grilling:
    questions: tool      # tool | inline
  # maps: {tracker: github | files, persist: false} – set by /spechub:map at
  # materialisation; see the config skill for the key reference
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
  browser:
    mode: "headless"           # remote | headless | local
    fallback: "headless"       # fallback when primary mode unavailable (e.g., remote tunnel is down)
    cdp_port: 9555
```

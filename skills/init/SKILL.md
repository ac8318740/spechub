---
name: init
description: Initialize SpecHub in a project. Detects project type, proposes smart defaults, lets you customize specific sections.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Read, Write, Edit, Bash, Glob, Grep
---

## User input

```text
$ARGUMENTS
```

## Step 1: detect and propose defaults

Scan the project root for `pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, etc. If empty, infer from `$ARGUMENTS`. Read the matching profile from the plugin's `profiles/` directory.

Show a summary:

```
Profile:      [detected]
Directories:  src/, tests/
Commands:     [from profile]
Frontend:     [if applicable]
Workflow:     strict TDD, strict orchestrator, spec sync on, grilling via question tool
```

## Step 2: ask what to customize

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
        {"label": "Grilling", "description": "How grilling asks its questions – a question tool (default) or plain prose"},
        {"label": "TDD strictness", "description": "Switch from strict (test-first) to relaxed"},
        {"label": "Orchestrator", "description": "Allow direct code work instead of subagent delegation"},
        {"label": "Spec sync", "description": "Disable automatic spec sync on commit"}
      ]
    }
  ]
}
```

Parse answers: answers["0"] = Setup selections, answers["1"] = Workflow selections. If nothing selected, use all defaults.

## Step 3: customize selected sections

For each selected item, ask one follow-up question at a time via AskUserQuestion. Skip unselected items.

- **Profile & paths**: Ask language/framework, then source/test dirs
- **Commands**: Show proposed commands, ask to adjust
- **Frontend**: Show frontend settings, ask to adjust
- **Grilling**: Ask `tool` (the host's question tool, recommended) vs `inline` (prose rounds). Sets `workflow.grilling.questions`.
- **TDD strictness**: Ask strict vs relaxed
- **Orchestrator**: Ask strict vs relaxed
- **Spec sync**: Ask enabled vs disabled
- **Python venv** (auto for Python): Ask activation command

## Step 4: write config

1. Create `spechub/` directory
2. Write `spechub/project.yaml` from defaults + customizations
3. Leave project CLAUDE.md alone – orchestrator instructions load automatically via the SessionStart hook
4. If a project CLAUDE.md contains a legacy `@import .../plugins/cache/ac8318740-plugins/spechub/<version>/CLAUDE.md` line, remove it (stale reference from older SpecHub versions)

## Step 5: generate the domain map

`spechub/domain-map.yaml` maps source paths to spec domains. Spec sync, `/spechub:archive`, `/spechub:bootstrap` and `/spechub:pre-commit-review` all read it. Without it, every spec-sync path skips silently and living specs never update – so init must always produce one.

### 5a. Propose domains

Launch an **Explore subagent** over `directories.source` to propose domains. Ask it for the top-level functional areas – not one domain per directory, and not one domain for the whole tree. For each: a kebab-case name, the paths that belong to it, and a one-line description of what it owns.

Guidance for the subagent:

- Group by responsibility, not by layer. `auth`, `billing`, `search` – not `models`, `controllers`, `utils`.
- Prefer directory prefixes over file lists. Consumers match paths as prefixes.
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

For a greenfield project, write the header plus a single commented example under `domains:`. Tell the user to fill it in, or to run `/spechub:init` again once there is code to map.

## Step 6: set up browser verification

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

After the user chooses the mode, write `agent-browser.json` in the project root with the matching port:

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

Then walk through remote setup. Remote mode uses the Playwriter bridge – the Playwriter extension drives Chrome on the browser machine via its `chrome.debugger` API. Chrome itself opens no CDP listener.

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

- Playwriter hardcodes port `19988` – it is not configurable.
- The relay must run on the same host as Chrome. The Playwriter extension hard-rejects any `/extension` client that is not `127.0.0.1`.
- Each tab needs the extension icon clicked once. Playwriter cannot attach to `chrome://` and `about:` pages.
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

## Step 7: offer the writing output style (optional)

The plugin ships an output style. Claude Code shows it as `spechub:ac-writing-style`. It applies the `writing` skill's plain-language rules to every chat reply. Offer it here. Never set it without asking.

### 7a. Report the current state

Read `outputStyle` from the user file and both project files:

```bash
python3 - <<'PY'
import json, pathlib
for p in ["~/.claude/settings.json", ".claude/settings.local.json", ".claude/settings.json"]:
    f = pathlib.Path(p).expanduser()
    try:
        print(p, json.loads(f.read_text()).get("outputStyle"))
    except FileNotFoundError:
        print(p, "(no file)")
    except json.JSONDecodeError:
        print(f"{p}: malformed JSON")
PY
```

Tell the user which of the three files sets `outputStyle`, and to what. `.claude/settings.local.json` wins over `.claude/settings.json`, which wins over `~/.claude/settings.json`.

### 7b. Ask once

```json
{
  "question": "Apply the spechub:ac-writing-style output style?",
  "options": [
    {"label": "Global (recommended)", "description": "Write outputStyle into ~/.claude/settings.json, so it applies in every project"},
    {"label": "This project only", "description": "Write outputStyle into .claude/settings.local.json, which overrides the global value here"},
    {"label": "Skip", "description": "Leave the output style as it is"}
  ]
}
```

### 7c. Write the choice

Load the chosen file as JSON, set the one key, then dump it back. Use `python3` or `jq`. Never edit the file with a regular expression, because that corrupts the other keys. If the chosen file has malformed JSON, stop and report it instead of overwriting it.

```bash
python3 - <<'PY'
import json, pathlib, sys
f = pathlib.Path("~/.claude/settings.json").expanduser()   # or .claude/settings.local.json
f.parent.mkdir(parents=True, exist_ok=True)
try:
    data = json.loads(f.read_text()) if f.exists() else {}
except json.JSONDecodeError:
    sys.exit(f"{f}: malformed JSON, aborting")
data["outputStyle"] = "spechub:ac-writing-style"
f.write_text(json.dumps(data, indent=2) + "\n")
PY
```

If the user chose global and a project file also sets `outputStyle`, say so. Offer to remove that key. The project value overrides the global one.

### 7d. Say when it takes effect

Tell the user the style applies after `/clear`, or in a new session. Say that `/config` -> Output style writes project scope only, which is why this step offers the global path. Source: https://code.claude.com/docs/en/output-styles.md.

Claude Code has no command-line flag for this. `claude config` does not exist, and Claude Code dropped the `/output-style` command. Do not invent either.

## Step 8: report

```
## SpecHub Initialized

Profile:      [profile]
Source:       [source dir]
Tests:        [tests dir]
Grilling:     [question tool/inline prose]
TDD:          [strict/relaxed]
Orchestrator: [strict/relaxed]
Spec sync:    [enabled/disabled]
Frontend:     [verified/not configured]
Browser:      [agent-browser installed / not applicable]
Config:       spechub/project.yaml
Domain map:   spechub/domain-map.yaml ([n] domains / starter – fill in)
Output style: spechub:ac-writing-style (global) | (project) | not set
CLAUDE.md:    untouched (orchestrator loads via SessionStart hook)

Next: describe what you want to build, or run /spechub:bootstrap for existing code.
```

## project.yaml schema

Note: `frontend.browser.cdp_port` defaults to `19988` when `mode: remote` (Playwriter bridge) and `9555` otherwise.

Note: the `nudge_*` keys drive the context-pressure nudge, which fires only on the session's own stop. The nudge never fires for teammates or subagents, because neither can hand the user's work over. Its ladder is per session, as is the quiet marker a finished handoff or compaction leaves behind. Both reset when the session compacts. The recorded rung described context the compaction just threw away. So the ladder starts again from its first rung.

```yaml
profile: node-typescript

workflow:
  spec_sync: true
  grilling:
    questions: tool      # tool | inline
  # maps: {tracker: github | files, persist: false} – set by /spechub:map when
  # a map is first created; see the config skill for the key reference
  tdd:
    strict: true
    orchestrator_strict: true
  frontend_verification: true
  handoff:
    agent: "claude"           # command template, not a bare name, so flags fit
    ack_turns: 5              # turns after delivery before silence is reported
    self_invoke: true         # whether the agent may invoke handoff itself
    nudge_warn: 200000        # absolute tokens; small-context models want lower
    nudge_severe: 500000      # absolute tokens
    nudge_step: 100000        # spacing of the rungs above the last one, so a
                              # long session is nudged once per step
    # context_thresholds: [150000, 300000]   # an explicit ladder, replacing
    #                                        # nudge_warn/nudge_severe as rungs;
    #                                        # percentages such as "40%" work too
    # context_window: 200000                 # what a percentage rung is a
    #                                        # percentage of; unset, it comes
    #                                        # from the model id – 200000 for
    #                                        # haiku and the 4.x families,
    #                                        # 1000000 for [1m] ids and the
    #                                        # 5.x families

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

---
name: browser-helpers
description: Set up browser verification infrastructure for a project. Ensures agent-browser CLI is available, configures CDP connection, scaffolds verification knowledge base. Invoke when setting up frontend verification or when a project needs browser testing for the first time.
---

# Browser Helpers

## Purpose

Set up and maintain browser verification infrastructure using `agent-browser` CLI and Chrome DevTools Protocol (CDP). A simpler, environment-agnostic approach – no test framework library to maintain.

## Project Configuration

Read `spechub/project.yaml` for:

- `frontend.directory` – frontend source directory
- `frontend.dev_server_url` – dev server URL
- `frontend.helpers_dir` – path to verification knowledge (default: `<frontend.directory>/tests/helpers/`)

## What Gets Scaffolded

The helper infrastructure is minimal – no JavaScript library to maintain:

```
<helpers_dir>/
└── VERIFICATION-KNOWLEDGE.md  # Evolving knowledge base (gotchas, patterns, selectors)

<project-root>/
└── agent-browser.json          # CDP connection config
```

That's it. The `agent-browser` CLI handles browser interaction directly. No facade modules, no TypeScript helpers, no assertion libraries.

## Setup

### 1. Check agent-browser is installed

```bash
which agent-browser
```

If not found:

```bash
npm install -g agent-browser
```

### 2. Create project config

Create `agent-browser.json` in the project root:

```json
{
  "cdp": "9555"
}
```

This tells agent-browser which CDP port to connect to. With this file in place, you don't need `--cdp 9555` on every command.

### 3. Verify browser connectivity

```bash
curl -s --max-time 3 http://localhost:9555/json/version
```

Three possible states:

| Result | Meaning | Action |
|--------|---------|--------|
| JSON response | Remote browser connected (SSH tunnel) | Ready – using user's real browser |
| Connection refused | No browser available | Launch headless Chromium locally |
| Timeout | Tunnel exists but Chrome not running | Ask user to launch Chrome on their machine |

### 4. Create verification knowledge base

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

## Browser Environments

agent-browser works the same way regardless of where the browser lives. The only difference is how the CDP connection is established.

### Remote browser (SSH tunnel)

Best experience – you interact with the user's real browser on their machine.

**Setup**: The user launches Chrome with `--remote-debugging-port=9555` and runs an SSH reverse tunnel. See the browser-debug skill for full setup instructions.

**Detection**: `curl localhost:9555/json/version` returns JSON.

### Local headless (no display)

Works on headless Linux VMs, CI, containers – anywhere without a GUI.

**Launch**:

```bash
chromium --headless --no-sandbox --remote-debugging-port=9555 --disable-gpu --user-data-dir=/tmp/chromium-verify &
```

Try these binary names in order: `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`.

**Clean up**: Kill the process when done. The frontend-verifier handles this automatically.

### Local with display (WSL, desktop Linux, macOS)

Same as headless but with a visible browser window:

```bash
chromium --remote-debugging-port=9555 --user-data-dir=/tmp/chromium-verify &
```

Omit `--headless` to see the browser. Useful during development.

## agent-browser Command Reference

All commands assume `agent-browser.json` exists in the project root.

| Command | Purpose |
|---------|---------|
| `agent-browser open <url>` | Navigate to URL |
| `agent-browser snapshot -i` | Accessibility tree with interactive element refs |
| `agent-browser screenshot <path>` | Take screenshot |
| `agent-browser screenshot --annotate <path>` | Screenshot with numbered element labels |
| `agent-browser click @e<N>` | Click element by ref |
| `agent-browser fill @e<N> "text"` | Clear field, then type |
| `agent-browser type @e<N> "text"` | Append text without clearing |
| `agent-browser hover @e<N>` | Hover over element |
| `agent-browser press <Key>` | Press keyboard key |
| `agent-browser dblclick @e<N>` | Double-click |
| `agent-browser drag @e<N> @e<M>` | Drag and drop |
| `agent-browser console` | Check console errors/logs |

### Critical rule: re-snapshot after DOM changes

Element refs (`@e1`, `@e2`, etc.) are tied to a specific DOM state. They go stale after:

- Navigation
- Clicks that change the DOM (modals, dropdowns, route changes)
- Hot-reload after code changes
- Any dynamic content loading

Always run `agent-browser snapshot -i` again before using element refs after any DOM change.

## Selector Strategy

When recording patterns in VERIFICATION-KNOWLEDGE.md, prefer identifiers in this order:

1. `data-testid="..."` – most stable, survives refactors
2. Accessible name/role from snapshot – e.g., "button named 'Submit'"
3. Text content – e.g., "heading containing 'Dashboard'"
4. CSS selectors – last resort, fragile

The snapshot gives you accessible names and roles automatically. Use these to find elements rather than fragile CSS selectors.

## Integration Points

- **frontend-verifier agent** uses agent-browser directly for Phase 4 verification
- **task-checker agent** delegates to frontend-verifier when frontend files changed
- **/spechub:init** scaffolds agent-browser.json and knowledge base when frontend is configured
- **/spechub:quick-fix** uses agent-browser for visual verification of bug fixes

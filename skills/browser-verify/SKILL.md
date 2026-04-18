---
name: browser-verify
description: How to interact with a browser for frontend verification using agent-browser CLI and CDP. ALWAYS use when UI or frontend files are modified and workflow.frontend_verification is true in spechub/project.yaml. Also use before running agent-browser commands, when element refs go stale, when CDP connection fails, or when verifying UI behavior. Covers all commands (snapshot, screenshot, click, fill, type), element ref strategy, DOM staleness rules, selector priority, and remote/headless/local environment troubleshooting.
---

# Browser Helpers

## Purpose

Operational reference for browser-based verification using `agent-browser` CLI and Chrome DevTools Protocol (CDP). Covers commands, selector strategy, environment setup, and troubleshooting.

For initial setup (installing agent-browser, creating config files, scaffolding knowledge base), use `/spechub:init` or `/spechub:config check`.

## Project Configuration

Read `spechub/project.yaml` for:

- `frontend.directory` – frontend source directory
- `frontend.dev_server_url` – dev server URL
- `frontend.helpers_dir` – path to verification knowledge (default: `<frontend.directory>/tests/helpers/`)
- `frontend.browser.mode` – browser environment: `remote`, `headless`, or `local`
- `frontend.browser.fallback` – what to do when primary mode unavailable: `headless` (launch Chromium) or `none` (fail)
- `frontend.browser.cdp_port` – CDP port. Default `19988` for `mode: remote` (Playwriter bridge), `9555` for `headless`/`local`.

## Browser Environments

agent-browser works the same way regardless of where the browser lives. The only difference is how the CDP connection is established.

### Remote browser (Playwriter bridge)

Best experience – you interact with the user's real browser on their machine. Set `frontend.browser.mode: remote` and `frontend.browser.cdp_port: 19988` in project.yaml.

Remote mode uses the Playwriter bridge: a relay runs on the browser machine and exposes a CDP-shaped endpoint; the Playwriter Chrome extension drives Chrome via the `chrome.debugger` API. No CDP listener is opened on Chrome itself. The dev machine reaches the relay through an SSH reverse tunnel.

If the bridge is down, the frontend-verifier checks `frontend.browser.fallback`. With `fallback: headless` (recommended), it launches headless Chromium so verification still runs. With `fallback: none`, it fails and reports troubleshooting steps.

#### Setup

1. **On the browser machine**, install Node 18+ and Playwriter:

   ```bash
   npm install -g playwriter
   ```

2. **In Chrome on the browser machine** (preferably a dedicated profile), install the Playwriter extension and pin it:

   ```
   https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe
   ```

3. **Run two long-running processes on the browser machine**:

   ```bash
   # Relay (listens on 127.0.0.1:19988 for the extension and for tunnelled CDP clients)
   playwriter serve --host 127.0.0.1

   # SSH reverse tunnel from the browser machine to the dev machine
   ssh -N -R 19988:127.0.0.1:19988 <user>@<dev-machine>
   ```

4. **Per-tab activation**: in Chrome, click the Playwriter toolbar icon on each tab you want automated.

5. **Verify** from the dev machine:

   ```bash
   curl -s http://localhost:19988/json/version
   ```

#### Common gotchas

**Port `19988` is hardcoded by Playwriter.** It is not configurable. The relay, the extension, and the tunnel all use the same port by design.

**The relay must run on the same host as Chrome.** The Playwriter extension hard-rejects any `/extension` client that is not `127.0.0.1`. Do not try to run the relay on the dev machine – run it where Chrome runs, then tunnel to it.

**Each tab needs the extension icon clicked once.** Playwriter attaches per-tab. `chrome://` and `about:` pages cannot be attached – use normal web URLs.

**Stale relay blocks the port.** If `playwriter serve` fails because port 19988 is already bound on the browser machine, run:

```bash
playwriter serve --host 127.0.0.1 --replace
```

to kick the previous relay.

**Detection**: `curl localhost:19988/json/version` returns Playwriter-flavored JSON (the bridge mimics a CDP `/json/version` payload).

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

- **frontend-verifier agent** uses agent-browser for Phase 4 verification – this skill is its reference
- **task-checker agent** delegates to frontend-verifier when frontend files changed
- **/spechub:init** handles initial setup (install, config, knowledge base scaffolding)
- **/spechub:config check** audits browser infrastructure and walks through fixes
- **/spechub:quick-fix** uses agent-browser for visual verification of bug fixes

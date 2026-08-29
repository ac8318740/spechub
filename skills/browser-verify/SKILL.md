---
name: browser-verify
description: How to interact with a browser for frontend verification using agent-browser CLI and CDP. ALWAYS use when UI or frontend files are modified and workflow.frontend_verification is true in spechub/project.yaml. Also use before running agent-browser commands, when element refs go stale, when CDP connection fails, or when verifying UI behavior. Covers all commands (snapshot, screenshot, click, fill, type), element ref strategy, DOM staleness rules, selector priority, and remote/headless/local environment troubleshooting.
---

# Browser helpers

## Purpose

This is an operational reference for browser-based verification using the `agent-browser` CLI and Chrome DevTools Protocol (CDP). It covers commands, selector strategy, environment setup, and troubleshooting.

For setup (installing agent-browser, creating config files, scaffolding knowledge base), use `/spechub:setup`. To audit what a project already has, run `spechub config check`.

## Project configuration

Read `spechub/project.yaml` for:

- `frontend.directory` – frontend source directory
- `frontend.dev_server_url` – dev server URL
- `frontend.helpers_dir` – path to verification knowledge (default: `<frontend.directory>/tests/helpers/`)
- `frontend.browser.mode` – the browser environment this project prefers: `remote`, `headless`, or `local`
- `frontend.browser.fallback` – set it to `none` to forbid any other mode standing in. Every other value allows one
- `frontend.browser.cdp_port` – CDP port. Default `19988` for `mode: remote` (Playwriter bridge), `9555` for `headless`/`local`.

## Which browser mode to use

The project states a preference. The host states what it can actually provide. One command reads both and returns the answer:

```bash
~/.claude/spechub/bin/spechub config browser-mode --json
```

It answers from declared configuration alone. It probes nothing, so it returns at once and always gives the same answer on the same machine.

On exit 0 it prints one JSON object:

```json
{
  "mode": "headless",
  "preferred": "remote",
  "reason": "the project prefers remote, which this host does not declare available, so headless stands in",
  "fallback": true
}
```

- `mode` – the browser mode to use: `remote`, `headless`, or `local`
- `preferred` – the project's stated `frontend.browser.mode`, or `null` when it states none
- `reason` – one sentence that explains the choice
- `fallback` – `true` only when `mode` differs from a stated preference

Without `--json` it prints the same two facts on one line: the mode, then the reason.

### How it decides

The host declares which modes this machine can provide. It does so on three axes in the global config at `~/.config/spechub/config.json`:

- `host.browser.remote` – this machine can reach a browser on another machine
- `host.browser.headless` – this machine can launch headless Chromium
- `host.browser.local` – this machine has a display for a visible browser

`/spechub:host` sets them. From there the rules are short:

1. The project's preferred mode wins when the host declares that mode available.
2. Otherwise the first mode the host does declare stands in, in the order remote, headless, local.
3. A project that sets `frontend.browser.fallback: none` allows no mode to stand in.
4. A project that states no preferred mode takes the first mode the host declares. This is not a fallback, so `fallback` stays `false` and `frontend.browser.fallback` has no say.

### When it has no answer

The command exits 1, writes one plain-text message to stderr, and prints nothing on stdout. This happens even with `--json`, so a caller parsing the output gets an empty stdout rather than an object to check a field on.

Three situations produce it. Each message names the one command that fixes it:

- the project configures no frontend, or there is no SpecHub project here. The message names `/spechub:setup`
- this host declares no browser mode available, or nobody has described this host yet. The message names `/spechub:host`
- the project forbids a fallback, and this host does not declare the mode it prefers. The message names `/spechub:host`

The frontend-verifier treats exit 1 as a FAIL and reports the message verbatim. It never guesses a mode of its own.

## Browser environments

agent-browser works the same way in every environment. Only the CDP connection setup differs.

### Remote browser (Playwriter bridge)

Best experience – you interact with the user's real browser on their machine. Set `frontend.browser.mode: remote` and `frontend.browser.cdp_port: 19988` in project.yaml.

Remote mode uses the Playwriter bridge.

A relay runs on the browser machine and exposes a CDP-shaped endpoint. The Playwriter Chrome extension drives Chrome through the `chrome.debugger` API. Chrome itself opens no CDP listener.

The dev machine reaches the relay through an SSH reverse tunnel.

This section does not decide whether remote mode runs here. `spechub config browser-mode` decides that, from the project's preference and the host's `host.browser.*` axes together. Run it before you connect.

Once that command returns `remote`, the answer is final. If the bridge is then down, the frontend-verifier reports FAIL with troubleshooting steps. It does not launch headless Chromium instead, because the command already ruled on any stand-in mode.

#### Setup

1. **On the browser machine**, install Node 18+. Install Playwriter:

   ```bash
   npm install -g playwriter
   ```

2. **In Chrome on the browser machine** (preferably a dedicated profile), install the Playwriter extension. Pin it:

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

**Playwriter hardcodes port `19988`.** The port has no config option. The relay, the extension, and the tunnel all use the same port by design.

**The relay must run on the same host as Chrome.** The Playwriter extension hard-rejects any `/extension` client that is not `127.0.0.1`.

Do not run the relay on the dev machine. Run the relay where Chrome runs. Then tunnel to it from the dev machine.

**You must click the extension icon once per tab.** Playwriter attaches per-tab. Playwriter cannot attach to `chrome://` and `about:` pages – use normal web URLs.

**Stale relay blocks the port.** If `playwriter serve` fails because a stale relay already binds port 19988 on the browser machine, run:

```bash
playwriter serve --host 127.0.0.1 --replace
```

to kick the previous relay.

**Detection**: `curl localhost:19988/json/version` returns Playwriter-flavored JSON (the bridge mimics a CDP `/json/version` payload).

#### Persistent cross-device setup

Use the `bridge` skill for a durable Windows laptop → Linux VM setup: [`../bridge/SKILL.md`](../bridge/SKILL.md).

It adds auto-reconnecting scheduled tasks, ssh-agent key persistence, multi-VM tunneling, automated diagnosis (`doctor.ps1`), canonical stop (`stop.ps1`), and VM-side port cleanup (`vm-free-port.sh`). It routes to a Windows runbook or a Linux/VM runbook based on where you are. It also defines the paste-ready handoff format for cross-device work.

The scripts ship under `plugins/spechub/assets/playwriter-bridge/`.

### Local headless (no display)

This mode works on headless Linux VMs, CI, and containers – anywhere without a GUI.

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

## agent-browser command reference

All commands assume `agent-browser.json` exists in the project root.

| Command | Purpose |
|---------|---------|
| `agent-browser open <url>` | Navigate to a URL |
| `agent-browser snapshot -i` | Accessibility tree with interactive element refs |
| `agent-browser screenshot <path>` | Take a screenshot |
| `agent-browser screenshot --annotate <path>` | Screenshot with numbered element labels |
| `agent-browser click @e<N>` | Click an element by ref |
| `agent-browser fill @e<N> "text"` | Clear the field, then type |
| `agent-browser type @e<N> "text"` | Append text without clearing |
| `agent-browser hover @e<N>` | Hover over an element |
| `agent-browser press <Key>` | Press a keyboard key |
| `agent-browser dblclick @e<N>` | Double-click |
| `agent-browser drag @e<N> @e<M>` | Drag and drop |
| `agent-browser console` | Check console errors/logs |

### Critical rule: re-snapshot after DOM changes

agent-browser ties element refs (`@e1`, `@e2`, etc.) to a specific DOM state. They go stale after:

- Navigation
- Clicks that change the DOM (modals, dropdowns, route changes)
- Hot-reload after code changes
- Any dynamic content loading

Always run `agent-browser snapshot -i` again before using element refs after any DOM change.

## Selector strategy

When recording patterns in VERIFICATION-KNOWLEDGE.md, prefer identifiers in this order:

1. `data-testid="..."` – most stable, survives refactors
2. Accessible name/role from snapshot – e.g., "button named 'Submit'"
3. Text content – e.g., "heading containing 'Dashboard'"
4. CSS selectors – last resort, fragile

The snapshot gives you accessible names and roles automatically. Use these to find elements rather than fragile CSS selectors.

## Integration points

- **frontend-verifier agent** uses agent-browser for Phase 4 verification – this skill is its reference
- **task-checker agent** delegates to frontend-verifier when frontend files changed
- **/spechub:setup** runs the setup interviews (install, config, knowledge base scaffolding) and offers a fix for each row the health check fails
- **`spechub config check`** audits the browser infrastructure and changes nothing
- **/spechub:quick-fix** uses agent-browser for visual verification of bug fixes

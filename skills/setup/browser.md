# Setup: browser mode and Playwriter bridge

`SKILL.md` decides when to read this file: Step 9 routes a `preferred-browser-mode` info row to Step 10, or a `browser-mode:remote` failure to Step 11.

## Step 10: Ask the project's browser mode

Both paths reach this step. The first run reaches it because a fresh frontend
project states no preference. A re-run reaches it because the user picked that
row from the menu.

The machine says what it can do, in the `host.browser.*` axes. This question asks
a different thing: which of those modes this project would like to use.

Offer only the modes the machine declares available. When the machine declares
none, offer all three and run the `host` skill first.

The block below is the full menu, not the question to ask word for word. Drop the
entry for any mode the machine declares unavailable, then ask the rest.

```json
{
  "question": "How will you connect a browser for frontend verification?",
  "options": [
    {"label": "Remote browser (Playwriter bridge)", "description": "Best experience – drive Chrome on your desktop/laptop via the Playwriter extension over SSH. Choose this if you develop on a remote VM."},
    {"label": "Headless (automatic)", "description": "The frontend-verifier launches headless Chromium when needed. No setup required. Choose this for CI or if you don't need to see the browser."},
    {"label": "Local with display", "description": "Launch a visible browser on this machine. Choose this for desktop Linux, macOS, or WSL with display access."},
    {"label": "Skip for now", "description": "I'll set this up later – /spechub:host to declare what this machine can do, /spechub:setup for the project's preference"}
  ]
}
```

Write the answer as `remote`, `headless` or `local`. Write the port beside it:
`19988` for `remote`, and `9555` for the other two.

```bash
~/.claude/spechub/bin/spechub config set frontend.browser.mode remote
~/.claude/spechub/bin/spechub config set frontend.browser.cdp_port 19988
```

Then write `agent-browser.json` with the same port, the way Step 9c in `row-fixes.md` does.

On **Skip for now**, leave `frontend.browser` unset and write no
`agent-browser.json`. Say that `docs/config-reference.md` documents the three
keys for later.

On **Headless**, no setup follows. Tell the user the frontend verifier launches
headless Chromium when it needs one.

On **Local with display**, look for a Chromium binary. Tell the user the frontend
verifier launches it when it needs one.

On **Remote browser**, ask what the verifier does when the browser answers nothing:

```json
{
  "question": "When the remote browser isn't connected, what should the frontend-verifier do?",
  "options": [
    {"label": "Fall back to headless", "description": "Launch headless Chromium automatically. Verification still runs, just without your real browser."},
    {"label": "Fail", "description": "Report FAIL so you know the bridge is down. Choose this if headless results aren't useful for your app."}
  ]
}
```

Write `frontend.browser.fallback` as `headless` for the first answer, and as
`none` for the second. Only `none` acts. It forbids another mode from standing
in.

Then go to Step 11.

## Step 11: Connect the Playwriter bridge

This step is the one copy of the bridge setup. Step 10 reaches it on a `remote`
answer. Step 9 reaches it on a `browser-mode:remote` failure.

Remote mode drives Chrome through the Playwriter extension, which uses the
`chrome.debugger` API. Chrome itself opens no CDP listener. Show these steps:

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

- Playwriter hardcodes port `19988`. Nobody can change it.
- The relay runs on the same host as Chrome. The extension rejects any
  `/extension` client that is not `127.0.0.1`.

- Each tab needs the extension icon clicked once. Playwriter cannot attach to a
  `chrome://` or `about:` page.

- A stale relay holds port 19988 on the browser machine. Run
  `playwriter serve --host 127.0.0.1 --replace` to kick the previous one.

For a Windows laptop setup that opens no window, see
`plugins/spechub/docs/playwriter-bridge-windows.md`. It covers auto-reconnecting
scheduled tasks, ssh-agent key persistence and one-time admin registration. It
ships `relay.ps1`, `tunnel.ps1` and `register-tasks.ps1` under
`plugins/spechub/assets/playwriter-bridge/`.

Then re-run the health check from Step 7 and read the `browser-mode:remote` row.
It passes once something answers on the port.

Do not curl the port yourself. The check is the one place that probes the
machine.

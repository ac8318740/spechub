# Setup: row fixes

`SKILL.md` decides when to read this file: Step 9 is fixing a `browser-mode:<mode>`, `frontend-verification`, `domain-map`, `agent-browser`, `agent-browser-json`, `verification-knowledge` or `output-style` row.

Five rows describe the machine: `required-axis`, `orchestrator`, `browser-mode`,
`preferred-browser-mode` and `optional-axis`. Invoke the `host` skill for each of
them, with one exception: `optional-axis:host.terminal_workspace` is Step 12's
question, and the `host` skill never asks it. It is safe to re-run, and it starts from the current answers.

A `preferred-browser-mode` row is the exception. It goes to the `host` skill only
on a `fail`, and to Step 10 on an `info`.

One row has second fixes: `browser-mode:<mode>`. Which one applies depends on the
mode, and for two of the three modes the `host` skill is no fix at all.

A `browser-mode:remote` failure says the machine declares the remote mode and
nothing answered on the port. If the machine really does drive a browser that
way, the bridge is down, so run Step 11. If it does not, the axis is wrong, so
run the `host` skill.

A `browser-mode:headless` or `browser-mode:local` failure says one thing and
nothing else: the machine declares the mode and no Chromium or Chrome binary sits
on PATH. The axis is right and the machine is short a browser. Re-running the
host interview changes nothing here, and answering the axis false records a lie
about what this machine can do.

Offer to install the browser instead:

```bash
sudo apt install chromium-browser   # Ubuntu/Debian
sudo dnf install chromium           # Fedora
```

Then re-run the health check from Step 7. The row passes once the binary is on
PATH.

A `frontend-verification` row needs no step of its own. The project configures a
frontend and has not turned browser verification on. Turn it on:

```bash
~/.claude/spechub/bin/spechub config set workflow.frontend_verification true
```

`docs/config-reference.md` documents the key.

### 9a. Generate the domain map

`spechub/domain-map.yaml` maps source paths to spec domains. Spec sync,
`/spechub:archive`, `/spechub:bootstrap` and `/spechub:pre-commit-review` all
read it. Without it, every path through spec sync skips in silence, and the
living specs never update.

Launch an **Explore subagent** over `directories.source` to propose domains. Ask
it for the top-level functional areas. Ask for a kebab-case name, the paths that
belong to it, and one line saying what it owns.

Guidance for the subagent:

- Group by responsibility, not by layer. Use `auth`, `billing` and `search`,
  never `models`, `controllers` and `utils`.

- Prefer a directory prefix over a file list. Consumers match a path as a prefix.
- Aim for 3 to 10 domains. Fewer, and spec sync cannot tell two changes apart.
  More, and every commit touches several.

- Leave tests, config, build files and docs unmapped. Consumers skip a path that
  no domain covers.

If `spechub/specs/` already holds domain directories, propose those names first
and map the paths onto them. Renaming a domain here orphans its `spec.md`.

Print the proposal and confirm it with AskUserQuestion. Ask "Use this domain map,
or adjust it?" and offer "Use it" against "Adjust (I'll give feedback)".

Then write the file:

```yaml
# Domain Map: maps source paths to spec domains
# Read by spec sync, /spechub:archive, /spechub:bootstrap

domains:
  <domain-name>:
    paths:
      - <path prefix>
    description: <what this domain owns>
```

A greenfield project has no code to group. Say so, write the header with one
commented example under `domains:`, and invent nothing. Tell the user to fill it
in, or to run `/spechub:setup` again once there is code to map.

### 9b. Install the browser driver

`agent-browser` is the command line tool the frontend verifier drives a browser
with. Offer to install it:

```bash
npm install -g agent-browser
```

### 9c. Write agent-browser.json

This file tells `agent-browser` which port to dial. Write it in the project root:

```json
{"cdp": "<cdp_port>"}
```

Take `<cdp_port>` from `frontend.browser.cdp_port` in `spechub/project.yaml`. With
no value there, the default is `19988` under `mode: remote` and `9555` otherwise.
The row fails when the two files name different ports, so change one of them.

### 9d. Create the knowledge base for verification

The frontend verifier keeps what it learns in `VERIFICATION-KNOWLEDGE.md`, under
the directory `frontend.helpers_dir` names. If that key states nothing, ask for a
directory and write the key first. Then create the file:

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

### 9e. Offer the writing output style

The plugin ships an output style. Claude Code names it `spechub:ac-writing-style`.
It applies the `writing` skill's plain-language rules to every chat reply.

Offer it. Never set it without asking.

The row's message names which of the three settings files selects a style, and
which style it selects. `.claude/settings.local.json` wins over
`.claude/settings.json`, which wins over `~/.claude/settings.json`.

Ask once:

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

Load the chosen file as JSON, set the one key, then write it back. Use `python3`
or `jq`. Never edit the file with a regular expression, because that corrupts the
other keys.

Stop and report a file holding malformed JSON. Do not overwrite it.

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

If the user chose global and a project file also sets `outputStyle`, say so. The
project value overrides the global one, so offer to remove that key.

Tell the user the style applies after `/clear`, or in a new session. Say that
`/config` -> Output style writes project scope only, which is why this step
offers the global path. Source: https://code.claude.com/docs/en/output-styles.md.

Claude Code has no command line flag for this. `claude config` does not exist,
and Claude Code dropped the `/output-style` command. Do not invent either.

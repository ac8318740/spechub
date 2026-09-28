# Host questions

`SKILL.md` decides when to read this file: before asking the first question.
It holds what each detection field is evidence for, and the exact wording of
every question in Steps 2 and 3. `SKILL.md` defines each step.

## Detection fields (Step 1)

What it reports, and what each field is evidence for:

| Field | Evidence for |
| --- | --- |
| `orchestrator.herdr_binary` | herdr is installed here (absolute path, or `null`) |
| `orchestrator.orca_binary` | Orca is installed here – the executable is `orca-ide`, with `orca` as an alternative on some installs |
| `orchestrator.hosting_this_session` | Which orchestrator's terminal pane this very session is running in, read from the variable each one exports: `ORCA_PANE_KEY` for Orca, `HERDR_ENV` for herdr |
| `browser.agent_browser_binary` | The `agent-browser` command-line tool, which is what drives a browser during verification |
| `browser.bridge_port_answers` | Something answered on local port 19988, which is where the Playwriter bridge – a reverse-SSH setup that lets an agent on this machine drive a real Chrome browser on the developer's own machine – forwards that browser's debugging port |
| `browser.chromium_binaries` | Chromium-family browsers found on this machine, which is what headless verification launches |
| `browser.display` | A graphical session exists (`DISPLAY` or `WAYLAND_DISPLAY` is set), without which nobody can watch a visible browser |
| `preview.tailscale_binary`, `preview.tailscale_logged_in` | Tailscale is installed, and separately whether anyone has logged it in – an installed but logged-out Tailscale publishes nothing |
| `element_picker.stagewise_binary` | `stagewise` is installed – an element picker, meaning a tool that lets the user click an element in the running app and hand the reference to an agent |
| `orca_topology.serve_unit_active` | A user-level service named exactly `orca` is running, which is the shape of a machine serving Orca to a viewer elsewhere. The name is an assumption: whatever provisions the server picks it, and nothing pins it yet. A unit installed under any other name reads here as "no server". The topology recommendation below then comes out `local` when this machine has Orca, and stays empty when it does not |
| `claude_settings.orca_hooks_present` | `~/.claude/settings.json` mentions Orca somewhere. The match is a loose, case-insensitive search for that word anywhere in the file, so an unrelated path or permission entry containing it counts too – this is evidence that Orca has wired its hooks in, not proof |
| `claude_settings.backup_exists` | `~/.claude/settings.json.bak` exists |
| `project.root`, `project.has_frontend` | The git repository the current directory sits in, and whether its `spechub/project.yaml` configures a frontend |

Several sections also carry a `recommended` field. That is the script's
mechanical reading of the evidence above it and nothing more. It is a starting
point for a question, never an answer.

## 2a. Orchestrators

```json
{
  "question": "Is herdr installed on this machine?",
  "header": "herdr",
  "options": [
    {"label": "yes", "description": "herdr is installed here. It owns terminal panes and creates worktrees under ~/.herdr/worktrees. <detected evidence, if any>"},
    {"label": "no", "description": "herdr is not installed here. <detected evidence, if any>"}
  ]
}
```

```json
{
  "question": "Is Orca installed on this machine?",
  "header": "Orca",
  "options": [
    {"label": "yes", "description": "Orca (stablyai/orca) is installed here. It owns panes and creates worktrees under ~/orca/workspaces. <detected evidence, if any>"},
    {"label": "no", "description": "Orca is not installed here. <detected evidence, if any>"}
  ]
}
```

Fill each `<detected evidence, if any>` placeholder from the Step 1 detection
output. Put the evidence into whichever option it supports, so the recommended
answer is the one carrying it. Judge each orchestrator on its own fields only –
herdr from `orchestrator.herdr_binary`, Orca from `orchestrator.orca_binary`,
and both from `orchestrator.hosting_this_session`, which names at most one of
them:

- `orchestrator.hosting_this_session` names this orchestrator – recommend yes:
  "detected: this session is running in a herdr pane", or the same sentence
  about Orca.

- Its binary is present – recommend yes: "detected: installed at `<path>`".
  When the session is also running in its pane, say both facts.

- Neither is true for it – recommend no: "not installed on this machine".

Leave a placeholder out entirely when there is nothing to say about that option.

## 2b. Browser-verification modes

```json
{
  "question": "Which browser-verification modes work on this machine?",
  "header": "Browser",
  "multiSelect": true,
  "options": [
    {"label": "remote", "description": "Drive a real browser on your own machine over the Playwriter bridge. <detected: something answers on port 19988 | nothing is answering on port 19988>"},
    {"label": "headless", "description": "Launch headless Chromium here – no window, no display needed. <detected: Chromium found at <path> | no Chromium-family browser found>"},
    {"label": "local", "description": "Launch a visible browser here – needs a graphical display. <detected: browser and display both present | no graphical display>"},
    {"label": "none of these", "description": "No browser verification works on this machine at all. This is an answer, not a skip: it declares all three modes false."}
  ]
}
```

A selected mode is `true`. An unselected mode is `false`.

The fourth option exists because a multi-select gives the user no way to press
"nothing". Choosing "none of these" writes all three axes –
`host.browser.remote`, `host.browser.headless` and `host.browser.local` – as
`false`. That is a declaration, not a skip: the user has said this machine
cannot verify in a browser, and Step 4 writes it.

If it comes back selected alongside a real mode, that is a contradiction; take
the named modes as the answer and ignore it.

The no-frontend branch below adds a fifth option, "Decide later". If that comes
back selected alongside "none of these", those two are opposites: one writes all
three axes `false`, the other writes nothing at all. Take "Decide later" as the
answer and write nothing.

An unset axis is recoverable. The next run of this skill asks again, and the
health check says plainly that the axis is missing.

A `false` written by mistake is not recoverable in the same way. It reads as a
decision the user made, so nothing asks again and the machine quietly looks
incapable.

When to treat the question as required: the browser axes become required as soon
as *any* project on this machine has a frontend. Nothing available here can see
that.

The detection output's `project.has_frontend` looks only at the git repository
the current directory sits in. So it reports on that one project, and says
nothing about the other checkouts on this machine.

So read it as a floor, not as the whole answer:

- `project.has_frontend` is true – ask with no escape. The modes have to be
  declared.

- It is false, or there is no SpecHub project in the current directory at all –
    still ask. The next project opened on this machine may well have a frontend,
    and this skill runs once per machine.

    Add a "Decide later" option, and state the consequence plainly. The three
    `host.browser.*` axes stay unset. The health check
    `~/.claude/spechub/bin/spechub config check` then fails the first time
    anyone runs it in a project that has a frontend.

## Step 3: The optional axes

1. **Preview publishing** (`host.preview.tailscale_serve`) – whether
    `tailscale serve` can publish this machine's dev server to the user's own
    private network. Another device can then open it. Options: yes, no, skip.

    Detection reports whether this machine has Tailscale
    (`preview.tailscale_binary`). It reports separately whether anyone has
    logged it in (`preview.tailscale_logged_in`). Put both facts in the option
    descriptions, because an installed-but-logged-out Tailscale publishes
    nothing.

2. **Element picker** (`host.element_picker`) – the tool that lets the user
    click an element in the running app. The user then hands that reference to
    an agent. Options: `stagewise`, `orca-design-mode`, `none`, skip.

    Say plainly that the config only records this axis. No skill changes its
    behaviour on it yet, so a wrong answer costs nothing today.

   Note that Orca's Design Mode needs the browser pane to render on the
   developer's own machine. So it is only a real option when Orca runs there.

3. **Orca topology** (`host.orca.topology`) – how Orca runs. Ask it only when
    the user answered yes to Orca in Step 2 of `SKILL.md`. Gate it on that answer, not
    on a config read, because nothing has written `host.orchestrators.orca` yet.

    Local runs Orca as a desktop application on the developer's own machine.
    Remote runs `orca serve` – Orca's headless server – on another machine, and
    the user views it through a paired client application. Options: local,
    remote, skip.

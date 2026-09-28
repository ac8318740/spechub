# Setup: report

`SKILL.md` decides when to read this file: every run ends at Step 14, and it runs from here.

## Step 14: Report

Run the health check one last time, then report what stands:

```
## SpecHub setup

Profile:      [profile]
Source:       [source dir]
Tests:        [tests dir]
Grilling:     [question tool/inline prose]
TDD:          [strict/relaxed]
Orchestrator: [strict/relaxed]
Spec sync:    [enabled/disabled]
Frontend:     [configured/not configured]
Browser:      [project's preferred mode / not configured]
Design:       [on / off / not asked]
Host:         [orchestrators + browser modes declared / not declared]
Workspace:    [yes / yes, n updates available / not installed / declined / not asked]
Config:       spechub/project.yaml
Domain map:   spechub/domain-map.yaml ([n] domains / starter – fill in)
Output style: spechub:ac-writing-style (global) | (project) | not set

Health check: [n] pass, [n] fail, [n] info

Next: describe what you want to build, or run /spechub:bootstrap for existing code.
```

Fill the `Host:` line and the `Orchestrator:` line from two different sources.
`Orchestrator:` is this project's delegation policy, read from
`workflow.tdd.orchestrator_strict` in `spechub/project.yaml`. It says whether
the coordinator may write code itself. `Host:` is about the machine. It names
which tool owns terminal panes and git worktrees, and which browser modes work
here.

The `host` skill declares both, and the global config holds them.

Fill `Workspace:` from `host.terminal_workspace`: `yes` on `true`, `declined` on
`false`, and `not asked` when it is unset.

The key records the answer, never the install. Setup writes it before anyone
runs the installer, so `yes` never claims this machine has the workspace. When
Step 12 asked in this run and the user said Yes, write `yes – run
/spechub:terminal-workspace` so the owed command stays on screen.

Two rows come from what `outdated` found in Step 12. Write `yes, n updates
available` when it reported stale or new components, with `n` as the number of
findings. Write `not installed` when it reported a `missing` row and the user
declined to install it.

Fill `Design:` from `workflow.design_review` and the `impeccable` row together:

- `on` when the key is `true` and the row is there
- `on – install open-designer and impeccable` when the key is `true` and no row
  is there

- `off` when the key is `false`
- `not asked` when the key states nothing, or the project has no frontend

That key records the answer too, never the install. The `impeccable` row is the
only thing here that reports what the machine has, so `on` alone never claims a
plugin the user has yet to install.

List every row still failing under the summary. Name the row and what it needs.

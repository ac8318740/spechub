# Host notes

Read this file when a `config set` call fails, or when the user asks one of three things:

- Where the answers live
- Why the skill finds the plugin root through a symlink
- What a declaration means

## Why this is per machine, not per project

The same repository gets opened on several machines, and those machines differ.
A laptop with a screen can launch a visible browser; a headless build server
cannot. One machine has herdr installed, another has Orca, another has neither.

None of that is a property of the project, so none of it belongs in the
project's config file.

The answers therefore go to the global config of the SpecHub command-line
interface. That is a JSON file at `~/.config/spechub/config.json`, or under
`$XDG_CONFIG_HOME` when you set that environment variable. Run
`~/.claude/spechub/bin/spechub config path` to print the real location.

They do not go in `spechub/project.yaml`.

Project concerns stay in `project.yaml`. In particular
`frontend.browser.mode` stays there as the *project's preference*, while
`host.browser.*` says what this *machine* can actually do. The two are
different questions, and they live in different files.

## Why Step 1 resolves the plugin root from a symlink

The path resolution looks odd, so here is why. The plugin's own files live in a
versioned cache directory. Its path changes on every release, so nobody can
hardcode it.

The one invariant path is `~/.claude/spechub/bin/spechub`, a symlink to the CLI
inside the current cache. The SessionStart hook re-points that symlink at the
start of every session, and Claude Code runs that hook.

The command in Step 1 of `SKILL.md` therefore derives the plugin root from the
symlink rather than from a written-down path.

## When a `config set` call fails (Step 4)

- **A rejected value.** The message names the allowed values for a key the tool
  knows. Re-ask rather than guessing at a different spelling – enum values are
  matched case-sensitively, so it is `stagewise`, never `Stagewise`.

- **An unknown key.** The message reads `Unknown config key "<key>"` and lists
  the host keys the tool does know. That is version skew: the command line tool
  in this plugin cache is older than these skills. `host.orchestrators.herdr`,
  `host.orchestrators.orca` and `host.orca.topology` are the newest axes, so
  they are the ones an old cached tool rejects.

- **Recovering from version skew.** Do not re-ask – the answer is not the
    problem, and re-asking a boolean axis only loops. Tell the user to restart
    Claude Code, so the SessionStart hook re-points
    `~/.claude/spechub/bin/spechub` at the current cache.

    Skip the axis and carry on. Do not report it to the user as their mistake.

## Notes

**Declared means installed.** Each of the two declarations says that this
machine has that orchestrator installed. They are independent, so both can be
true at once. Neither says that the orchestrator is hosting the current
session.

At worktree time, `/spechub:new-worktree` and `/spechub:teardown-worktree` run
the same detector. It reads the environment markers an orchestrator sets in the
terminals it opens, and those markers name the orchestrator hosting this
session. The markers are `HERDR_ENV` or `HERDR_PANE_ID` for herdr, and
`ORCA_PANE_KEY` for Orca.

When no marker holds a value, those skills use plain
git worktrees and say so. An environment variable for an orchestrator that was
never declared is worth a warning, not a refusal.

**The host declares, the project prefers.** `host.browser.*` says what this
machine can do. `frontend.browser.mode` in `spechub/project.yaml` says what the
project would like.

Today the only thing that compares the two is the SpecHub command-line
interface's own health check, `~/.claude/spechub/bin/spechub config check`.

It passes when the host declares the project's preferred mode available. It
passes with a note when the host does not. The note names the first mode the
host does declare, in the order remote, headless, local, as the one that would
stand in.

It fails when the host declares none of the three. That is a report about the
setup, not a choice made on the verifier's behalf.

Nothing under `agents/` or `skills/browser-verify/` reads `host.browser.*` yet,
so the frontend verifier still takes `frontend.browser.mode` at its word.
Teaching it to resolve the project's preference against the host, in the order
the check already uses, is still to come.

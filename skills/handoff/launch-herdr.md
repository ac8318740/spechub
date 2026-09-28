# Launch through herdr

`SKILL.md` decides when to read this file: herdr hosts this session and the
work goes to a new worktree or a new tab.

## Naming workspaces and tabs

herdr labels a new tab with a number, such as `1` or `2`. A user with four tabs
open cannot tell which agent works on what.

So every workspace and tab a handoff touches carries a descriptive label.
`label` is the only naming field herdr has. There is no `--name`, no `--title`,
and no `tab update`.

A tab label reads `<topic>-<thread>.<step>`.

- **topic** names the work in one or two words, lower-case and hyphenated, such
  as `auth-bug` or `csv-export`. For a new worktree it is the workspace slug
  already passed to `--label`, or a shortening of it. For a new tab it is the
  subject of the handoff.

- **thread** numbers a line of work inside the workspace. The numbering restarts
  in each workspace. So a handoff into a new worktree labels the receiving tab
  `<topic>-1.0`, and a handoff inside this workspace labels it `<topic>-1.1`.

- **step** counts the handoffs along that line.

    The session that started the line is step 0. The agent it hands to is
    step 1. That agent's own handoff is step 2.

Keep the topic to two words at most, so the whole label fits the tab strip.

| Tab label      | Who holds it                                      |
| -------------- | ------------------------------------------------- |
| `auth-bug-1.0` | the session that started the line of work         |
| `auth-bug-1.1` | the agent that session hands to                   |
| `auth-bug-1.2` | the agent the step 1 agent hands to               |
| `auth-bug-2.0` | a fresh line of work started in the same workspace |

Read the labels already in use before you create a tab, so the new one continues
the numbering instead of colliding with it:

```bash
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
# {"result":{"tabs":[{"tab_id":"w1X:t1","label":"1","number":1}]}}
```

Find this session's own tab in that list. `$HERDR_TAB_ID` names it. herdr sets
that variable in every managed pane, so an empty value means this session sits
in no herdr pane. Skip the rename of this session's tab then, and never fall
back to the focused tab. The focused tab belongs to whichever pane the user is
looking at, which is often another workspace.

A label of digits only is still the herdr default. Rename such a tab before you
create its successor, so the pair reads as a sequence:

```bash
herdr tab rename <tab_id> <topic>-<thread>.0
```

Rename another tab only when its label is digits only. Any other label may be
one the user or another agent set. Leave it alone.

A new worktree gets its workspace label from `herdr worktree create --label
<slug>`. Rename the workspace when that slug is long, or says little to a
reader – one or two words plus the branch intent:

```bash
herdr workspace rename <workspace_id> <label>
```

The first tab of a new workspace is the spare root pane's tab. Rename it to
`<topic>-1.0` after `worktree create`.

Read its tab id from the create JSON, or from
`herdr tab list --workspace <new_ws_id>`. Never hardcode a tab id.

Match the agent name in `herdr agent start <name>` to the tab label. The handle
regex is `[a-z][a-z0-9_-]{0,31}`, which allows no dot. So the agent whose tab is
`auth-bug-1.1` takes the name `auth-bug-1-1`.

## Launch: a new worktree, for separate work

```bash
cd <main-repo-root> && git fetch origin --quiet && \
herdr worktree create --cwd "<main-repo-root>" --branch <branch> --base <base> \
  --label <slug> --no-focus
# read .result.root_pane.pane_id from the JSON – never hardcode
# .result.worktree.path confirms where the checkout landed, for the report at the end

# name the workspace's first tab – read its tab id from the JSON, never hardcode
herdr tab rename <root_tab_id> <topic>-1.0

# the quoted prompt is the FRESH AGENT opener in SKILL.md – use it verbatim
herdr agent start <handoff-name> --kind claude --pane <root_pane_id> \
  -- "Before any other tool call, acknowledge this handoff by running ~/.claude/spechub/bin/spechub handoff ack accept --file <handoff-file> \"<one-line reason>\", or ack decline --file <handoff-file> \"<one-line reason>\". You may read <handoff-file> first to judge whether the work suits you, and nothing else until the command has run – the sender watches for the file it writes and cannot report this work as yours until it exists. Then continue that work."
```

`--label <slug>` names the workspace, and the rename names its first tab –
*Naming workspaces and tabs*, above, gives the format.

`<base>` is `origin/dev` when that ref exists, otherwise `origin/main` – the same
rule the `new-worktree` skill follows. Local `dev` is often behind. So the fetch
comes first, and the command cuts the branch from the remote ref.

Stop after `worktree create`. It already leaves a spare root shell pane in the
new workspace, and that is the pane the agent goes into.

The `new-worktree` skill's extra pane-move steps exist only because that skill
wants the caller to end up there. A handoff does not.

The agent name is the handle – `[a-z][a-z0-9_-]{0,31}`, unique among live
agents. Every `herdr agent` subcommand accepts it in place of a pane ID, and it
survives a pane move. So always name the agent something short that describes
the work.

Pass `--no-focus` on every create, so the user's view never jumps.

### When `agent start` times out

`agent start` can return `{"error":{"code":"timeout"}}` when the launch actually
worked. A timeout means the outcome is unknown, not failed, so check the pane
before concluding anything:

```bash
herdr pane get <pane-id>   # read .result.pane.agent_session.value
```

If `agent_session.value` is present, the launch succeeded. herdr never
registered the named handle. So use the pane ID in place of the agent name for
every later `herdr agent ...` command – they all accept a pane ID.

Use that value as the session id for the acknowledgement watcher.
`agent wait <name>` and `agent get <name>` return `agent_not_found` here. That
is normal, not a second failure.

If it is absent, wait a few seconds. Then check once more. Only then treat the
launch as failed and report it.

Report upstream. If the timeout reproduces, file it against herdr – the launch
succeeded, but herdr never registered the handle.

## Launch: a new tab, for a continuation

Same shape one level down – no new checkout, so no worktree:

```bash
herdr tab list --workspace "$HERDR_WORKSPACE_ID"   # the labels already in use
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label <topic>-<thread>.<step> --no-focus
# read the new tab's root pane ID from .result.root_pane.pane_id – same field the worktree's uses above
```

`--label` sets the tab label at creation – *Naming workspaces and tabs*, above,
gives the format and the numbering.

Then `herdr agent start` into that pane, exactly as above – same fresh-agent
opener, same handoff file path.

## The trust dialog

Handle this, or the launch hangs silently. A new worktree is a new directory, so
the launched session asks the user to trust the directory. It then sits at
`blocked`, while `agent start` has *already* returned success with
`interactive_ready: true`.

Readiness is not proof the prompt is running. So after starting, wait for the
blocked state instead of polling by hand:

```bash
herdr agent wait <name> --until blocked --timeout <ms>
```

On `blocked`, accept the dialog with `herdr agent send-keys <name> enter`. Then
re-check by waiting for the session to start working:

```bash
herdr agent wait <name> --until working --timeout <ms>
```

If either wait times out, read the agent's current state directly with
`herdr agent get <name>` rather than guessing.

Throughout this section `<name>` is the pane ID instead, whenever the launch
timed out – see *When `agent start` times out*, above.

Such a launch may already be past the trust dialog. The pane can report
`agent_status: working`, so `herdr agent wait <pane-id> --until blocked` may
simply time out. Read the real state with `herdr agent get <pane-id>`, and carry
on from there.

Never write `hasTrustDialogAccepted` into `~/.claude.json`, and never edit any
security settings file. SpecHub does not touch those.

## Report the labels

For a launched agent, also name the workspace label and the tab label. Those are
what the user reads off the tab strip to find the pane.

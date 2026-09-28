# Setup: design review

`SKILL.md` decides when to read this file: Step 7 reported a `frontend-verification` row, so the project has a frontend and Step 13 runs from here.

## Step 13: Offer the design review

The design review is two plugins working on the frontend:

- **open-designer** writes a design you can look at before anyone builds it
- **impeccable** reviews a UI change against the product's own design rules

SpecHub needs neither, so this step offers and never assumes.

Ask it only of a project with a frontend. The health check in Step 7 reports a
`frontend-verification` row for those projects and for no others, so no such row
means no frontend. Go to Step 14.

Read what this project already decided:

```bash
~/.claude/spechub/bin/spechub config get workflow.design_review
```

On exit 0 the user has already answered, either way. Say nothing and go to
Step 14.

On any exit other than 0 or 2 the CLI is older than this skill and does not know
the key. Do not ask, and do not try to write the key. Say this instead, then go
to Step 14:

```
The spechub CLI on this machine predates workflow.design_review, so I cannot
record an answer. Restart Claude Code to relink the CLI, then run
/spechub:setup again.
```

The SessionStart hook repoints `~/.claude/spechub/bin/spechub` at every start,
so a restart is the whole fix.

On exit 2 nobody has answered yet. Ask once:

```json
{
  "question": "Turn on design review for this project's frontend?",
  "header": "Design",
  "options": [
    {"label": "Yes", "description": "You then install two plugins: open-designer, which writes a design you can look at before anyone builds it, and impeccable, which reviews a UI change against the product's design rules. Both are reversible."},
    {"label": "No", "description": "Leave this project as it is. Nothing in SpecHub needs either plugin, and setup never asks again."}
  ]
}
```

Write the answer, whichever way it went:

```bash
~/.claude/spechub/bin/spechub config set workflow.design_review true   # or false
```

Write it before doing anything else. The answer is the user's, and two plugins
they never get round to installing must not bring the question back on the next
run.

On **Yes**, hand the install to the user. Print these lines, then go to Step 14:

```
Recorded. Install the two plugins yourself – the installer is reserved for you
to start:

  /plugin marketplace add ac8318740/ac-agentic-coding
  /plugin install open-designer@ac-agentic-coding

  /plugin marketplace add pbakaus/impeccable
  /plugin install impeccable@impeccable

Then run /impeccable init once. It writes PRODUCT.md, the file the design
review reads.
```

Three things this step never does:

- It never runs an install. Both plugins change what Claude Code loads, so the
  user starts them.

- It never writes `PRODUCT.md`. `/impeccable init` owns that file, and a second
  writer collides with it.

- It never copies a file out of impeccable. Setup names the plugin and stops
  there.

`spechub config check` grows an `impeccable` row once the user installs the
plugin, so a later `/spechub:setup` run confirms the install landed.

On **No**, go straight to Step 14. Name neither plugin again, and do not ask
again.

The key records the answer, never the install. Setup writes it before the user
installs anything, so `true` never claims either plugin is here.

# The audit and polish pass

Step 5 in `SKILL.md` runs the pipeline in eight numbered steps. `SKILL.md`
states when steps 5 to 7 run. This file holds how to run them.

5. **`/impeccable audit`** – report design findings on the changed frontend
   files. The audit edits nothing. It needs no browser.

    You type the command yourself. impeccable's plugin loads it into your chat
    as a markdown playbook.

    Read the design gate with `~/.claude/spechub/bin/spechub design-gate`.

    The file list is the one the checker derived in its section 5.5, from
    `git status --porcelain -- <frontend.directory>`.

6. **`/impeccable polish`** – fix the same files. Polish reads the audit
   findings as its backlog. It edits source.

    You type this command yourself too.

    Tell polish to leave a factual claim in copy untouched. Tell it to list
    every such claim in its report.

    Only `polish` runs from the audit's "Recommended Actions". Tell the audit
    to name each other command against the finding that earned it.

    Name `harden`, `clarify`, `adapt`, `optimize`, and `onboard` in your
    completion report, so the user can pick one later.

7. **task-checker subagent, second run** – polish changed the code, so verify
   it again. This run happens only when polish ran.

# Pre-commit review: interactive mode

Step 6 of `SKILL.md` in interactive mode, the default.

Present findings in **waves of up to 4** using AskUserQuestion. Group related findings together.

Format each wave like:

```
I found these issues in your changes. For each, choose: FIX / SKIP / DISCUSS

1. [MUST | HARDCODE] `path/to/file.py:42`
   Hardcoded timeout value `30` – should use config constant.
   Suggested fix: Move to config, reference from there.

2. [SHOULD | SSOT] `path/to/api/client.ts:15`
   Duplicated error handling pattern – same try/catch in 3 functions.
   Suggested fix: Extract shared wrapper function.

3. [CONSIDER | ADJACENT] `path/to/component.tsx:88`
   Existing code (not your change) has a magic string – should use constant.
   Suggested fix: Add constant, use in both places.

4. [SHOULD | EDGE-CASE] `path/to/manager.py:120`
   No null check on response before accessing `.status`.
   Suggested fix: Add guard clause with appropriate error.

Reply with numbers to fix (e.g., "1,2,4") or "all" or "skip all", and any notes on approach.
```

After user responds:

- Fix selected items via task-executor subagents (parallelize independent fixes)
- Present next wave if more findings remain
- Continue until all findings addressed or user says "done" / "skip the rest"

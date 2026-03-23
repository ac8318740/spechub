---
name: commit
description: Create git commit(s) with proper pre-commit hook handling, MECE commit messages, safe staging, and automatic living spec updates. Invoke via /commit.
argument-hint: "[scope: 'all', or describe which changes]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

Scope argument: "all" commits everything (staged + unstaged + untracked), or describe which changes to include (e.g., "just the frontend changes", "only the auth module"). Defaults to "all" if no argument given.

## Step 1: Analyze Changes

1. Run `git status` to see all changed files
2. Run `git diff` and `git diff --cached` to see content of changes
3. Run `git log --oneline -5` to see recent commit style
4. Determine scope from `$ARGUMENTS`

## Step 2: Plan Commits

Analyze changes and decide: one commit or multiple?

**Multiple commits when** changes are MECE (mutually exclusive, collectively exhaustive) across different concerns:

- Different features/fixes in different files
- Test changes separate from implementation
- Config changes separate from code changes

**Single commit when** all changes serve one purpose.

## Step 3: Draft Commit Message(s)

For each planned commit:

- Summarize the "why" not the "what"
- Use conventional commit format: `type: description`
- Types: feat, fix, refactor, docs, chore, test, style, perf
- Keep first line under 72 characters
- Add body for complex changes

## Step 4: Spec Sync (Automatic)

**After drafting the commit message but BEFORE creating the commit:**

1. Read `openspec/domain-map.yaml` (if exists)
2. Map staged files to spec domains
3. For each affected domain where `openspec/specs/[domain]/spec.md` exists:
   - Analyze what the staged changes add, modify, or remove
   - Generate lightweight ADDED/MODIFIED/REMOVED entries
   - Update the domain's spec.md
4. Stage any updated spec files
5. Include spec updates in the commit

**Skip spec sync when:**

- No `openspec/domain-map.yaml` exists
- Changed files don't match any domain
- Changes are docs/config only (no behavioral changes)
- No spec.md exists for affected domains (don't create from scratch here)

## Step 5: Stage and Commit

1. Stage files according to scope
2. Do NOT stage sensitive files (.env, credentials, secrets)
3. Create the commit with message ending with:
   `Co-Authored-By: Claude <noreply@anthropic.com>`
4. Use HEREDOC format for commit message
5. Run `git status` after to verify

## Step 6: Handle Pre-commit Hook Failures

If commit fails due to pre-commit hooks:

1. Read the hook output to understand the failure
2. Fix the issue (formatting, linting, secrets detection)
3. Re-stage fixed files
4. Create a NEW commit (never amend)

## Important Rules

- NEVER use `--no-verify` to skip hooks
- NEVER amend existing commits unless explicitly asked
- NEVER push unless explicitly asked
- NEVER stage `.env`, credentials, or secret files
- NEVER use `git add -A` or `git add .` — stage specific files
- Always create NEW commits after hook failures
- Prefer specific file staging over broad patterns

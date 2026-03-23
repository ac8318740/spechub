---
name: test-conventions
description: Test placement rules and framework conventions. Invoke before writing ANY test. Provides file location decision tree, naming conventions, and layer guidance (unit, integration, E2E). Triggers on writing new tests, creating test files, or test-writer agent starting work.
---

# Test Conventions

## Decision Tree: Where Does My Test Go?

Read `openspec/project.yaml` for `directories.source`, `directories.tests`, and `frontend` config.

```
Backend code?             → <tests-dir>/<mirror-source-path>/test_<module>.py
Frontend component/hook?  → <frontend-dir>/src/<path>/__tests__/<Name>.test.tsx
Browser-based user flow?  → <frontend-dir>/tests/<feature>.spec.ts
Visual regression?        → <frontend-dir>/tests/visual-regression.spec.ts
```

## Layer 1: Backend Unit Tests

Mirror the source directory structure. Example: `src/auth/sessions.py` → `tests/auth/test_sessions.py`.

- Create `__init__.py` in new subdirectories (Python)
- Cross-cutting integration tests → `<tests-dir>/integration/`
- Shared fixtures → `<tests-dir>/conftest.py` (Python) or shared setup files
- Use markers for slow/integration tests (configured in `test_markers.exclude`)
- Run with the `commands.test` command from project.yaml
- Baseline: `.test-baseline` – count must never drop

## Layer 2: Frontend Unit Tests

Colocated with source. Example: `src/hooks/useAuth.ts` → `src/hooks/__tests__/useAuth.test.ts`.

- Components: `.test.tsx`, pure functions: `.test.ts`
- Run with `frontend.commands.test` from project.yaml

## Layer 3: E2E Tests (Playwright)

One file per feature or user flow. Example: `tests/login-flow.spec.ts`.

- Auth setup: save auth state to a storage file, reuse across tests
- Credentials: use environment variables (gitignored `.env.test`)
- Agent/async tests: use generous timeouts, take screenshots at key steps
- Run with `npx playwright test --project=chromium`

## Naming Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Python test file | `test_<module>.py` | `test_sessions.py` |
| Python test function | `test_<behavior>` | `test_expired_token_returns_401` |
| JS/TS test file | `<Name>.test.ts(x)` | `useAuth.test.ts` |
| Playwright spec | `<feature>.spec.ts` | `login-flow.spec.ts` |

## Gitignored Artifacts (never commit)

- Playwright state directories, test results, reports
- Coverage output
- Test environment files (`.env.test`)

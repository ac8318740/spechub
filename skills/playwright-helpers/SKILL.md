---
name: playwright-helpers
description: Create and maintain modular Playwright test helpers for a project. Scaffolds a reusable helper library with domain-specific modules (navigation, components, assertions, screenshots) that agents use when writing browser tests. Invoke when setting up frontend verification or when a new helper is needed.
---

# Playwright Test Helpers

## Purpose

Create a modular, reusable helper library for Playwright-based browser testing. This library makes it easier for agents (especially the frontend-verifier and test-writer) to write reliable browser tests without reimplementing common operations.

## Project Configuration

Read `openspec/project.yaml` for:

- `frontend.directory` – frontend source directory
- `frontend.dev_server_url` – dev server URL
- `frontend.helpers_dir` – path to helper library (default: `<frontend.directory>/tests/helpers/`)

## Library Structure

The helper library follows a **facade + domain helpers** pattern:

```
<helpers_dir>/
├── verify-helpers.js          # Plain JS facade (for generated verification scripts)
├── index.ts                   # TypeScript facade (for @playwright/test)
├── navigation-helpers.ts      # URL handling, page navigation, waiting
├── component-helpers.ts       # Project-specific component interactions
├── assertion-helpers.ts       # Custom assertions and result tracking
├── screenshot-helpers.ts      # Screenshot capture and labeling
├── constants.ts               # Stable selectors and test constants
└── VERIFICATION-KNOWLEDGE.md  # Evolving knowledge base (gotchas, patterns)
```

## Scaffolding a New Helper Library

When a project doesn't have helpers yet, create the foundation:

### 1. Create the directory

```bash
mkdir -p <helpers_dir>
```

### 2. Create verify-helpers.js (plain JS facade)

This is the main entry point for generated verification scripts. It must export:

| Function | Purpose |
|----------|---------|
| `setup(options?)` | Launch browser with optional auth, return `{ browser, context, page }` |
| `teardown(browser)` | Close browser cleanly |
| `screenshot(page, name)` | Take named screenshot to /tmp/ |
| `createAssertions()` | Return `{ assert, results }` tracker |
| `waitFor(checkFn, options?)` | Poll for condition with timeout |
| `SELECTORS` | Object of stable selectors for the project |

Template:

```javascript
const { chromium } = require('playwright');
const path = require('path');

const DEV_URL = '<frontend.dev_server_url>';

const SELECTORS = {
  // Add project-specific selectors here
  // Prefer data-testid attributes over CSS classes
};

async function setup(options = {}) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(options.storageState
    ? { storageState: options.storageState }
    : {});
  const page = await context.newPage();
  return { browser, context, page };
}

async function teardown(browser) {
  if (browser) await browser.close();
}

async function screenshot(page, name) {
  const filepath = `/tmp/verify-${name}.png`;
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
  return filepath;
}

function createAssertions() {
  const log = [];
  function assert(condition, label) {
    const status = condition ? 'PASS' : 'FAIL';
    log.push({ status, label });
    console.log(`${status}: ${label}`);
  }
  function results() {
    const passed = log.filter(r => r.status === 'PASS').length;
    const failed = log.filter(r => r.status === 'FAIL').length;
    return { passed, failed, total: log.length, log };
  }
  return { assert, results };
}

async function waitFor(checkFn, { timeout = 30000, interval = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await checkFn()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

module.exports = {
  setup, teardown, screenshot, createAssertions, waitFor,
  SELECTORS, DEV_URL,
};
```

### 3. Create TypeScript helpers (for @playwright/test)

Each helper class is a focused module:

**navigation-helpers.ts** – Detect dev server URL, navigate to routes, wait for page ready, collect console errors.

**component-helpers.ts** – Project-specific interactions (forms, buttons, modals, etc.). Start empty, grow as tests discover patterns.

**assertion-helpers.ts** – Custom expect helpers beyond Playwright's built-in assertions.

**screenshot-helpers.ts** – Capture labeled screenshots (before/after/error), viewport management.

**constants.ts** – Stable selectors (prefer `data-testid`), test user credentials, URLs.

**index.ts** – Facade class that composes all helpers:

```typescript
import { Page } from '@playwright/test';
import { NavigationHelpers } from './navigation-helpers.js';
import { ComponentHelpers } from './component-helpers.js';
import { ScreenshotHelpers } from './screenshot-helpers.js';

export class TestHelpers {
  readonly nav: NavigationHelpers;
  readonly components: ComponentHelpers;
  readonly screenshot: ScreenshotHelpers;

  constructor(page: Page) {
    this.nav = new NavigationHelpers(page);
    this.components = new ComponentHelpers(page);
    this.screenshot = new ScreenshotHelpers(page);
  }
}
```

### 4. Create VERIFICATION-KNOWLEDGE.md

Start with an empty template:

```markdown
# Verification Knowledge Base

Evolving reference for browser-based verification. Updated by the frontend-verifier agent after each run.

## URL Patterns

<!-- Add URL patterns and routing rules here -->

## Selectors That Work

<!-- Add stable selectors discovered during testing -->

## Gotchas & Lessons Learned

<!-- Add issues and workarounds discovered during testing -->

## Proven Script Patterns

<!-- Add script templates that work reliably -->
```

## Adding New Helpers

When an agent (frontend-verifier or test-writer) needs a helper that doesn't exist:

1. **Add it to the appropriate helper file** – navigation goes in navigation-helpers, component interactions in component-helpers, etc.
2. **Export it from the facade** (index.ts and/or verify-helpers.js)
3. **Never inline reusable logic in test scripts** – if you wrote it once and might need it again, make it a helper

## Selector Strategy

Prefer selectors in this order:

1. `data-testid="..."` – most stable, survives refactors
2. `role` selectors – `page.getByRole('button', { name: '...' })`
3. `text` selectors – `page.getByText('...')`
4. CSS selectors – last resort, fragile

When a selector breaks, update `constants.ts` and `VERIFICATION-KNOWLEDGE.md`.

## Integration Points

- **frontend-verifier agent** uses `verify-helpers.js` for generated scripts
- **test-writer agent** uses TypeScript helpers for @playwright/test specs
- **task-checker agent** uses helpers to verify frontend changes
- **/spechub:init** scaffolds the helper directory when Playwright is installed

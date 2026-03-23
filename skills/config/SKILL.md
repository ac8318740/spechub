---
name: config
description: View or modify SpecHub workflow settings in spechub/project.yaml. Use to change workflow tier, toggle spec sync, adjust TDD strictness, or view current config.
argument-hint: "[show | set <key> <value> | reset]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## What This Skill Does

Read or modify the `workflow` section of `spechub/project.yaml` without hand-editing YAML.

## Commands

### `show` (default if no arguments)

Read `spechub/project.yaml` and display the current workflow configuration:

```
## SpecHub Workflow Configuration

Tier:        feature (auto-select: on)
Spec sync:   enabled
TDD:         strict
Orchestrator: strict (delegates all code work)
Frontend:    verification enabled

Full config: spechub/project.yaml
```

### `set <key> <value>`

Modify a workflow setting. Supported keys:

| Key | Values | Description |
|-----|--------|-------------|
| `workflow.default_tier` | `patch`, `feature`, `project`, `initiative` | Minimum workflow tier |
| `workflow.auto_select` | `true`, `false` | Let orchestrator pick above minimum |
| `workflow.spec_sync` | `true`, `false` | Mandatory spec sync at commit |
| `workflow.tdd.strict` | `true`, `false` | Require TDD pipeline for feature+ |
| `workflow.tdd.orchestrator_strict` | `true`, `false` | Orchestrator delegates all code work |
| `workflow.frontend_verification` | `true`, `false` | Require frontend verification |

Examples:
- `/spechub:config set workflow.default_tier project`
- `/spechub:config set workflow.tdd.strict false`
- `/spechub:config set workflow.spec_sync false`

### `reset`

Reset all workflow settings to defaults:

```yaml
workflow:
  default_tier: feature
  auto_select: true
  spec_sync: true
  tdd:
    strict: true
    orchestrator_strict: true
  frontend_verification: true
```

## Steps

### 1. Read Current Config

Read `spechub/project.yaml`. If it doesn't exist, tell the user to run `/spechub:init` first.

### 2. Execute Command

- **show**: Display formatted config summary
- **set**: Parse the key path, validate the value, update the YAML, write it back
- **reset**: Replace the `workflow` section with defaults, preserve all other sections

### 3. Confirm

After any modification:
1. Write the updated `spechub/project.yaml`
2. Show the changed setting and its new value
3. Note any implications (e.g., "TDD is now relaxed – test-writer phase will be skipped for feature-tier work")

## Validation Rules

- `default_tier` must be one of: `patch`, `feature`, `project`, `initiative`
- Boolean values accept: `true`/`false`, `on`/`off`, `yes`/`no` (normalize to `true`/`false`)
- If `workflow` section doesn't exist in project.yaml, create it with defaults before applying changes
- Never modify non-workflow sections of project.yaml

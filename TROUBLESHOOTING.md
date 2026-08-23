# SpecHub troubleshooting

**Claude Code instances** act on this file. Each section follows the same format: symptom -> diagnostic command -> fix command. If you are a Claude Code session and the user reports any of these symptoms, run the diagnostic, then apply the fix.

The plugin lives at `${CLAUDE_PLUGIN_ROOT}` once the user installs it via the marketplace. On most installs that resolves to:

```
~/.claude/plugins/cache/ac8318740-plugins/spechub/<version>/
```

The plugin's SessionStart hook maintains two symlinks to the bundled CLI:

- `~/.claude/spechub/bin/spechub` – the **agent-facing** invariant path. Skills and agents in this plugin invoke the CLI through this exact path. It does not depend on the user's `PATH`.
- `~/.local/bin/spechub` – the **human convenience** symlink. Only useful when `~/.local/bin` is on `PATH`. Not load-bearing for any plugin functionality.

Both refresh on every SessionStart and point at the current plugin cache version. The agent-facing path is the one to fix first when something is wrong – nothing in the plugin works without it.

---

## 1. Agents report `~/.claude/spechub/bin/spechub: No such file or directory`

**Symptom**: A skill or agent fails because it cannot find the CLI at `~/.claude/spechub/bin/spechub`.

**Diagnose**:

```bash
ls -l ~/.claude/spechub/bin/spechub 2>&1
ls -d ~/.claude/plugins/cache/ac8318740-plugins/spechub/*/ 2>&1
```

**Possible causes and fixes**:

- **Symlink missing** (`No such file or directory`): The SessionStart hook never ran. The user has not started Claude Code on this device since they installed the plugin, OR the hook silently failed.
  - Fix: ask the user to restart Claude Code so the SessionStart hook fires. The hook creates the symlink and prints `spechub: linked agent CLI at …`.
  - If that doesn't work, create it manually:
    ```bash
    SPECHUB_VERSION=$(ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/ | sort -V | tail -1)
    mkdir -p ~/.claude/spechub/bin
    ln -sfn ~/.claude/plugins/cache/ac8318740-plugins/spechub/$SPECHUB_VERSION/cli/bin/spechub.js ~/.claude/spechub/bin/spechub
    ```

- **Plugin cache missing entirely**: the second `ls` returned nothing.
  - Fix: the user has not installed the plugin. Run `/plugin install` for `ac8318740/spechub` in Claude Code.

---

## 2. `spechub: command not found` (human typed it at a terminal)

**Symptom**: User runs `spechub --help` at the terminal and the shell reports `command not found`. Agents continue to work fine.

This is a **human-ergonomics issue, not a plugin issue.** Agents use `~/.claude/spechub/bin/spechub` directly, so this issue does not affect them. Skip to fixing only if the user types `spechub` at terminals.

**Diagnose**:

```bash
ls -l ~/.local/bin/spechub 2>&1
echo "PATH=$PATH" | tr ':' '\n' | grep -F "$HOME/.local/bin" || echo "MISSING"
```

**Possible causes and fixes**:

- **Symlink missing**: The SessionStart hook never ran (or ran but couldn't write). Ask the user to restart Claude Code; the hook recreates the human symlink on every session start.
- **PATH missing** (symlink exists but `MISSING` printed): `~/.local/bin` is not on `$PATH`.
  - Fix: add this line to the user's shell rc and ask them to restart their shell:
    ```bash
    export PATH="$HOME/.local/bin:$PATH"
    ```
    Shell rc by shell:
    - zsh: `~/.zshrc`
    - bash on Linux: `~/.bashrc`
    - bash on macOS: `~/.bash_profile`
    - fish: `~/.config/fish/config.fish` (use `set -gx PATH $HOME/.local/bin $PATH`)

---

## 3. `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/cli/dist/index.js'`

**Symptom**: The CLI runs but Node throws `ERR_MODULE_NOT_FOUND` for `dist/index.js`.

**Diagnose**:

```bash
SPECHUB_VERSION=$(ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/ | sort -V | tail -1)
ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/$SPECHUB_VERSION/cli/dist/index.js 2>&1
```

**Cause**: The plugin cache holds a version from before the CLI shipped bundled in the repo (pre-0.9.2). This should not happen on 0.9.2 or later.

**Fix**:

- Bump or refresh the plugin cache: in Claude Code, run `/plugin` and reinstall the plugin, or delete the cache directory and let Claude Code repull:
  ```bash
  rm -rf ~/.claude/plugins/cache/ac8318740-plugins/spechub/<old-version>
  ```
- Confirm the user is on plugin version 0.9.2 or later:
  ```bash
  cat ~/.claude/plugins/cache/ac8318740-plugins/spechub/*/.claude-plugin/plugin.json | grep version
  ```

If the user is offline or cannot repull, build the CLI in place as a one-shot:

```bash
cd ~/.claude/plugins/cache/ac8318740-plugins/spechub/<version>/cli
npm install
npm run build
```

---

## 4. Stale symlink – points at an old version

**Symptom**: `~/.claude/spechub/bin/spechub --version` prints an older number than expected, OR commands behave like an older release.

**Diagnose**:

```bash
readlink ~/.claude/spechub/bin/spechub
ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/
```

**Cause**: An older session set the symlink target. The plugin cache now holds a newer version, and the SessionStart hook has not relinked it yet.

**Fix**:

- Start a new Claude Code session – the SessionStart hook detects stale symlinks and relinks them, printing `spechub: updated agent CLI at …`.
- Or relink manually:
  ```bash
  NEW=$(ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/ | sort -V | tail -1)
  ln -sfn ~/.claude/plugins/cache/ac8318740-plugins/spechub/$NEW/cli/bin/spechub.js ~/.claude/spechub/bin/spechub
  ln -sfn ~/.claude/plugins/cache/ac8318740-plugins/spechub/$NEW/cli/bin/spechub.js ~/.local/bin/spechub
  ```

---

## 5. SessionStart hook didn't run

**Symptom**: No `spechub:` lines appear in Claude Code's startup logs, and `~/.claude/spechub/bin/spechub` is missing.

**Diagnose**:

```bash
cat ~/.claude/plugins/cache/ac8318740-plugins/spechub/*/hooks/hooks.json
```

**Cause**: Either the user has not yet enabled the plugin, or they have disabled hook execution in their Claude Code settings.

**Fix**:

- Confirm the user has enabled the plugin: `/plugin list`.
- Check that the user has not disabled hooks in `~/.claude/settings.json` (no `"hooks": false` or per-event suppression).
- As a fallback, install the symlinks manually using the commands in section 1 and section 4.

---

## 6. `python3 not found` warning at session start

**Symptom**: Hook prints `spechub: python3 not found; skipping orchestrator injection`.

**Cause**: The hook uses `python3` to emit the orchestrator CLAUDE.md as JSON for `additionalContext` injection. Without it, the orchestrator instructions still load – but only when Claude Code itself reads `CLAUDE.md` from the plugin root, which it does anyway. This does not affect the CLI symlinks.

**Fix**: Install Python 3 if you want the explicit injection (rare – most systems have it):

```bash
# Debian/Ubuntu
sudo apt install python3
# macOS
brew install python3
```

Otherwise, ignore the warning.

---

## When in doubt

The CLI is a normal Node.js ESM package. To validate the install end-to-end:

```bash
SPECHUB_VERSION=$(ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/ | sort -V | tail -1)
node ~/.claude/plugins/cache/ac8318740-plugins/spechub/$SPECHUB_VERSION/cli/bin/spechub.js --help
```

If that prints help, the CLI is fine and the issue is the symlink. If it errors, the issue is the cache contents – jump to section 3.

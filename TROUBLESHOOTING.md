# SpecHub Troubleshooting

This file is written for **Claude Code instances** to act on. Each section follows the same format: symptom -> diagnostic command -> fix command. If you are a Claude Code session and the user reports any of these symptoms, run the diagnostic, then apply the fix.

The plugin lives at `${CLAUDE_PLUGIN_ROOT}` once installed via the marketplace. On most installs that resolves to:

```
~/.claude/plugins/cache/ac8318740-plugins/spechub/<version>/
```

---

## 1. `spechub: command not found`

**Symptom**: User runs `spechub --help` (or any spechub command) and the shell reports `command not found`.

**Diagnose**:

```bash
ls -l ~/.local/bin/spechub 2>&1
echo "PATH=$PATH" | tr ':' '\n' | grep -F "$HOME/.local/bin" || echo "MISSING"
```

**Possible causes and fixes**:

- **Symlink missing** (`No such file or directory`): The SessionStart hook never ran. The user has not started Claude Code on this device since the plugin was installed, OR the hook silently failed.
  - Fix: ask the user to run any Claude Code command (e.g. open the project) so the SessionStart hook fires. The hook will create the symlink and print `spechub: linked CLI at …`.
  - If that doesn't work, create it manually:
    ```bash
    mkdir -p ~/.local/bin
    ln -sfn ~/.claude/plugins/cache/ac8318740-plugins/spechub/<version>/cli/bin/spechub.js ~/.local/bin/spechub
    ```
    Replace `<version>` with the version from `~/.claude/plugins/cache/ac8318740-plugins/spechub/`.

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

## 2. `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/cli/dist/index.js'`

**Symptom**: `spechub --help` runs but Node throws `ERR_MODULE_NOT_FOUND` for `dist/index.js`.

**Diagnose**:

```bash
SPECHUB_VERSION=$(ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/ | sort -V | tail -1)
ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/$SPECHUB_VERSION/cli/dist/index.js 2>&1
```

**Cause**: The plugin cache contains a version that was published *before* the built CLI was bundled into the repo (pre-0.9.2). This should not happen on 0.9.2 or later.

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

## 3. Stale cache – symlink points at an old version

**Symptom**: `spechub --version` prints an older number than expected, OR commands behave like an older release.

**Diagnose**:

```bash
readlink ~/.local/bin/spechub
ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/
```

**Cause**: The symlink target was set during an older session and the plugin cache now has a newer version that the SessionStart hook hasn't relinked yet.

**Fix**:

- Start a new Claude Code session – the SessionStart hook detects stale symlinks and relinks them, printing `spechub: updated CLI at …`.
- Or relink manually:
  ```bash
  NEW=$(ls ~/.claude/plugins/cache/ac8318740-plugins/spechub/ | sort -V | tail -1)
  ln -sfn ~/.claude/plugins/cache/ac8318740-plugins/spechub/$NEW/cli/bin/spechub.js ~/.local/bin/spechub
  ```

---

## 4. SessionStart hook didn't run

**Symptom**: No `spechub:` lines appear in Claude Code's startup logs, and the symlink is missing.

**Diagnose**:

```bash
cat ~/.claude/plugins/cache/ac8318740-plugins/spechub/*/hooks/hooks.json
```

**Cause**: Either the user has not yet enabled the plugin, or hook execution is disabled in their Claude Code settings.

**Fix**:

- Confirm the plugin is enabled: `/plugin list`.
- Check that hooks are not disabled in `~/.claude/settings.json` (no `"hooks": false` or per-event suppression).
- As a fallback, install the symlink manually using the command in section 1.

---

## 5. `python3 not found` warning at session start

**Symptom**: Hook prints `spechub: python3 not found; skipping orchestrator injection`.

**Cause**: The hook uses `python3` to emit the orchestrator CLAUDE.md as JSON for `additionalContext` injection. Without it, the orchestrator instructions still load – but only when Claude Code itself reads `CLAUDE.md` from the plugin root, which it does anyway. The CLI symlink is unaffected.

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

If that prints help, the CLI is fine and the issue is PATH or symlink. If it errors, the issue is the cache contents – jump to section 2.

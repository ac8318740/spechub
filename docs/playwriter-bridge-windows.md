# Playwriter bridge, Windows laptop setup

*This document has moved. The `bridge` skill covers the bridge now.*

Where each part went:

- **Entry point**, platform detection and the handoff convention: [`../skills/bridge/SKILL.md`](../skills/bridge/SKILL.md)
- **Windows runbook**, what used to live in this file: [`../skills/bridge/SKILL-WINDOWS.md`](../skills/bridge/SKILL-WINDOWS.md)
- **Linux and dev-VM runbook**: [`../skills/bridge/SKILL-VM.md`](../skills/bridge/SKILL-VM.md)
- **Cross-device handoff format**: [`../skills/bridge/HANDOFF.md`](../skills/bridge/HANDOFF.md)

The scripts still ship under `plugins/spechub/assets/playwriter-bridge/`.

- `stop.ps1`, `doctor.ps1` and `vm-free-port.sh` are new since this relocation
- The Windows runbook covers their use

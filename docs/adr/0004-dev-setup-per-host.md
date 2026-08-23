# Dev setup is declared per host, not per project

A dev setup – the machine-level tools a SpecHub session runs inside, such as which agent orchestrator hosts the terminal panes and git worktrees and which browser-verification modes work – is recorded in the SpecHub CLI's global config (`~/.config/spechub/config.json`, keys under `host.*`), not in the project's `spechub/project.yaml`. The same repository is opened on several machines with different setups, so a per-project value would have to be wrong on all but one of them.

## Considered options

- `spechub/project.yaml`, like `frontend.browser.mode` – shareable and checked in, but forces one answer across every machine that opens the repo.
- Host-level global config, with project.yaml keeping only a preference where one makes sense – chosen.
- Both layers, with the project able to constrain the host – deferred; add only if a real conflict appears.

## Consequences

Skills that change behaviour on the dev setup read the global config first and then check the runtime environment to see what is actually active. The project's `frontend.browser.mode` becomes a preference resolved against what the host declares available. Host setup cannot be committed with the repo, so a fresh machine needs `/spechub:host` before worktree and browser skills behave fully.

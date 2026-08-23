# Glossary

**acknowledgement** – The receiver's ACCEPT or DECLINE, with a one-line reason, recorded by running `spechub handoff ack`. It is what lets the sender report the work as the receiver's.

**axis** – One dimension of a dev setup, such as the orchestrator or whether a browser-verification mode is available. Each axis is either required, meaning a host must declare a value, or an optional toggle.

**dev setup** – The machine-level tools a SpecHub session runs inside: the orchestrator that hosts terminal panes and git worktrees, the browser-verification modes that work on the machine, and optional extras such as publishing the dev server to a private network. Declared per host, not per project.

**durable artifact** – Any text an agent writes that someone reads later without the conversation that produced it. It covers architecture decision records, glossary entries, living specs and their functional requirements, map nodes, handoff files, READMEs and docs, and pull request bodies. Chat replies and commit subject lines are not durable artifacts.

**engaged** – A handoff watcher outcome: the receiving agent has not acknowledged, but has read the handoff file or started using work tools. The work is underway. Never relaunch it elsewhere.

**host** – The machine a session runs on, as distinct from the project it works in. The same project can be opened on several hosts with different dev setups.

**orchestrator** – The program that hosts agent terminal sessions and manages one git worktree per task, such as herdr or Orca. A host with no orchestrator uses plain git worktrees.

**shipped path** – A file that an installed copy of the plugin loads or runs, so a change to it must roll out to every machine. Everything not on the inert list in CONTRIBUTING.md is shipped.

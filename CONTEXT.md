# Glossary

**acknowledgement** – The receiver's ACCEPT or DECLINE, with a one-line reason, recorded by running `spechub handoff ack`. It is what lets the sender report the work as the receiver's.

**axis** – One dimension of a dev setup, such as the orchestrator or whether a browser-verification mode is available. Each axis is either required, meaning a host must declare a value, or an optional toggle.

**checkout** – One git worktree directory.

**checkout owner** – The orchestrator whose path root holds a checkout, which the owner removes. Orca owns `~/orca/workspaces/<repo>/`. Herdr owns its worktree root, `~/.herdr/worktrees/<repo>/` by default, and anything else is plain git.

**dev setup** – The machine-level tools a SpecHub session runs inside. It names the orchestrator that hosts terminal panes and git worktrees. It also names the browser-verification modes that work on the machine, plus optional extras such as publishing the dev server to a private network. A host declares its dev setup, and a project does not.

**durable artifact** – Any text an agent writes that someone reads later without the conversation that produced it. It covers architecture decision records, glossary entries, living specs and their functional requirements, map nodes, handoff files, READMEs and docs, and pull request bodies. Chat replies and commit subject lines are not durable artifacts.

**engaged** – A handoff watcher outcome: the receiving agent has not acknowledged, but has read the handoff file or started using work tools. The work is underway. Never relaunch it elsewhere.

**host** – One developer machine, as distinct from the project it works in. The SpecHub global config declares its dev setup, including which orchestrators the developer installed.

**orchestrator** – A tool that hosts agent terminal panes and git worktrees. Herdr and Orca are the two, and one host can run both at once.

**shipped path** – A file that an installed copy of the plugin loads or runs, so a change to it must roll out to every machine. The inert list in CONTRIBUTING.md names every path that does not ship. Every other path ships.

# Glossary

**acknowledgement** – The receiver's ACCEPT or DECLINE, with a one-line reason, recorded by running `spechub handoff ack`. It is what lets the sender report the work as the receiver's.

**arming** – Clicking the Playwriter extension's icon on a browser tab to attach it to the **relay** – third-party extension behaviour that nothing can automate. A **bridge** that is otherwise healthy stays unusable until someone arms a tab by hand.

**axis** – One dimension of a dev setup, such as the orchestrator or whether a browser-verification mode is available. Each axis is either required, meaning a host must declare a value, or an optional toggle.

**bridge** – A Chrome extension and a **relay** on the user's laptop. A development virtual machine reaches them over a **reverse tunnel**.

The bridge lets an agent drive a real browser over the Chrome DevTools Protocol (CDP). It does not show a page to a person – see **opener** for that.

**checkout** – One git worktree directory.

**checkout owner** – The orchestrator whose path root holds a checkout, which the owner removes. Orca owns `~/orca/workspaces/<repo>/`. Herdr owns its worktree root, `~/.herdr/worktrees/<repo>/` by default, and anything else is plain git.

**child session** – A subagent or a teammate, launched by another agent rather than by a person. It runs inside the **lead session**'s own process and shares that session's id, so no environment variable separates the two. A child reports its state to the lead, and never writes what the lead owns.

**dev setup** – The machine-level tools a SpecHub session runs inside. It names the orchestrator that hosts terminal panes and git worktrees. It also names the browser-verification modes that work on the machine, plus optional extras such as publishing the dev server to a private network.

A host declares its dev setup, and a project does not.

**durable artifact** – Any text an agent writes that someone reads later without the conversation that produced it. It covers architecture decision records, glossary entries, living specs and their functional requirements, map nodes, handoff files, READMEs and docs, and pull request bodies. Chat replies and commit subject lines are not durable artifacts.

**engaged** – A handoff watcher outcome: the receiving agent has not acknowledged, but has read the handoff file or started using work tools. The work is underway. Never relaunch it elsewhere.

**host** – One developer machine, as distinct from the project it works in. The SpecHub global config declares its dev setup, including which orchestrators the developer installed.

**lead session** – The session a person talks to, at the top of the agent tree. It alone hands work over or compacts, because it alone owns the context-pressure quiet marker and the `spechub/HANDOFF.md` anchor. A **child session** finds out it is not the lead by looking for its own transcript – see ADR 0007.

**opener** – A small HTTP service on the user's laptop. It stores a page rendered on a development virtual machine and serves it on an address only the laptop can reach (the loopback interface). It hands that address to the user's default browser, so a person sees the page – see **bridge** for the agent's route instead.

**opener token** – A shared secret that guards the **opener**. `register-tasks.ps1` generates it on the laptop and copies it to `~/.config/spechub/opener.token` on each development virtual machine. Every request the machine sends carries the token, and the opener answers HTTP 401 without it.

**orchestrator** – A tool that hosts agent terminal panes and git worktrees. Herdr and Orca are the two, and one host can run both at once.

**relay** – The process on the laptop that the Playwriter extension connects to, and that a development virtual machine reaches through the **reverse tunnel**. It is the laptop-side half of the **bridge**.

**reverse tunnel** – An SSH forward that lets a development virtual machine reach a port on the user's laptop. The laptop opens it, not the machine. `tunnel.ps1` holds one per machine for the **bridge**, and a second per machine for the **opener**.

**route** – The single named answer to "how does this machine reach a browser", decided in one place and printed by `spechub-open --why`. Every script asks for the route instead of working it out again.

**shipped path** – A file that an installed copy of the plugin loads or runs, so a change to it must roll out to every machine. The inert list in CONTRIBUTING.md names every path that does not ship. Every other path ships.

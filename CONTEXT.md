# Glossary

**arming** – clicking the Playwriter extension's icon on a browser tab to
attach it to the relay – third-party extension behaviour that nothing can
automate. A bridge that is otherwise completely healthy stays unusable until
someone arms a tab by hand.

**bridge** – a Chrome extension and relay on the user's laptop, reached from
a development virtual machine over a reverse SSH tunnel. It lets an agent
drive a real browser over the Chrome DevTools Protocol, not show a page to a
person – see **opener** for that.

**durable artifact** – any text an agent writes that someone reads later
without the conversation that produced it. It covers architecture decision
records, glossary entries, living specs and their functional requirements,
map nodes, handoff files, READMEs and docs, and pull request bodies. Chat
replies and commit subject lines are not durable artifacts.

**opener** – a small HTTP service on the user's laptop that stores a page
from a development virtual machine and serves it on the loopback interface.
It hands the address to the user's default browser, so a person sees the
page – see **bridge** for the agent's route instead.

**relay** – the process on the laptop that the Playwriter extension connects
to, and that a development virtual machine reaches through the reverse
tunnel. It is the laptop-side half of the **bridge**.

**route** – the single named answer to "how does this machine reach a
browser", decided in one place and printed by `spechub-open --why`. Callers
ask for the route rather than each working it out again.

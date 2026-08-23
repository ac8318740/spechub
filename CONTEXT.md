# Glossary

**arming** – clicking the Playwriter extension's icon on a browser tab, which
is what attaches that one tab to the relay. Nothing on either machine can do
it automatically, because it is behaviour of a third-party extension. A bridge
that is otherwise completely healthy is still unusable until a tab is armed.

**bridge** – the Playwriter bridge: a Chrome extension and a relay process on
the user's laptop, reachable from a development virtual machine through a
reverse SSH tunnel, that lets an agent drive a real browser over the Chrome
DevTools Protocol. Its job is driving a browser for an agent, not showing a
page to a person – see **opener** for that.

**durable artifact** – Any text an agent writes that someone reads later without the conversation that produced it. It covers architecture decision records, glossary entries, living specs and their functional requirements, map nodes, handoff files, READMEs and docs, and pull request bodies. Chat replies and commit subject lines are not durable artifacts.

**opener** – a small HTTP service on the user's laptop that accepts a page from
a development virtual machine, stores it, serves it back on the loopback
interface, and hands the address to the user's default browser. It is how a
person is shown a document, as distinct from the **bridge**, which is how an
agent drives a browser.

**relay** – the process on the laptop that the Playwriter extension connects
to, and that a development virtual machine reaches through the reverse tunnel.
It is the laptop-side half of the **bridge**.

**route** – the single named answer to "how does this machine reach a browser",
decided in one place and printed by `spechub-open --why`. Callers ask for the
route rather than each working it out again.

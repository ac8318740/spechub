# A document opener service on the laptop, separate from the Playwriter bridge

A page rendered on a headless Linux development virtual machine reaches the
browser on the machine the user is physically sitting at by being posted to a
small HTTP service running on that machine, which stores the page, serves it
back on the loopback interface, and hands the resulting address to the default
browser. The Playwriter bridge – a Chrome extension plus a relay that lets an
agent drive a real browser over the Chrome DevTools Protocol – stays, but is no
longer the route by which a human is shown a document.

The two do different jobs. The bridge exists so an agent can *drive* a browser;
the opener exists so a person can *see* a page. Collapsing them looked
attractive and does not work, for a reason that is not obvious: the bridge
attaches per tab and only after someone clicks the extension icon, and it does
so inside a dedicated Chrome profile that is not the user's default browser. So
the bridge cannot satisfy "open this in my normal browser" at all, and every
document opened through it costs a manual arming click first.

## Considered options

**Drive the existing bridge.** Rejected. Arming is a per-tab click inside a
separate Chrome profile, and rewriting a live page over the DevTools Protocol
detaches the extension outright, taking the bridge down until it is armed again
by hand.

**Forward a port and serve from the virtual machine.** The user's terminal
would open an address that a forwarded port carries back to a server on the
virtual machine. Rejected as the primary route because the reverse tunnel the
bridge already maintains runs the wrong way, so this needs a second forward
that only exists in some of the ways the user connects; and because the page
dies when the server on the virtual machine stops, which is the common case
when a session ends.

**A clickable hyperlink in the terminal.** Already implemented, and kept as the
fallback. Rejected as the answer because it costs a deliberate click for every
single document, and the requirement was to read one document after another
without ceremony.

**Open the document in the editor instead of a browser.** Rejected: the user is
moving away from an editor-hosted terminal toward a plain one, and asked
specifically for the default browser.

## Consequences

A second always-on component now runs on the laptop and a second port is
carried by the existing reverse tunnel. This is deliberate: the relay and
tunnel are already registered as self-healing scheduled tasks, so the opener
inherits that machinery, its deployment, and its restart-on-change behaviour
rather than inventing any.

Because the opener is a service the virtual machine can reach, it also performs
the two recovery actions the virtual machine previously could not – restarting
the relay and restarting the tunnel – which until now had to be handed to a
human to paste into a shell. Arming the extension remains manual, because it is
behaviour of a third-party extension and nothing on either side can click it.

Rendered documents are stored on the laptop. They outlive the session that
produced them, which is what makes a page still work after the virtual machine
has gone away, and means the store needs pruning.

The service accepts a document and puts it on the user's screen, so it is
guarded by a shared secret established at setup. Loopback binding alone was
rejected: the reverse tunnel makes the port reachable by anything running on
the virtual machine.

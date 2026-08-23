# A document opener service on the laptop, separate from the Playwriter bridge

A page renders on a headless Linux development virtual machine. To reach the
browser on the machine where the user sits, `spechub-open` posts the page to
a small HTTP service on that machine. The service stores the page, serves it
back on the loopback interface, and hands the address to the default
browser. The Playwriter bridge stays. It is a Chrome extension plus a relay
that lets an agent drive a real browser over the Chrome DevTools Protocol.
The bridge no longer shows a document to a human.

The two do different jobs. The bridge exists so an agent can *drive* a
browser. The opener exists so a person can *see* a page.

Collapsing them looked attractive and does not work, for a reason that is
not obvious. The bridge attaches per tab, and only after someone clicks the
extension icon. It does so inside a dedicated Chrome profile, not the user's
default browser. So the bridge cannot satisfy "open this in my normal
browser" at all, and every document opened through it costs a manual arming
click first.

## Considered options

**Drive the existing bridge**. Rejected. Arming the bridge takes a per-tab
click inside a separate Chrome profile. Rewriting a live page over the
DevTools Protocol also detaches the extension outright. The bridge then
stays down until the user arms it again by hand.

**Forward a port and serve from the virtual machine**. The user's terminal
would open an address that a forwarded port carries back to a server on the
virtual machine. Rejected as the primary route. The reverse tunnel the
bridge already maintains runs the wrong way, so this needs a second forward.
That second forward exists in only some of the ways the user connects. The
page also dies when the server on the virtual machine stops, which is the
common case when a session ends.

**A clickable hyperlink in the terminal**. Already implemented, and kept as
the fallback. Rejected as the answer. It costs a deliberate click for every
single document. The requirement was to read one document after another
without ceremony.

**Open the document in the editor instead of a browser**. Rejected. The user
is moving away from an editor-hosted terminal toward a plain one. The user
asked specifically for the default browser.

## Consequences

A second always-on component now runs on the laptop. The existing reverse
tunnel carries a second port. This is deliberate. Setup already registers
the relay and tunnel as self-healing scheduled tasks. The opener inherits
that machinery, its deployment, and its restart-on-change behaviour rather
than inventing any.

Because the opener is a service the virtual machine can reach, it now
restarts the relay and restarts the tunnel. Those are two recovery actions
the virtual machine could not perform before. Until now, a human had to
paste those commands into a shell. Arming the extension remains manual,
because it is behaviour of a third-party extension and nothing on either
side can click it.

The opener stores rendered documents on the laptop. They outlive the session
that produced them. That is what makes a page still work after the virtual
machine goes away. It also means the store needs pruning.

The service accepts a document and puts it on the user's screen, so a shared
secret established at setup guards it. Loopback binding alone is not enough,
because the reverse tunnel makes the port reachable by anything running on
the virtual machine.

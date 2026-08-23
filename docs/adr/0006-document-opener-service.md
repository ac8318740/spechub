# A document opener service on the laptop, separate from the Playwriter bridge

`spechub-open` sends a rendered page to the opener, a small HTTP service on
the user's laptop. The opener stores the page and serves it back on an
address only the laptop can reach (the loopback interface). It then hands
that address to the user's default browser. The Playwriter bridge stays as it
is, and it no longer shows a document to a person.

A page renders on a development virtual machine, which has no browser of its
own. The virtual machine already reaches the laptop through the bridge. The
bridge is a Chrome extension plus a relay, meaning a small process on the
laptop that the extension connects to. It lets an agent drive a real browser
over the Chrome DevTools Protocol (CDP). Reusing it to show a page to a person
looked like the cheaper answer.

The two do not collapse into one. The bridge attaches one tab at a time, and
only after someone clicks the extension icon. That click **arms** the tab. The
bridge also drives a dedicated Chrome profile rather than the user's default
browser. So it cannot satisfy "open this in my normal browser" at all, and
every document through it costs an arming click first.

The bridge exists so an agent can *drive* a browser. The opener exists so a
person can *see* a page.

## Considered options

**Drive the existing bridge**. Rejected. Arming the bridge takes one click
per tab, inside a separate Chrome profile. Rewriting a live page over CDP
also detaches the extension outright. The bridge then stays down until the
user arms it again by hand.

**Forward a port and serve from the virtual machine**. Rejected. The user's
terminal would open an address that a forwarded port carries back to a server
on the virtual machine. The reverse tunnel the bridge already maintains runs
the wrong way, so this needs a second forward. That forward comes from a
`LocalForward` line in the user's own SSH host block, and nothing in setup
writes it. The page also dies when the server on the virtual machine stops,
which is the common case when a session ends.

**Print a clickable hyperlink in the terminal**. Kept as the fallback, not as
the answer. The terminal already prints one today. It costs a deliberate
click for every single document. The requirement was to read one document
after another without ceremony.

**Open the document in the editor instead of a browser**. Rejected. The user
is moving away from an editor-hosted terminal toward a plain one. The user
asked specifically for the default browser.

## Consequences

A second always-on service now runs on the laptop, and every virtual machine
gets one more tunnel task to carry it. This is deliberate. Setup already
registers the relay and its tunnels as self-healing scheduled tasks. The
opener inherits that machinery, its deployment, and its restart-on-change
behaviour rather than inventing any.

The opener gets its own tunnel rather than a second forward on the bridge's
connection. `tunnel.ps1` passes `ExitOnForwardFailure=yes`, so one wedged
port fails the whole `ssh` session. A stuck opener port would take the bridge
down with it.

The virtual machine can now ask the opener to restart the relay and to
restart the tunnels. Those are two recovery actions the virtual machine could
not perform before, and a human had to paste both into a shell. Arming stays
manual, because it is behaviour of a third-party extension and nothing on
either side can click it.

The opener stores rendered documents on the laptop. They outlive the session
that produced them. That is what makes a page still work after the virtual
machine goes away. The opener prunes the store after a week.

The service accepts a document and puts it on the user's screen, so a shared
secret called the opener token guards it. Setup generates that token and
copies it to the virtual machine. Loopback binding alone is not enough,
because the reverse tunnel makes the port reachable by anything running on
the virtual machine.

# Headless clipboard, open and download

`SKILL.md` decides when to read this file: when the user asks how to copy, open or download from this machine, or `o`, `y` or `Y` fails.

## 7. Copy, open and download, on a machine with no display

*Three gh-dash keys break there, and a file has no way off the machine at all. `apply` writes a route for each. The last lines of `status` say where a copy and an open will land.*

The dev machine – the remote machine the user's agents run on, a virtual machine
in this setup – has no display and no clipboard. Two gaps, and three gh-dash
keys fall into them.

The `o` key fails with `exit status 1`, because `xdg-open` has no display. The
`y` and `Y` keys fail with `Failed copying to clipboard`, because gh-dash shells
out to `xclip`, `xsel` or `wl-copy`, and the machine has none of them.

`apply` closes both gaps. Setting a second machine up needs nothing extra:

```bash
bash "$SETUP" apply
bash "$SETUP" status     # read the last lines
```

`y` and `Y` keep gh-dash's own behaviour, backed by an `xclip` stand-in that
copies over OSC 52. OSC 52 is an escape sequence a terminal reads as "put this
text on the clipboard of the machine I am running on".

The `o` key becomes a keybinding running `spechub-open`, because gh-dash runs
`$BROWSER` with its output discarded and the dashboard still drawn. A route that
must hand you a link then has nowhere to draw it.

The last lines of `status` say where a copy and an open will actually land on
**this** machine:

```
clipboard: xclip stand-in, copying to your terminal over OSC 52
browser: none - o hands you a ctrl+clickable link and copies it
last open: 2026-08-21T03:23:07+00:00 link: https://github.com/owner/repo/pull/30
```

Read them before debugging anything else. What each means:

Every line `status` can print is here, in the order the code tries the routes:

| Line | What happened | What to do |
|---|---|---|
| `clipboard: this machine has a display` | It has a real clipboard | Nothing |
| `clipboard: xclip stand-in` | Copy reaches your terminal over OSC 52 | Nothing |
| `clipboard: none` | `apply` has not run, or `remote.clipboard_shim` is false | Run `apply` |
| `browser: $SPECHUB_OPEN_CMD = ...` | The user set an override, and it wins over every route below | Nothing |
| `browser: xdg-open on this machine` | The machine has a desktop of its own | Nothing |
| `browser: the Windows side of this machine` | This is WSL, and Windows opens the page | Nothing |
| `browser: your default browser on your laptop` | The opener is up and holds the token | Nothing |
| `browser: Chrome on your laptop` | The Playwriter bridge is up and proven attached | Nothing |
| `browser: none - o hands you a link` | The normal case over SSH. ctrl+click it | Nothing |
| `browser: none, and no terminal either` | `o` copies and reports failure | Below |
| `browser: unknown` | `spechub-open` did not answer, so it is missing or broken | Run `apply` |

Two of those rows name services this skill does not install. The opener is a
small service on the user's laptop that opens a page in their default browser.
The Playwriter bridge lets this machine drive Chrome on that same laptop, and
the `bridge` skill covers it.

Each runs on its own reverse tunnel, port 19988 for the bridge and port 19989
for the opener. One can be up while the other is down.

The opener has no key in this config, so do not invent one. `spechub-open` takes
that route only when two things hold. A token file sits at
`~/.config/spechub/opener.token`. The service answers on
`http://127.0.0.1:19989` with that token.

Setting `SPECHUB_OPEN_OPENER=off` in the environment skips the route.

`browser: none` is not a fault. Nothing on that machine can open a page, so `o`
hands the terminal a link instead. That link is the one route that works over
any number of SSH hops.

To make it a real one-key open, give it a command that can:

```bash
export SPECHUB_OPEN_CMD="ssh laptop open"   # any command taking a URL
```

Do not suggest installing a browser or an X server on the dev machine to fix
this. The browser belongs on the machine the user is sitting at.

Under `herdr --remote`, panes run on the remote host, so `spechub-open` looks
for a browser there and normally finds none. That is normal, not a fault. It
falls to the link route, which the client draws.

Do not add per-host browser configuration to "fix" it.

One thing to check rather than assume. We measured on herdr 0.8.2 that a pane's
OSC 52 write crosses the remote link. A copy on the dev machine then reaches the
clipboard the user attached from.

The herdr documentation never promises this, and terminals differ in whether
they act on OSC 52 at all.

So have the user run `spechub-clip test-string` after the first attach, then
paste on the client. Believe that test over the measurement.

If it does not cross, say so plainly. The link is still on screen, and herdr's
own drag-select copies it.

### 7.1. When `o` claims it opened something nobody saw

*A successful open proves nothing. Ask what sits on the other end of the endpoint.*

`agent-browser` launches a headless Chrome on the local machine when it cannot
attach to the Chrome DevTools Protocol (CDP) endpoint the caller named. That
Chrome navigates, reports success, and shows nobody anything.

A bridge relay answering on its HTTP port does not rule this out. Ours answered
`/json/version` while refusing every CDP connection with
`Multiple extensions connected. Specify extensionId.`

Diagnose it by asking what is really on the other end, never by trusting a
successful open. Port 9555 below is the CDP port SpecHub defaults to for a
headless or local browser, so a stray Chrome on this machine answers there:

```bash
agent-browser get cdp-url          # the endpoint actually attached to
curl -s 127.0.0.1:9555/json/list   # the tabs a headless Chrome here holds
```

`spechub-open` runs that check itself before taking the bridge route. If you
find a stray headless Chrome holding pages, say so. It is a leftover, and
killing it is the user's call, not yours.

Detail, and why OSC 52 rather than a clipboard daemon:
[docs/terminal-workspace.md](../../docs/terminal-workspace.md).

### 7.2. Getting a file off the machine

*A third gap has nothing to do with gh-dash. OSC 52 carries text, and a file needs Taildrop.*

The clipboard route above carries text. A screenshot, a build artifact or a log
has no route at all. The user's own SSH client pulls one down only when they
type the path by hand.

Set `yazi.download_target` and `apply` binds one key in yazi, `D` by default. It
runs Taildrop, Tailscale's file send, on the hovered file:

```toml
run = 'shell --block -- tailscale file cp "%h" <target>:'
```

Recommend Taildrop over `scp` back to the user's machine. That route needs
three things on their machine, and Taildrop needs none of them:

- an SSH server running there
- a reverse tunnel raised on every connection
- this machine's key in their `authorized_keys`

Taildrop needs no inbound port on their machine either.

Three things break it, and `apply` names whichever one holds:

| What the user sees | What it means | What to do |
|---|---|---|
| `Access denied: file access denied` | The account does not own the local Tailscale daemon | Run `sudo tailscale set --operator=$USER` once |
| `502 Bad Gateway`, or the target reported offline | The two machines sit on different tailnets or under different accounts | Compare `tailscale status` on both ends |
| `open %*: no such file or directory` | A binding used `%*`, which yazi never expands in a keymap | Use `%h`, the hovered file |

The last row is why the key takes one file at a time. `%*` belongs to yazi's
`[opener]` table. A keybinding passes the two characters through untouched,
measured on yazi 26.8.15.

Do not offer to install an SSH server on the user's own machine to work around
a Taildrop failure. Fix the tailnet instead, or leave `yazi.download_target`
empty.

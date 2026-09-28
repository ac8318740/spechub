# Emulator keys

`SKILL.md` decides when to read this file: after `apply`, and whenever the user reports a key doing nothing.

## 6. Free the keys the user's terminal emulator swallows

*`apply` binds keys on this machine. The emulator the user types in may claim the same ones first.*

`apply` binds the keymap on **this** machine. The terminal emulator on the
machine the user types on intercepts the chords first.

Windows Terminal binds `alt+shift+d` to "duplicate pane" by default and never
forwards it, so a binding on that chord does nothing here. The diff keys avoid
it by sitting on `alt+f` and `alt+shift+f`. Other emulators claim other chords.

When the user reports a key doing nothing, have them run `cat -v` in any pane
and press it. A chord that arrives prints an escape sequence. One that prints
nothing never left their machine, so the fix belongs in the emulator.

After `apply`, work out which case you are in.

**Running on the user's own desktop**, meaning macOS, or Linux with a desktop
session. The terminal emulator is right here. Read
[assets/terminal-workspace/client-keybindings.md](../../assets/terminal-workspace/client-keybindings.md)
and do the work yourself.

Find the emulator's config, and back it up. Unbind only the chords the emulator
actually holds. Show the diff, and verify.

**Running on a remote or headless host**, meaning no `DISPLAY`, or an
`SSH_CONNECTION` in the environment. You cannot reach the emulator from here.
Ask first:

> Do you SSH into this machine from a Windows, macOS, or Linux desktop? If so
> I can give you a prompt to hand to an agent there, which frees the keys their
> terminal is swallowing.

Only if they say yes, print the contents of `client-keybindings.md` verbatim for
them to paste. Do not summarise it. Do not rewrite it for their emulator.

It already covers the common ones. The agent on that machine can see which
emulator the user actually runs.

If they say no, or the terminal is on this machine, say nothing further about
it. A user on a plain Linux console has nothing to fix.

**Never** try to edit a client-side terminal config from a remote host. Never
ask the user to paste their local config here so you can rewrite it.

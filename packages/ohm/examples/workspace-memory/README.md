# Workspace memory

Install this optional package with `ohm plugins install PATH`, then run `/refresh`.
`workspace_memory` remembers, recalls, and forgets explicit notes. `/memory`
opens the same notes as a portable presentation; `/actions` lets you add or
remove a note in the TUI. SDK and RPC clients invoke those same actions.

The plugin retains at most 32 notes of 512 characters in its private
workspace configuration. Writes use the host's atomic compare-and-swap store;
a competing write produces a conflict rather than silently losing a note.
Notes survive refresh and restart. Removing the package preserves its data.
The six most recently saved notes become bounded reference context before each
agent run. No model generates or silently saves memories, and no file tree is
indexed. Save only information you intend to send to the active model provider.

Run `npm test --prefix PATH`, then `ohm plugins verify PATH`.
The package tests cover persistence across a fresh factory, cancellation,
conflicting writes, and portable actions. Normal project trust applies: this
is trusted JavaScript, not a sandbox.

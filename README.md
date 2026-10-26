# dsh-memory

Keeps a verbatim archive of the conversation in the workspace, and tells the
model exactly which folder is its own.

DSH condenses long conversations on its own. When it does, the original wording
is gone from the model's view and no later turn can recover it — a summary is a
one-way transform. This plugin keeps a copy before that happens, as plain
markdown the model can read with ordinary file tools.

## What it does

1. **Copy.** After each completed exchange, the question and the answer are
   written to `staging/`, one file per exchange.
2. **Pack.** Once staging holds enough exchanges they move into `packs/pack-NNN/`,
   one file per exchange, and `_note.md` records what that pack holds. The staged
   copies are deleted, so the archive never holds the same exchange twice.
3. **Point.** On every step the model receives one runtime-context line naming
   *its own* `packs/` folder. `staging/` is deliberately not named: it holds the
   exchanges still in the model's context, so pointing at it would send the model
   to read what it already has.

The model reads a pack only when it decides to. Nothing is injected into the
conversation.

## What it writes

```
<workspace>/.dsh-memory/<session>/
  staging/NNNN.md                exchanges copied, not yet packed
  packs/pack-NNN/NN.md           one exchange per file (01.md, 02.md, …)
  packs/pack-NNN/_note.md        what the pack holds, and a content digest
```

The `<session>` level exists because question seqs restart at zero in every
session: two sessions in one workspace would otherwise write the same `0008.md`
over each other. It is the session id with the `session-` prefix and the dashes
removed, cut to eight characters.

Nothing else is written. It never appends an event to a session and never
rewrites a message.

## Settings

Settings live in `<DSH home>/memory-archive.json`, not in the profile patch. The
plugin re-reads that file every time it packs, so a change takes effect on the
next exchange — no restart.

```json
{
  "mode": "manual",
  "windowRounds": 15,
  "warnAtChars": 200000
}
```

| Key | Meaning |
|---|---|
| `mode` | `manual` packs every `windowRounds` exchanges; `sync` packs when DSH compacts |
| `windowRounds` | exchanges per pack in `manual` mode |
| `warnAtChars` | warn once staging passes this many characters |
| `rootDir` | where the archive lives, relative to the session's working directory |

### From the panel

`sidebar.footer.action` carries a **记忆归档 ›** row. It opens a panel that reads
the current values and writes changes back. The panel has no filesystem access of
its own — it sends `/memory` commands to the host half, which does the reading and
writing.

### From the command line

```
/memory status
/memory rounds 20
/memory mode sync
/memory warn 300000
/memory reset
```

## Design notes

These are the decisions that took the longest, recorded so they are not undone by
accident.

**The model is told its path through the prompt, not through a file.** A file in
the workspace is shared by every session that uses that workspace and is read once
at session start — so two sessions would both see one session's path, and the one
that opened second would be pointed at the wrong archive. `ctx.systemPrompt.context`
takes a function and re-resolves it at each assembly, so the line is always the
asking session's own.

**`agent/pre-step` also appends the line.** The loop renders the runtime-context
snapshot from the assembly taken *before* the pre-step waterfall, so a plugin
loaded into a session that is already running is not in that snapshot yet.
Appending it in the waterfall runs on every step; the loop's own snapshot
comparison keeps it to one occurrence per session.

**A pack is identified by a content digest.** Comparing seq ranges answers "was
this question archived?" but not "is the archived text the same as what we have
now?" — so a re-scan would either rewrite an identical pack or keep a stale answer
while reporting success. The digest makes the decision the same every time it is
asked.

**A question with no answer yet is not an exchange.** While archiving runs, the
question being answered right now looks exactly like a question whose answer was
lost: the user message exists, the assistant message does not. Writing that out
would produce a file claiming the answer was never captured — a statement about
the past made while the answer is still being produced.

**No verification that the user did not edit a pack.** Editing files in the
workspace is the user's business, and treating it as an attack would mean carrying
error handling for a case the user brought on themselves. The digest in each note
is enough for anyone who wants to check.

## Requirements

- DSH `0.2.1-rc.2`. Both halves are loaded by the bundle; `client.js` must be
  present, because a declared `dsh.client` with a missing bundle stops DSH from
  starting.
- No third-party dependencies. It imports nothing from `@deepseek-ai/*`: an
  out-of-tree plugin cannot resolve those, since they live inside `app.asar`.

## Installing

Place the package under `<profile>/node_modules/`, add it to the profile's
`dsh.profile.bundles`, and restart DSH. There is no separate build step — the
files in this repository are the ones DSH loads.

## Uninstalling

Remove the bundle row and delete the package directory. Then delete
`.dsh-memory/` in the workspace if you do not want to keep the archive; it is plain
markdown, and nothing else depends on it.

## Compatibility

Only DSH `0.2.1-rc.2` is tested. The plugin uses `slots`, `remote.commands`,
`session/event`, `agent/pre-step`, `systemPrompt.context` and `commands.register`;
a release that changes any of those can break it. It declares no `order`
collisions with other footer plugins — `session-vault` sits at 60 and this one at
64, so both rows are visible.

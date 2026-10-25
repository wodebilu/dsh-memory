# dsh-memory

Keeps a verbatim archive of the conversation in the workspace, and tells the
model where it is.

DSH condenses long conversations on its own. When it does, the original wording
is gone from the model's view and no later turn can recover it — a summary is a
one-way transform. This plugin keeps a copy before that happens, as plain
markdown the model can read with ordinary file tools.

## What it does

Three steps, all of them file work inside the workspace:

1. **Copy.** After each completed exchange, the question and the answer are
   written to `.dsh-memory/staging/`, one file per exchange.
2. **Pack.** When staging holds enough exchanges, they are moved into
   `.dsh-memory/packs/pack-NNN/`, one file per exchange, ordered `01.md`,
   `02.md`, … A `_note.md` records what the pack holds.
3. **Point.** `AGENTS.local.md` in the workspace says where the packs are and
   what they cover. DSH loads that file as workspace instructions, so the model
   sees the pointer without it competing for the conversation window.

The model reads a pack only when it decides to. Nothing is injected into the
conversation.

## What it writes

```
<workspace>/
  AGENTS.local.md                    the pointer (only the marked block is ours)
  .dsh-memory/
    staging/NNNN.md                  exchanges copied, not yet packed
    packs/pack-NNN/NN.md             one exchange per file
    packs/pack-NNN/_note.md          index, questions covered, content digest
    _archive-log.md                  one line per archive change
```

Nothing else. It never appends an event to a session and never rewrites a
message.

## Configuration

Every key is optional.

```yaml
- id: memory-archive
  name: '@local/dsh-memory'
  config:
    # 'manual' packs on a fixed number of exchanges;
    # 'sync' packs when DSH compacts, so the archive tracks what the model lost.
    mode: manual

    # Exchanges per pack in manual mode.
    windowRounds: 15

    # Where the archive lives, relative to the session's working directory.
    rootDir: .dsh-memory

    # Warn the model once staging passes this many characters. Mainly useful in
    # `sync` mode, where staging can grow for a long time if compaction never
    # fires.
    warnAtChars: 200000
```

## Design notes

These are the decisions that took the longest, recorded so they are not undone
by accident.

**It does not compete with DSH compaction.** DSH already knows when to
condense and what to condense. Fighting that means reimplementing the surface
model, tool-pairing balance and turn brackets — a lot of machinery for a job
that is already done. This plugin only listens and copies.

**Coverage is a set of questions, not a number range.** A pack holds specific
exchanges. The events between two of them belong to those exchanges and are not
separately covered. Reporting `seq 8–172` would make two adjacent packs look
like they have a hole between them, and a warning that fires on healthy data
teaches the reader to ignore the one that matters.

**A pack is identified by a content digest.** Comparing seq ranges answers "was
this question archived?". It cannot answer "is the archived text the same as
what we have now?" — so a re-scan would either rewrite an identical pack or
keep a stale answer while reporting success. The digest makes the decision the
same every time it is asked, which is what makes the archive predictable enough
to reason about.

**Missing is not the same as silent.** When an answer was never captured, the
file says `（答案未捕获：写入时进程中断，不是对方没有回答）`. "This exchange
has no answer" would be a false statement about what happened, not a description
of what the plugin failed to record.

**The index never claims more than the archive holds.** If a pack has no
recorded digest, the pointer says so. If there are gaps, the pointer lists them.
An index that reads as tidier than the archive really is would be worse than no
index at all, because a reader trusts it.

**No verification that the user did not edit a pack.** Editing files in the
workspace is the user's business, and treating it as an attack would mean
carrying error handling for a case the user brought on themselves. The digest in
each note is enough for anyone who wants to check.

## Two things to know before you edit anything

**Packs are derived, not primary.** The session log is the source; a pack is a
readable copy of part of it. If you hand-edit a file under `packs/`, the next
run that rebuilds that pack overwrites your edit. That is the intended
behaviour — the archive is supposed to reflect the conversation, not drift away
from it — but it means `packs/` is the wrong place to keep notes you want to
survive. Put those in `_note.md` below the marker line: that file is preserved.

**One damaged pack can rebuild several.** Rebuilds work by re-packing from
staging, and staging is ordered, so restoring an early pack can cascade into the
packs after it. It is safe, and it is linear in the number of packs, but on a very
large archive a single inconsistency can rewrite everything. The change log
records this as `全量重建 N 个包`, and the count is there so the cost is visible
rather than surprising.

## Requirements

- DSH `0.2.1-rc.2`. The plugin declares `engines.dsh` so an incompatible build
  is refused at load instead of failing in some confusing way later.
- No third-party dependencies. It imports nothing from `@deepseek-ai/*` — an
  out-of-tree plugin cannot resolve those, since they live inside `app.asar`.

## Installing

Place the package where the profile can resolve it, add it to the profile's
`dsh.profile.bundles`, and add the row from `cordis.patch.yml` to
`cordis.patch.yml`. Then restart DSH. If a plugin module has changed, remove any
stale copy before restarting.

## Uninstalling

Remove the bundle row and the package. Then:

- `AGENTS.local.md` — delete the block between `<!-- dsh-memory:begin -->` and
  `<!-- dsh-memory:end -->`, or delete the file if that block is all it holds.
- `.dsh-memory/` — the archive itself. It is plain markdown; keep it, move it,
  or delete it as you like. Nothing else depends on it.

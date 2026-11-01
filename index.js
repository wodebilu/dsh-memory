/**
 * @local/dsh-memory — keeps a verbatim archive of the conversation and points the
 * model at it.
 *
 * DSH condenses long conversations on its own; when it does, the original
 * wording is gone from the model's view. This plugin keeps a copy first: every
 * completed exchange is written to a staging folder, and staging is packed into
 * numbered packs the model can read with ordinary file tools.
 *
 * It never touches session content. Everything it does is read-the-session,
 * write-our-own-files:
 *
 *   <workspace>/.dsh-memory/<session>/staging/NNNN.md        copied, not yet packed
 *   <workspace>/.dsh-memory/<session>/packs/pack-NNN/NN.md   one exchange per file
 *   <workspace>/.dsh-memory/<session>/packs/pack-NNN/_note.md  the pack's index
 *
 * The `<session>` level exists because question seqs restart at zero in every
 * session: two sessions in one workspace would otherwise write the same
 * `0008.md` over each other. The workspace level exists because the archive
 * belongs to the folder, so moving or changing the workspace moves the archive
 * with it instead of leaving it behind.
 *
 * No language model is called and no prompt file is written.
 *
 * Packing and visibility are separate rhythms, and neither one raises a token
 * cost of its own:
 *
 *   packing      every `windowRounds` exchanges, whenever they arrive
 *   visibility   only for the two steps after DSH compacts — that is the moment
 *                the exchanges in a pack stop being in the conversation, and the
 *                window exists so the model can write that pack a `_summary.md`
 *
 * The archive is invisible at every other time. Naming it while its exchanges are
 * still in the window would only send the model to read what it already has.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

import {
  compactPacks,
  compactionsDir,
  coverage,
  digestBodies,
  listCompactions,
  listPacks,
  listStaged,
  packStaged,
  seqOfStaged,
  stagingChars,
  stagingDir,
} from './pack.mjs'

export const name = 'memory-archive'

/**
 * Services this plugin reads.
 *
 * `commands` backs `/memory` and the panel. `systemPrompt` is what makes the
 * per-step archive path possible; it is required here because the archive is
 * useless to the model if it is never told where the files are.
 */
export const inject = ['commands', 'systemPrompt']

const DEFAULTS = {
  /** Exchanges per pack. Packing always follows this count, never compaction. */
  windowRounds: 15,
  /** Where archives live, relative to the session's working directory. */
  rootDir: '.dsh-memory',
  /** Warn once staging passes this many characters. */
  warnAtChars: 200_000,
}

const LOG_PATH = (() => {
  try {
    const bridge = '\\\\vmware-host\\Shared Folders\\dsh-portable\\_bridge\\logs'
    if (existsSync(bridge)) return join(bridge, 'memory.log')
  } catch {
    /* not reachable */
  }
  return join(homedir(), 'memory-archive.log')
})()

function log(...parts) {
  const line = `[memory ${new Date().toISOString()}] ${parts.join(' ')}`
  try {
    appendFileSync(LOG_PATH, line + '\n', 'utf8')
  } catch {
    /* diagnostics must never break the host */
  }
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trimEnd())
    }
  }
  return parts.join('\n\n').trim()
}

/** Collapse fenced code to a marker: memory is the exchange, not the payload. */
function stripCode(text) {
  if (!text) return ''
  const lines = text.split('\n')
  const out = []
  let i = 0
  let stripped = 0
  while (i < lines.length) {
    if (lines[i].trimStart().startsWith('```')) {
      i += 1
      let count = 0
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        count += 1
        i += 1
      }
      if (i < lines.length) i += 1
      stripped += 1
      out.push(`（此处有代码，${count} 行，已省略）`)
      continue
    }
    out.push(lines[i])
    i += 1
  }
  return stripped === 0 ? text : out.join('\n')
}

// ---------------------------------------------------------------------------
// exchanges
// ---------------------------------------------------------------------------

/**
 * Turn session rows into Q&A exchanges.
 *
 * A question is a `user/message` whose source kind is exactly `user`; the system
 * injections also use the user role but never that kind. The answer is the last
 * assistant message before the next question, because earlier ones carry tool
 * calls while the last one carries the prose the user saw.
 */
export function exchangesFromRows(rows) {
  const exchanges = []
  let current = null
  for (const row of rows) {
    const isQuestion = row?.type === 'user/message' && row?.data?.source?.kind === 'user'
    if (isQuestion) {
      // A held-over question is flushed only when it got an answer; see below.
      if (current !== null && current.answer !== '') exchanges.push(current)
      current = {
        seq: row.seq,
        question: stripCode(textOf(row.data.content)),
        answer: '',
      }
      continue
    }
    if (current !== null && row?.type === 'assistant/message') {
      const text = stripCode(textOf(row.data?.message?.content))
      if (text) current.answer = text
    }
  }
  // The last question is deliberately NOT pushed when it has no answer.
  //
  // While this runs, the question being answered right now looks exactly like a
  // question whose answer was lost: the user message exists, the assistant
  // message does not yet. Writing that out produces a file claiming the answer
  // was never captured — a statement about the past made while the answer is
  // still being produced. Only a question that already has an answer is a
  // finished exchange.
  if (current !== null && current.answer !== '') exchanges.push(current)
  return exchanges
}

export function renderExchange(exchange) {
  return [
    '# 问',
    '',
    exchange.question || '（空）',
    '',
    '# 答',
    '',
    exchange.answer || '（答案未捕获：写入时进程中断，不是对方没有回答）',
    '',
  ].join('\n')
}

/**
 * Stage exchanges that are not already staged.
 *
 * A staged file is named by its question seq, so re-scanning the session costs a
 * directory listing and writes nothing. There is no separate watermark: the
 * files themselves are the record of what has been captured, which keeps the
 * record and the content on the same ruler.
 *
 * @returns {{ written: number }}
 */
export function stageExchanges(root, exchanges) {
  const dir = stagingDir(root)
  mkdirSync(dir, { recursive: true })
  const existing = new Set(listStaged(dir))

  // Skip anything already archived.
  //
  // Packing empties staging, so "is there a staged file with this name?" alone
  // cannot tell whether an exchange was already captured — that is how four
  // identical packs came out. A pack records the seq range it covers, so the
  // answer is in the archive itself and needs no separate bookkeeping.
  // Ask the archive rather than a span: coverage reports the exact set of
  // question seqs it holds, so membership is a set lookup and a question that
  // sits between two packs is correctly seen as archived.
  const coveredSet = new Set(coverage(root).covered)
  const archived = (seq) => coveredSet.has(seq)

  let written = 0
  let skippedArchived = 0
  for (const exchange of exchanges) {
    if (typeof exchange.seq !== 'number') continue
    if (!exchange.question && !exchange.answer) continue
    if (archived(exchange.seq)) {
      skippedArchived += 1
      continue
    }
    const name = `${String(exchange.seq).padStart(4, '0')}.md`
    if (existing.has(name)) continue
    writeFileSync(join(dir, name), renderExchange(exchange), 'utf8')
    written += 1
  }
  return { written, skippedArchived }
}

/**
 * The digest a pack built from the next `count` staged files would have.
 *
 * Computed without writing anything, so "would this change the archive?" can be
 * answered before any file is created.
 */
function previewDigest(dir, count) {
  const names = listStaged(dir).slice(0, Math.max(0, count))
  const bodies = []
  for (const name of names) {
    try {
      const body = readFileSync(join(dir, name), 'utf8')
      bodies.push({ outName: `${String(bodies.length + 1).padStart(2, '0')}.md`, body })
    } catch {
      /* skip unreadable */
    }
  }
  return { digest: digestBodies(bodies), count: bodies.length }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

function workspaceOf(session) {
  return session?.header?.cwd ?? session?.header?.workingDirectory ?? process.cwd()
}

/**
 * The session's own archive directory.
 *
 * Three levels, each earning its place:
 *
 *   <workspace>            the archive belongs to a working directory, so a
 *                          session that switches folders keeps finding it
 *                          where its own files live
 *   .dsh-memory            one root, easy to find, easy to delete
 *   <session id, 8 chars>  question seqs restart per session, so two sessions
 *                          in one workspace would otherwise write the same
 *                          `0008.md` over each other
 *
 * Eight characters of a UUID is short enough to read in a path and long enough
 * that a collision would have to be deliberate.
 */
/**
 * Short, filesystem-safe handle for a Session id.
 *
 * Session ids arrive as `session-<uuid>`, so the first eight characters of the
 * raw id are the literal string `session-` — every Session would map to the same
 * directory. The prefix is dropped and the remainder reduced to eight
 * alphanumerics first.
 */
function shortId(sessionId) {
  return String(sessionId)
    .replace(/^session-/, '')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
}

/**
 * The archive path as it should appear in text the model reads.
 *
 * Relative to the workspace, because the model finds the workspace itself, and a
 * relative path stays correct when the workspace is moved.
 */
export function shortRootLabel(session, rootDir = '.dsh-memory') {
  return `${rootDir}/${shortId(session?.header?.id ?? 'unnamed')}`
}

export function archiveRoot(session, rootDir = '.dsh-memory') {
  const workspace = workspaceOf(session)
  return join(workspace, rootDir, shortId(session?.header?.id ?? 'unnamed'))
}

/**
 * Where this plugin keeps its own settings.
 *
 * A file of our own rather than the profile's `cordis.patch.yml`, because the
 * patch addresses entries by Loader id and a bundle loaded through
 * `dsh.profile.bundles` does not reliably answer to any id we can predict —
 * writing there produced a config the plugin never saw. A JSON file next to the
 * profile is readable, writable, inspectable, and needs no match on ids.
 */
const SETTINGS_PATH = (() => {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'memory-archive.json')
})()

/** Read the saved settings, or an empty object when there is nothing usable. */
function readSettings() {
  try {
    if (!existsSync(SETTINGS_PATH)) return {}
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    if (raw === null || typeof raw !== 'object') return {}
    const out = {}
    if (Number.isFinite(raw.windowRounds) && raw.windowRounds > 0) {
      out.windowRounds = Math.round(raw.windowRounds)
    }
    if (Number.isFinite(raw.warnAtChars) && raw.warnAtChars > 0) {
      out.warnAtChars = Math.round(raw.warnAtChars)
    }
    if (typeof raw.rootDir === 'string' && raw.rootDir.trim() !== '') out.rootDir = raw.rootDir
    return out
  } catch {
    return {}
  }
}

/** Persist the settings, merging into whatever is already on disk. */
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  mkdirSync(join(SETTINGS_PATH, '..'), { recursive: true })
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * The live settings.
 *
 * Re-read on every use rather than captured at load: a change made through the
 * panel then takes effect on the next exchange, instead of requiring a restart
 * for something that is only a number.
 */
function currentOptions(base) {
  return { ...base, ...readSettings() }
}

export function apply(ctx, config = {}) {
  const base = { ...DEFAULTS, ...config }
  log('applying: windowRounds=%d rootDir=%s', base.windowRounds, base.rootDir)
  log('settings file: %s', SETTINGS_PATH)
  // One line that proves apply() ran at all, and whether the two services it
  // needs are actually on this context. Without it a bundle that never activates
  // looks exactly like a bundle that activated and did nothing.
  log(
    'services: systemPrompt=%s commands=%s',
    typeof ctx.systemPrompt,
    typeof ctx.commands,
  )

  const warned = new Set()

  const archive = (session, reason) => {
    try {
      const options = currentOptions(base)
      const root = archiveRoot(session, options.rootDir)

      // Read the exchanges out of the live session object rather than the log
      // file: no path to locate, no zstd to decode, and it works while the log
      // is being written.
      const rows = []
      const end = session.seq ?? 0
      for (let seq = 0; seq < end; seq += 1) {
        const event = session.eventAt?.(seq)
        if (event !== undefined) rows.push(event)
      }
      const exchanges = exchangesFromRows(rows)

      const staged = stageExchanges(root, exchanges)

      // Decide whether to pack, and whether the result would differ.
      //
      // The decision must not depend on incidental state such as "is staging
      // momentarily non-empty": that makes the same input produce different
      // outcomes on different runs, which destroys the ability to reason about
      // the archive at all. So the comparison is always content against
      // content — the digest of what would be written versus the digest the
      // pack recorded for itself.
      let packed = null
      const stagedCount = listStaged(stagingDir(root)).length

      // Packing always follows the exchange count, whatever else is happening.
      // A compaction no longer changes *when* a pack is made — it only decides
      // when the archive becomes visible to the model (see `compactionNotice`).
      const shouldPack = stagedCount >= options.windowRounds

      if (shouldPack) {
        const take = options.windowRounds
        const preview = previewDigest(stagingDir(root), take)
        const existing = listPacks(root).find((p) => p.digest === preview.digest)

        if (existing !== undefined) {
          // Identical content is already archived. Drop the staged copies
          // without rewriting: nothing changes, so nothing is written.
          for (const name of listStaged(stagingDir(root)).slice(0, take)) {
            try {
              unlinkSync(join(stagingDir(root), name))
            } catch {
              /* retry next time */
            }
          }
          log('skip: identical to %s (%s)', existing.name, preview.digest)
        } else {
          packed = packStaged(root, take)
        }
      }

      if (packed !== null && packed.incomplete !== true) {
        log(
          'packed %s: %d exchanges, seq %d..%d, digest %s [staged %d new]',
          packed.packName,
          packed.count,
          packed.minSeq,
          packed.maxSeq,
          packed.digest,
          staged.written,
        )
        // The turn after a pack is made is the one turn the model is asked for a
        // summary: the pack is complete, its exchanges are still recent enough to
        // be worth describing, and nothing else is owed.
        oweNote(
          String(session?.id ?? session?.header?.id ?? ''),
          `刚刚打好了一个小包 ${JSON.stringify(join(root, 'packs', packed.packName))}（${packed.count} 轮对话）。` +
            `请在那个文件夹里写一个 \`_summary.md\`，说明这一小包讲了什么。`,
        )
      } else if (packed !== null) {
        log(
          'pack %s INCOMPLETE: wrote %d of %d files; staging kept for retry',
          packed.packName,
          packed.written,
          packed.count,
        )
      }

      const chars = stagingChars(stagingDir(root))
      let warning = null
      if (chars >= options.warnAtChars) {
        const key = `chars:${options.warnAtChars}`
        if (!warned.has(key)) {
          warned.add(key)
          warning = `暂存区已累积约 ${Math.round(chars / 10000)} 万字尚未打包，可能压缩没有正常发生。`
          log('WARNING: %s', warning)
        }
      }

      // The archive is complete for this pass; nothing else is written here.
      //
      // The model is told where the archive is through a prompt section that
      // re-resolves every step (see `promptSection` below), not through a file
      // in the workspace. A file would be shared by every session in the same
      // workspace and read only once, so two sessions would disagree about which
      // path the model should use.
      log(
        'archived: %d packs, %d staged, warning=%s',
        listPacks(root).length,
        listStaged(stagingDir(root)).length,
        warning === null ? 'none' : 'yes',
      )
    } catch (error) {
      log('archive failed: %s', String(error?.stack ?? error))
    }
  }

  // Archive on `assistant/message`.
  //
  // A turn can end without a reply (aborted, failed request); archiving there
  // would capture a question with no answer and ship that half-record as an
  // exchange. The assistant message is the last thing a completed exchange
  // produces, so it is the earliest point where the pair is whole.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'assistant/message') {
        archive(session, 'assistant-message')
        return
      }
      if (event?.type === 'compaction/summary') {
        log('compaction happened at seq %d', event.seq)
        archive(session, 'compaction')
        // Compression moves every pack into this round's folder, and that move is
        // what the model is then asked to describe.
        try {
          const root = archiveRoot(session)
          const moved = compactPacks(root)
          if (moved !== null) {
            log('compaction folder %s: moved %d packs', moved.name, moved.moved)
            oweNote(
              String(session?.id ?? session?.header?.id ?? ''),
              `刚发生过一次压缩，这次压缩的原文已经收进 ${JSON.stringify(join(moved.dir))}（${moved.moved} 个小包）。` +
                `请在那个文件夹里写一个 \`_summary.md\`，说明这一次压缩覆盖了哪一段对话。`,
            )
          }
        } catch (error) {
          log('compaction move failed: %s', String(error?.message ?? error))
        }
      }
    } catch (error) {
      log('event handler failed: %s', String(error?.stack ?? error))
    }
  })

  log('listening on session/event (assistant/message, compaction/summary)')

  // `/memory` — read and change the packing rhythm without editing YAML by hand.
  // The panel sends exactly these commands, so the command line and the GUI can
  // never disagree about what a setting means.
  if (ctx.commands !== undefined) {
    try {
      ctx.effect(() => {
        const dispose = ctx.commands.register({
          name: 'memory',
          description: '记忆归档：查看状态、调整打包节奏（改完下一次归档就生效）',
          input: {
            hint: 'status | rounds <n> | warn <n> | reset',
          },
          handler: (invocation) => {
            // Logged because the command line and the panel reach this through
            // different paths, and a difference between them is invisible from
            // the outside: both look like "the command ran".
            log('command invoked: rawInput=%s', JSON.stringify(invocation?.rawInput ?? null))
            try {
              const result = handleMemoryCommand(base, invocation?.rawInput ?? '')
              log('command result: kind=%s', result?.kind)
              return result
            } catch (error) {
              log('command threw: %s', String(error?.stack ?? error))
              return { kind: 'error', text: String(error?.message ?? error) }
            }
          },
        })
        return () => dispose()
      }, 'memory: command')
      log('command /memory registered')
    } catch (error) {
      log('command registration failed: %s', String(error?.message ?? error))
    }
  } else {
    log('commands service absent; /memory not registered')
  }

  // The model is told where its archive is on every step.
  //
  // `ctx.systemPrompt.context` takes a function, so the line is re-resolved at
  // each assembly from the live Session — a workspace shared by two Sessions
  // still gives each one its own path, which writing a file in the workspace
  // could not do (that file is read once, at Session start, and shared).
  //
  // The `agent/pre-step` hook covers the assembly that was already frozen before
  // this plugin existed: the loop renders the runtime-context snapshot from the
  // assembly taken *before* the pre-step waterfall, so a line registered into a
  // running Session is not in it yet. Appending it there is idempotent — the
  // loop's snapshot comparison keeps it to one occurrence per Session.
  //
  // These three lines are logged once at load, not per step: if the registration
  // silently fails the model simply never learns where its archive is, which is
  // indistinguishable from "it was told and ignored it". A single line at boot is
  // the cheapest way to tell those two apart, so it stays.
  try {
    ctx.systemPrompt.context({
      name: 'memory-archive:home',
      order: 240,
      interpolate: false,
      // The section must always resolve to a string. A section that answers
      // `undefined` is a shape the assembly has never had to handle — the archive
      // is invisible for most steps now — so it answers `''` instead, which is the
      // one thing every caller can render.
      text: (context) => {
        try {
          return takeNote(String(context.agent?.session?.id ?? context.agent?.session?.header?.id ?? '')) + archiveLine(context.agent)
        } catch (error) {
          log('prompt section failed (turn continues): %s', String(error?.message ?? error))
          return ''
        }
      },
    })
    log('systemPrompt.context registered (archive path follows the Session)')
  } catch (error) {
    log('systemPrompt.context FAILED: %s', String(error?.message ?? error))
  }

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // Everything below is additive courtesy, never a precondition: a throw here
    // fails the whole turn, and a turn must not fail because a memory hint could
    // not be built.
    try {
      const text = archiveLine(agent)
      if (text === undefined) return decision
      if (!Array.isArray(decision.messages)) return decision
      const rendered = decision.messages.map(renderedContext).filter((value) => value !== undefined)
      if (rendered.includes(text)) return decision
      return { ...decision, messages: [...decision.messages, ownMessage(text)] }
    } catch (error) {
      log('pre-step hint failed (turn continues): %s', String(error?.message ?? error))
      return decision
    }
  })
  log('agent/pre-step hook registered (covers a Session whose assembly predates this)')
}

/**
 * The one line the model reads every turn, plus the two one-turn requests.
 *
 * Always: where the compressed archive is, so the model knows a searchable copy
 * of older exchanges exists and can go look when it needs one.
 *
 * Only on the turn it is owed: a request to describe the pack just made, or the
 * compression just performed. Those are owed exactly once — repeating them would
 * be asking the model to rewrite a summary it has already written.
 */
function archiveLine(agent) {
  const session = agent?.session
  const cwd = session?.header?.cwd
  if (cwd === undefined || !isAbsolute(cwd)) return ''

  try {
    const root = archiveRoot(session)
    const compressed = compactionsDir(root)
    mkdirSync(compressed, { recursive: true })

    const lines = [
      `更早的对话在压缩归档里：${JSON.stringify(compressed)}（每次压缩一个文件夹，里面是当时的原文，按包号排序）。` +
        `需要时可以去那里翻原文；如果它是空的，说明还没有被压缩过的历史。`,
    ]

    const pending = pendingNotes.get(String(session?.id ?? session?.header?.id ?? ''))
    if (pending !== undefined) lines.push(pending)
    return lines.join('\n')
  } catch {
    return ''
  }
}

/**
 * One-shot requests owed to the model, keyed by Session id.
 *
 * A request lives here for one assembly and is then dropped: the next assembly
 * no longer carries it. Keeping it would have the model rewrite the same summary
 * on every turn from then on.
 */
const pendingNotes = new Map()

/** Queue a request that the next assembly will carry, then forget. */
function oweNote(sessionId, text) {
  if (sessionId === '') return
  pendingNotes.set(sessionId, text)
  log('owing one note to %s', sessionId)
}

/**
 * Take the request owed to this Session, if any, and forget it.
 *
 * Reading and dropping in one call is what makes it one-shot: the assembly that
 * reads it is the only one that will.
 */
function takeNote(sessionId) {
  const held = pendingNotes.get(sessionId)
  if (held === undefined) return ''
  pendingNotes.delete(sessionId)
  return held
}

/** A runtime-context message carrying exactly that line. */
function ownMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'runtime-context',
      form: 'snapshot',
      sections: [{ name: 'memory-archive:home', text }],
    },
  }
}

/** Text of a runtime-context message, or `undefined` for anything else. */
function renderedContext(message) {
  if (message?.source?.kind !== 'runtime-context') return undefined
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/**
 * `/memory` implementation.
 *
 * Only the rhythm is editable from here. Everything else about the archive —
 * where it lives, what it holds, whether it is consistent — is derived from the
 * files, so there is nothing else a command could usefully change.
 *
 * Status prints human-readable lines rather than JSON because the same text is
 * what a user sees when typing the command; the panel parses those lines, which
 * keeps one representation instead of two that can drift apart.
 *
 * Every branch returns a CommandResult — `{kind, text}` — because that is the
 * only shape the command gateway accepts; a bare string is rejected before it
 * reaches the user.
 */
function handleMemoryCommand(base, raw) {
  const parts = String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const sub = parts[0] ?? 'status'

  const ok = (text) => ({ kind: 'success', text })
  const fail = (text) => ({ kind: 'error', text })

  if (sub === 'status') {
    const options = currentOptions(base)
    return ok(
      [
        `每包轮数：${options.windowRounds}`,
        `预警字数：${options.warnAtChars}`,
        `归档目录：${options.rootDir}`,
      ].join('\n'),
    )
  }

  if (sub === 'rounds' || sub === 'warn') {
    const value = parts[1]
    if (value === undefined) return fail(`用法：/memory ${sub} <值>`)

    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return fail(`需要一个正数，收到：${value}`)
    const parsed = Math.round(n)

    const key = sub === 'rounds' ? 'windowRounds' : 'warnAtChars'

    try {
      writeSettings({ [key]: parsed })
    } catch (error) {
      return fail(`写入失败：${String(error?.message ?? error)}`)
    }
    log('config changed: %s=%s', key, String(parsed))
    // No restart needed: `archive` re-reads the file, so the next exchange
    // already uses the new value.
    return ok(`已写入 ${key} = ${String(parsed)}。下一次归档就生效。`)
  }

  if (sub === 'reset') {
    try {
      writeSettings({ ...DEFAULTS })
    } catch (error) {
      return fail(`写入失败：${String(error?.message ?? error)}`)
    }
    return ok('已恢复默认配置。下一次归档就生效。')
  }

  return fail('用法：/memory status | rounds <n> | warn <n> | reset')
}


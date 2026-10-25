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
 *   <workspace>/.dsh-memory/staging/NNNN.md        exchanges copied, not yet packed
 *   <workspace>/.dsh-memory/packs/pack-NNN/NN.md   one exchange per file
 *   <workspace>/.dsh-memory/packs/pack-NNN/_note.md  the pack's index and range
 *   <workspace>/AGENTS.local.md                    the pointer the model reads
 *
 * No language model is called. The model maintains its own notes: the index is
 * written here, and anything it adds below the marker is preserved.
 *
 * The pointer states what the archive covers and where the gaps are. An index
 * that reads as tidier than the archive really is would be worse than no index,
 * because a reader trusts it.
 *
 * Pack modes, mutually exclusive:
 *
 *   manual  pack when staging holds `windowRounds` exchanges
 *   sync    pack when DSH compacts, so the archive tracks what the model lost
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  coverage,
  digestBodies,
  digestPack,
  listPacks,
  listStaged,
  packStaged,
  seqOfStaged,
  stagedUnanswered,
  stagingChars,
  stagingDir,
} from './pack.mjs'

export const name = 'memory-archive'

const DEFAULTS = {
  /** 'manual' packs on a fixed number of exchanges; 'sync' follows DSH compaction. */
  mode: 'manual',
  /** Exchanges per pack in `manual` mode. */
  windowRounds: 15,
  /** Where archives live, relative to the session's working directory. */
  rootDir: '.dsh-memory',
  /** Warn the model once staging passes this many characters. */
  warnAtChars: 200_000,
}

const POINTER_FILE = 'AGENTS.local.md'
const BLOCK_START = '<!-- dsh-memory:begin -->'
const BLOCK_END = '<!-- dsh-memory:end -->'

const LOG_PATH = (() => {
  try {
    const bridge = '\\\\vmware-host\\Shared Folders\\dsh-portable\\_bridge\\logs'
    if (existsSync(bridge)) return join(bridge, 'memory.log')
  } catch {
    /* not reachable */
  }
  return join(homedir(), 'memory-archive.log')
})()

/**
 * Append one line to the archive's own change log.
 *
 * Written from the same code path that changes the archive, not by hand: a log
 * that depends on someone remembering to write it stops exactly when things get
 * busy, and then describes a state that no longer exists.
 */
function appendAudit(root, message) {
  try {
    mkdirSync(root, { recursive: true })
    const file = join(root, '_archive-log.md')
    const line = `- ${new Date().toISOString()} ${message}` + '\n'
    appendFileSync(file, line, 'utf8')
  } catch {
    /* the archive itself must not fail because its log did */
  }
}

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
      if (current !== null) exchanges.push(current)
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
  if (current !== null) exchanges.push(current)
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
  // Ask the archive rather than a span: coverage now reports the exact set of
  // question seqs it holds, so membership is a set lookup and a question that
  // sits between two packs is correctly seen as archived.
  const cover = coverage(root)
  const coveredSet = new Set(cover.covered ?? [])
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
// the pointer file
// ---------------------------------------------------------------------------


export function renderBlock(rootDir, state) {
  const { packs, stagedFiles, gaps, unknownRange, minSeq, maxSeq, coveredCount, warning } = state
  const lines = [BLOCK_START, '## 早期记忆', '']

  if (packs.length === 0) {
    lines.push('本会话还没有打包的记忆。')
  } else {
    lines.push(`更早的对话已归档在工作区的 \`${rootDir}/packs/\`。`)
    lines.push('')
    lines.push('每个 `pack-NNN/` 是一个包，里面的 `01.md`、`02.md`… 各是一轮完整的问答。')
    lines.push('`pack-NNN/_note.md` 是包的目录和覆盖范围；需要时可以把自己的注释补写在里面。')
    lines.push('')
    lines.push('### 已归档')
    // The index names no range on purpose.
    //
    // A pack holds a *set* of questions, and two packs either side of a third
    // can share a numeric span with it while covering different questions. A
    // range here would be the authoritative file stating the least precise
    // thing on the topic, so the index defers to the pack's own note whenever a
    // caller needs the exact list.
    for (const pack of packs) {
      const seqs = Array.isArray(pack.seqs) ? pack.seqs : []
      const missing = pack.unanswered > 0 ? `，其中 ${pack.unanswered} 轮答案未捕获` : ''
      const detail = seqs.length > 0 ? '，问句清单见其 `_note.md`' : '，问句序号未记录'
      lines.push(`- \`${pack.name}/\` — ${pack.count} 轮${missing}${detail}`)
    }

    if (unknownRange.length > 0) {
      lines.push('')
      lines.push(`注意：${unknownRange.join('、')} 没有记录覆盖的问句序号，无法与对话核对。`)
    }

    if (gaps.length > 0) {
      lines.push('')
      lines.push('### 缺口')
      lines.push('以下对话**不在**任何包里：')
      for (const gap of gaps) {
        lines.push(gap.from === gap.to ? `- seq ${gap.from}` : `- seq ${gap.from}–${gap.to}`)
      }
    }

    if (minSeq !== null) {
      lines.push('')
      lines.push(`共归档 ${coveredCount} 轮对话。`)
    }
  }

  if (stagedFiles.length > 0) {
    const seqs = stagedFiles.map(seqOfStaged).filter((n) => n !== null)
    const range = seqs.length > 0 ? `${Math.min(...seqs)}–${Math.max(...seqs)}` : '未知'
    // The staged area gets the same honesty as the packs: an exchange whose
    // answer was never captured is reported here too, otherwise a reader would
    // take the staged set as complete.
    const stagedMissing = state.stagedUnanswered ?? 0
    const missingNote = stagedMissing > 0 ? `，其中 ${stagedMissing} 轮答案未捕获` : ''
    lines.push('')
    lines.push(
      `另有 ${stagedFiles.length} 轮尚未打包${missingNote}，暂存在 \`${rootDir}/staging/\`（seq ${range}）。`,
    )
    lines.push('它们还没有进入任何包，读 packs 时看不到这些。')
  } else if (packs.length > 0) {
    lines.push('')
    lines.push('staging 当前为空：所有已记录的对话都已进入包。')
  }

  if (state.noticed) {
    lines.push('')
    lines.push(`（${state.noticed}）`)
  }

  if (warning) {
    lines.push('')
    lines.push(`⚠️ ${warning}`)
  }

  // A reader cannot tell when this description was written from anything else
  // in the file, and a stale index is indistinguishable from a fresh one.
  lines.push('')
  lines.push(`_本段由记忆插件于 ${state.generatedAt ?? new Date().toISOString()} 生成。_`)

  lines.push('', BLOCK_END)
  return lines.join('\n')
}

export function writePointer(workspace, rootDir, state) {
  const file = join(workspace, POINTER_FILE)
  const block = renderBlock(rootDir, state)
  let existing = ''
  if (existsSync(file)) {
    try {
      existing = readFileSync(file, 'utf8')
    } catch {
      existing = ''
    }
  }
  const start = existing.indexOf(BLOCK_START)
  const end = existing.indexOf(BLOCK_END)
  let next
  if (start >= 0 && end > start) {
    next = existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length)
  } else if (existing.trim() === '') {
    next = block + '\n'
  } else {
    next = existing.replace(/\s*$/, '') + '\n\n' + block + '\n'
  }
  writeFileSync(file, next, 'utf8')
  return file
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

function workspaceOf(session) {
  return session?.header?.cwd ?? session?.header?.workingDirectory ?? process.cwd()
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  log(
    'applying: mode=%s windowRounds=%d rootDir=%s',
    options.mode,
    options.windowRounds,
    options.rootDir,
  )

  const warned = new Set()

  const archive = (session, reason) => {
    try {
      const workspace = workspaceOf(session)
      const root = join(workspace, options.rootDir)

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
      let skippedMessage = null
      const stagedCount = listStaged(stagingDir(root)).length

      const shouldPack =
        options.mode === 'manual'
          ? stagedCount >= options.windowRounds
          : reason === 'compaction' && stagedCount > 0

      if (shouldPack) {
        const take = options.mode === 'manual' ? options.windowRounds : stagedCount
        const preview = previewDigest(stagingDir(root), take)
        const existing = listPacks(root).find((p) => p.digest === preview.digest)

        if (existing !== undefined) {
          // Identical content is already archived. Drop the staged copies
          // without rewriting, so nothing changes and nothing is logged as a
          // change.
          for (const name of listStaged(stagingDir(root)).slice(0, take)) {
            try {
              unlinkSync(join(stagingDir(root), name))
            } catch {
              /* retry next time */
            }
          }
          skippedMessage = `已有内容相同的 ${existing.name}，跳过写入（摘要 ${preview.digest}）。`
          log('skip: identical to %s (%s)', existing.name, preview.digest)
        } else {
          const previous = listPacks(root)
          packed = packStaged(root, take)

          if (packed !== null && packed.incomplete !== true) {
            const sameSeqs = previous.find(
              (p) =>
                p.seqs.length === packed.seqs.length &&
                p.seqs.every((s, i) => s === packed.seqs[i]),
            )
            const repaired = previous.filter(
              (p) => p.digest !== null && p.digest !== packed.digest && p.dir !== packed.dir,
            )

            if (sameSeqs !== undefined && sameSeqs.digest === packed.digest) {
              // Same questions, same content, but the old pack's copy on disk no
              // longer matched its own recorded digest. Calling this "created"
              // would describe the archive getting longer when in fact a damaged
              // copy was restored; the two mean opposite things to a reader.
              appendAudit(
                root,
                `修复 ${packed.packName}（本地副本与记录的摘要不一致，已从会话重建）：` +
                  `${packed.count} 轮，摘要 ${packed.digest}。`,
              )
            } else if (sameSeqs !== undefined && sameSeqs.digest !== null) {
              appendAudit(
                root,
                `替换 ${packed.packName}：同问句但内容不同，摘要 ${sameSeqs.digest} → ${packed.digest}。`,
              )
            } else {
              appendAudit(
                root,
                `新建 ${packed.packName}：${packed.count} 轮，问句 ${packed.seqs.length} 个，摘要 ${packed.digest}。`,
              )
            }

            if (repaired.length > 0) {
              appendAudit(
                root,
                `全量重建 ${repaired.length + 1} 个包（触发：${repaired.map((p) => p.name).join('、')} 摘要不一致）。`,
              )
            }
          }
        }
      }

      if (packed !== null) {
        if (packed.incomplete === true) {
          log(
            'pack %s INCOMPLETE: wrote %d of %d files; staging kept for retry',
            packed.packName,
            packed.written,
            packed.count,
          )
          appendAudit(
            root,
            `打包 ${packed.packName} 未完成：写出 ${packed.written}/${packed.count} 个文件，暂存区保留待重试。`,
          )
        } else {
          log(
            'packed %s: %d exchanges, seq %d..%d, digest %s [staged %d new]',
            packed.packName,
            packed.count,
            packed.minSeq,
            packed.maxSeq,
            packed.digest,
            staged.written,
          )
        }
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

      // Pass the session's own question seqs so "gap" means "a question this
      // session really has that no pack holds", not "a number that is missing
      // from a span".
      const cover = coverage(root, exchanges.map((e) => e.seq))
      writePointer(workspace, options.rootDir, {
        packs: cover.packs,
        stagedFiles: listStaged(stagingDir(root)),
        gaps: cover.gaps,
        unknownRange: cover.unknownRange,
        minSeq: cover.minSeq,
        maxSeq: cover.maxSeq,
        coveredCount: cover.covered.length,
        stagedUnanswered: stagedUnanswered(stagingDir(root)),
        generatedAt: new Date().toISOString(),
        noticed: skippedMessage,
        warning,
      })
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
      }
    } catch (error) {
      log('event handler failed: %s', String(error?.stack ?? error))
    }
  })

  log('listening on session/event (assistant/message, compaction/summary)')
}

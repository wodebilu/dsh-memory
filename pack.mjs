/**
 * pack.mjs — turn staged exchanges into packs, and describe what the archive covers.
 *
 * Two rules shape everything here:
 *
 *  1. The index must not look more complete than the archive is. A reader that
 *     trusts a tidy index will believe a gap does not exist, so gaps are shown
 *     rather than smoothed over.
 *
 *  2. A pack is identified by its *content*, not by the seq range it came from.
 *     Comparing ranges can only answer "was this question archived?"; it cannot
 *     answer "is the archived text the same as what we have now?", so a re-scan
 *     would either rewrite an identical pack or keep a stale answer while
 *     reporting success. A content digest answers both, and makes the decision
 *     the same every time it is asked.
 *
 * A pack records the questions it holds and a digest of its files in `_note.md`.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const PACK_NOTE = '_note.md'

export function stagingDir(root) {
  return join(root, 'staging')
}

export function packsDir(root) {
  return join(root, 'packs')
}

/** Staged exchange files, sorted by their numeric name. */
export function listStaged(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => /^\d+\.md$/.test(name))
      .sort((a, b) => Number(a.slice(0, -3)) - Number(b.slice(0, -3)))
  } catch {
    return []
  }
}

/** The seq a staged file name encodes. */
export function seqOfStaged(name) {
  const n = Number(name.slice(0, -3))
  return Number.isFinite(n) ? n : null
}

/**
 * Digest of a set of exchange files, from names and bytes.
 *
 * Computed from the same list the pack will be written from, so the decision can
 * be made before anything reaches a real pack directory.
 */
export function digestBodies(bodies) {
  const hash = createHash('sha256')
  for (const item of [...bodies].sort((a, b) => (a.outName < b.outName ? -1 : 1))) {
    hash.update(item.outName)
    hash.update('\0')
    hash.update(item.body)
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/** Digest of an existing pack directory, or null when it cannot be read. */
export function digestPack(packDir) {
  let files
  try {
    files = readdirSync(packDir)
      .filter((f) => /^\d+.*\.md$/.test(f))
      .sort()
  } catch {
    return null
  }
  const hash = createHash('sha256')
  for (const name of files) {
    try {
      hash.update(name)
      hash.update('\0')
      hash.update(readFileSync(join(packDir, name)))
      hash.update('\0')
    } catch {
      /* skip unreadable */
    }
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * One pack's declared contents, as recorded in its note.
 * @returns {{ name: string, count: number, seqs: number[], unanswered: number,
 *             digest: string|null, dir: string }}
 */
export function readPackInfo(dir, name) {
  const packDir = join(dir, name)
  let count = 0
  let seqs = []
  let unanswered = 0
  let digest = null

  try {
    const note = readFileSync(join(packDir, PACK_NOTE), 'utf8')
    const m = /包含 (\d+) 轮/.exec(note)
    if (m) count = Number(m[1])
    const u = /其中 (\d+) 轮答案未捕获/.exec(note)
    if (u) unanswered = Number(u[1])

    // The note records the exact question seqs, not a span. A pack covers a set
    // of questions, and the events between two questions are not themselves
    // covered; treating the span as continuous invents gaps that do not exist.
    const list = /问句 seq：([\d,]+)/.exec(note)
    if (list) {
      seqs = list[1]
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    }

    const dg = /内容摘要：([0-9a-f]{12})/.exec(note)
    if (dg) digest = dg[1]
  } catch {
    /* no note: fall through */
  }

  if (count === 0) {
    try {
      count = readdirSync(packDir).filter((f) => /^\d+.*\.md$/.test(f)).length
    } catch {
      count = 0
    }
  }

  return { name, count, seqs, unanswered, digest, dir: packDir }
}

/** Every pack, oldest name first. */
export function listPacks(root) {
  const dir = packsDir(root)
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  return names.map((name) => readPackInfo(dir, name))
}

/**
 * Which question seqs the archive covers.
 *
 * Coverage is a set of questions, not a numeric span. Gaps are computed only
 * between questions that both the archive and the session contain, which the
 * caller supplies via `knownSeqs`: a warning that fires on healthy data is worse
 * than no warning, because it trains the reader to ignore the one that matters.
 */
export function coverage(root, knownSeqs = []) {
  const packs = listPacks(root)
  const covered = new Set()
  const unknownRange = []
  for (const pack of packs) {
    if (!Array.isArray(pack.seqs) || pack.seqs.length === 0) {
      unknownRange.push(pack.name)
      continue
    }
    for (const seq of pack.seqs) covered.add(seq)
  }

  const sorted = [...covered].sort((a, b) => a - b)

  const gaps = []
  if (Array.isArray(knownSeqs) && knownSeqs.length > 0) {
    const known = [...knownSeqs].sort((a, b) => a - b)
    let start = null
    let last = null
    for (const seq of known) {
      if (covered.has(seq)) {
        if (start !== null && last !== null) gaps.push({ from: start, to: last })
        start = null
        last = null
        continue
      }
      // Only questions older than the newest covered one are "missing history";
      // newer ones are simply not packed yet, which the staging line reports.
      if (sorted.length > 0 && seq > sorted[sorted.length - 1]) continue
      if (start === null) start = seq
      last = seq
    }
    if (start !== null && last !== null) gaps.push({ from: start, to: last })
  }

  return {
    packs,
    covered: sorted,
    gaps,
    unknownRange,
    minSeq: sorted.length > 0 ? sorted[0] : null,
    maxSeq: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  }
}

/**
 * Cut a preview at a readable boundary rather than mid-word.
 *
 * A preview that stops inside a word ("...你应该可以在 Gi") reads as if the
 * text itself were broken.
 */
function clipPreview(text, limit = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  const head = space > limit * 0.5 ? cut.slice(0, space) : cut
  return head.trimEnd() + '…'
}

function renderNote(packName, entries, seqs, unansweredCount, digest) {
  const lines = [
    `# ${packName}`,
    '',
    `归档时间：${new Date().toISOString()}`,
    `内容摘要：${digest}`,
    `包含 ${entries.length} 轮对话。`,
  ]
  if (unansweredCount > 0) {
    lines.push(
      `其中 ${unansweredCount} 轮答案未捕获（写入时进程中断，不是对方没有回答）。`,
    )
  }
  if (seqs.length > 0) {
    lines.push(`问句 seq：${seqs.join(',')}`)
  } else {
    lines.push('问句 seq：未记录')
  }
  lines.push('')
  lines.push('## 目录')
  lines.push('')
  for (const e of entries) lines.push(`- ${e.outName}：${e.preview}`)
  lines.push('')
  lines.push('> 这一节以下的备注由阅读者自行添加。')
  lines.push('')
  return lines.join('\n')
}

/** Read the staged exchanges a pack would be built from. */
function readBodies(from, take) {
  const bodies = []
  const seqsTaken = []
  const meta = []
  for (const name of take) {
    let body
    try {
      body = readFileSync(join(from, name), 'utf8')
    } catch {
      continue
    }
    const outName = `${String(bodies.length + 1).padStart(2, '0')}.md`
    bodies.push({ outName, body })
    const seq = seqOfStaged(name)
    if (seq !== null) seqsTaken.push(seq)
    const q = /# 问\s*\n+([^\n]*)/.exec(body)
    meta.push({
      outName,
      sourceName: name,
      preview: clipPreview(q?.[1] ?? ''),
      unanswered: /# 答\s*\n+\s*（答案未捕获/.test(body),
    })
  }
  return { bodies, seqsTaken, meta }
}

function nextPackName(dir) {
  let highest = 0
  try {
    for (const entry of readdirSync(dir)) {
      const m = /^pack-(\d+)$/.exec(entry)
      if (m) highest = Math.max(highest, Number(m[1]))
    }
  } catch {
    /* not created yet */
  }
  return `pack-${String(highest + 1).padStart(3, '0')}`
}

/**
 * Write the staged exchanges into a new pack.
 *
 * The pack is assembled in a temporary directory and renamed into place, so a
 * crash cannot leave a partially written pack under a real name. Staged
 * originals are deleted only after the rename succeeded and the count matches.
 *
 * @returns {{ packName: string, count: number, digest: string,
 *             seqs: number[], minSeq: number, maxSeq: number,
 *             incomplete?: boolean, written?: number } | null}
 */
export function packStaged(root, count) {
  const from = stagingDir(root)
  const to = packsDir(root)
  const staged = listStaged(from)
  if (staged.length === 0) return null

  const take = staged.slice(0, Math.max(0, count))
  if (take.length === 0) return null

  const { bodies, seqsTaken, meta } = readBodies(from, take)
  if (bodies.length === 0) return null

  const digest = digestBodies(bodies)
  const seqs = seqsTaken.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)

  mkdirSync(to, { recursive: true })
  const packName = nextPackName(to)
  const dir = join(to, packName)
  const tmp = `${dir}.tmp-${process.pid}`

  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  for (const { outName, body } of bodies) writeFileSync(join(tmp, outName), body, 'utf8')
  writeFileSync(
    join(tmp, PACK_NOTE),
    renderNote(packName, meta, seqs, meta.filter((m) => m.unanswered).length, digest),
    'utf8',
  )

  let writtenCount = 0
  try {
    writtenCount = readdirSync(tmp).filter((f) => /^\d+.*\.md$/.test(f)).length
  } catch {
    writtenCount = 0
  }

  if (writtenCount !== bodies.length) {
    rmSync(tmp, { recursive: true, force: true })
    return {
      packName,
      count: bodies.length,
      digest,
      seqs,
      minSeq: seqs[0] ?? 0,
      maxSeq: seqs[seqs.length - 1] ?? 0,
      incomplete: true,
      written: writtenCount,
    }
  }

  renameSync(tmp, dir)

  for (const m of meta) {
    try {
      unlinkSync(join(from, m.sourceName))
    } catch {
      /* a leftover staged file will be packed again next time */
    }
  }

  return {
    packName,
    count: bodies.length,
    digest,
    seqs,
    minSeq: seqs[0] ?? 0,
    maxSeq: seqs[seqs.length - 1] ?? 0,
  }
}

/** Total characters held in staging. */
export function stagingChars(dir) {
  let total = 0
  for (const name of listStaged(dir)) {
    try {
      total += readFileSync(join(dir, name), 'utf8').length
    } catch {
      /* skip unreadable */
    }
  }
  return total
}

/** How many staged exchanges have no captured answer. */
export function stagedUnanswered(dir) {
  let count = 0
  for (const name of listStaged(dir)) {
    try {
      const body = readFileSync(join(dir, name), 'utf8')
      if (/# 答\s*\n+\s*（答案未捕获/.test(body)) count += 1
    } catch {
      /* skip unreadable */
    }
  }
  return count
}

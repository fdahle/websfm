// The persisted match store: one columnar binary document for every pair, instead of
// one JSON file per pair (TODO ▸ SC-2).
//
// Why: per-pair JSON meant thousands of small files read at every project open (3,578
// on quarry — they saturated OPFS so long that a 4 MB sparse cloud took 12 s to read)
// and parsing them built one `[ia, ib]` JS array per match, ~40 B of V8 heap each.
// In memory a pair's matches are a flat Uint32Array [ia0, ib0, ia1, ib1, …]
// (core/sfm/matchCodec.js reads it as a pair list), so a match costs 8 B, outside the
// heap.
//
// Layout (P pairs, M matches in total):
//   meta    { version: 1, images: [uuid…], count: P }   — JSON
//   pairs   Uint32 2P   image indices (idA, idB) into meta.images, idA < idB by uuid
//   counts  Uint32 3P   rawCount, inlierCount, match count (in pairs)
//   flags   Uint8   P   bit 0 excluded (enabled: false) · bit 1 weak · bit 2 has F
//   F       Float64 9P  row-major; zero when the flag says there is none
//   matches Uint32 2M   every pair's matches, concatenated in pair order
// `flags` is its own buffer so excluding a pair rewrites P bytes, not the matches.
//
// The matches column is never read whole. A project opens on the INDEX (every column
// but `matches`: ~93 B per pair), and a pair's matches are one byte range of the
// matches file — pair p starts at element 2·Σ_{q<p} counts[3q+2], so the counts column
// already is the offset table and the format needs none of its own.

export const MATCH_DOC_VERSION = 1
export const MATCH_HEAVY_KEYS = ['pairs', 'counts', 'F', 'matches']
// The columns a project open reads (everything but the matches themselves).
export const MATCH_INDEX_KEYS = ['pairs', 'counts', 'flags', 'F']

const FLAG_EXCLUDED = 1,
  FLAG_WEAK = 2,
  FLAG_HAS_F = 4

/** The flat match array of a [[ia, ib], …] list (or an existing Uint32Array). */
export function toMatchArray(matches) {
  if (matches instanceof Uint32Array) return matches
  const out = new Uint32Array((matches?.length ?? 0) * 2)
  let i = 0
  for (const [a, b] of matches || []) {
    out[i++] = a
    out[i++] = b
  }
  return out
}

/** Number of match pairs in a flat match array. */
export const matchCount = (m) => (m ? m.length >>> 1 : 0)

// An entry's match count without its matches: the store's entries carry `nMatches`
// (their matches may not be resident); a plain entry (tests, imports) carries them.
const countOf = (e) => (Number.isInteger(e.nMatches) ? e.nMatches : matchCount(toMatchArray(e.matches)))

/** The entries a document persists: done, with at least one match. */
export const isPersistedMatchEntry = (e) => e.status === 'done' && countOf(e) > 0

/**
 * Pack the pairs worth keeping (done, with matches) into the document.
 * @param entries iterable of [pairId, { idA, idB, rawCount, inlierCount, F, nMatches?, matches?, enabled, weak }]
 * @param matchesOf (pairId, entry) → that pair's matches as a part: a Uint32Array of
 *   2·count elements, or anything the caller's writer concatenates (a Blob slice of
 *   the previous document). Default: `entry.matches`.
 * @returns { meta, buffers (pairs/counts/flags/F), matchParts (in pair order),
 *   layout: [{ pairId, entry, off, n }] — each kept pair's element offset in the new
 *   matches column }
 */
export function packMatchDocument(entries, { matchesOf = (_pid, e) => toMatchArray(e.matches) } = {}) {
  const keep = []
  for (const [pairId, e] of entries) if (isPersistedMatchEntry(e)) keep.push([pairId, e])
  const imageIndex = new Map(),
    images = []
  const indexOf = (uuid) => {
    let i = imageIndex.get(uuid)
    if (i === undefined) {
      i = images.length
      imageIndex.set(uuid, i)
      images.push(uuid)
    }
    return i
  }
  const P = keep.length
  const pairs = new Uint32Array(2 * P),
    counts = new Uint32Array(3 * P),
    F = new Float64Array(9 * P)
  const matchParts = [],
    layout = []
  let off = 0
  keep.forEach(([pairId, e], p) => {
    pairs[2 * p] = indexOf(e.idA)
    pairs[2 * p + 1] = indexOf(e.idB)
    const n = countOf(e)
    counts[3 * p] = e.rawCount ?? 0
    counts[3 * p + 1] = e.inlierCount ?? 0
    counts[3 * p + 2] = n
    if (e.F) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) F[9 * p + 3 * r + c] = e.F[r][c]
    const part = matchesOf(pairId, e)
    if (part instanceof Uint32Array && part.length !== 2 * n) {
      throw new Error(`Match document: pair ${pairId} holds ${part.length / 2} matches, its count says ${n}`)
    }
    matchParts.push(part)
    layout.push({ pairId, entry: e, off, n })
    off += 2 * n
  })
  return {
    meta: { version: MATCH_DOC_VERSION, images, count: P },
    buffers: { pairs, counts, flags: packMatchFlags(keep.map(([, e]) => e)), F },
    matchParts,
    layout,
    matchElements: off,
  }
}

/** Concatenate typed match parts into one column (tests, a document with no file behind it). */
export function concatMatchParts(parts) {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint32Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Just the flags buffer, in the same pair order packMatchDocument uses. */
export function packMatchFlags(keptEntries) {
  const flags = new Uint8Array(keptEntries.length)
  keptEntries.forEach((e, p) => {
    flags[p] = (e.enabled === false ? FLAG_EXCLUDED : 0) | (e.weak ? FLAG_WEAK : 0) | (e.F ? FLAG_HAS_F : 0)
  })
  return flags
}

/**
 * The entries a document's INDEX describes, as [pairId, entry] with `nMatches` (the
 * match count) and `off` (the pair's first element in the matches column) instead of
 * the matches themselves. `matchBytes` (the matches file's size) is checked against
 * the counts when given. Throws on a malformed document (sizes disagree).
 */
export function unpackMatchIndex(meta, buffers, { matchBytes } = {}) {
  if (meta?.version !== MATCH_DOC_VERSION) throw new Error(`Unsupported match document version ${meta?.version}`)
  const P = meta.count,
    images = meta.images
  const u32 = (b) => (b ? new Uint32Array(b) : new Uint32Array(0))
  const pairs = u32(buffers.pairs),
    counts = u32(buffers.counts)
  const flags = buffers.flags ? new Uint8Array(buffers.flags) : new Uint8Array(0)
  const F = buffers.F ? new Float64Array(buffers.F) : new Float64Array(0)
  if (pairs.length !== 2 * P || counts.length !== 3 * P || flags.length !== P || F.length !== 9 * P) {
    throw new Error('Incomplete match document')
  }
  let total = 0
  for (let p = 0; p < P; p++) total += counts[3 * p + 2]
  if (matchBytes !== undefined && matchBytes !== 8 * total) throw new Error('Incomplete match document')
  const out = []
  let o = 0
  for (let p = 0; p < P; p++) {
    const idA = images[pairs[2 * p]],
      idB = images[pairs[2 * p + 1]]
    if (idA == null || idB == null) throw new Error('Incomplete match document')
    const n = counts[3 * p + 2],
      f = flags[p]
    const Fm = f & FLAG_HAS_F ? [0, 1, 2].map((r) => [0, 1, 2].map((c) => F[9 * p + 3 * r + c])) : null
    out.push([
      `${idA}--${idB}`,
      {
        idA,
        idB,
        rawCount: counts[3 * p],
        inlierCount: counts[3 * p + 1],
        F: Fm,
        nMatches: n,
        off: o,
        status: 'done',
        enabled: !(f & FLAG_EXCLUDED),
        weak: !!(f & FLAG_WEAK),
      },
    ])
    o += 2 * n
  }
  return out
}

/** Byte range [start, end) of a pair's matches in the matches file. */
export const matchByteRange = (off, n) => [4 * off, 4 * (off + 2 * n)]

/**
 * Group pairs for reading: consecutive requests (in the caller's order) whose ranges
 * are ascending and close together in one file share one read. A window ends at
 * `windowBytes` or at a gap larger than `maxGapBytes` (reading the gap would cost more
 * than another request). `items`: [{ file, off, n, ... }] → [{ file, start, end, items }].
 */
export function planMatchReads(items, { windowBytes = 32 * 2 ** 20, maxGapBytes = 256 * 1024 } = {}) {
  const windows = []
  let cur = null
  for (const it of items) {
    const [s, e] = matchByteRange(it.off, it.n)
    if (cur && cur.file === it.file && s >= cur.end && s - cur.end <= maxGapBytes && e - cur.start <= windowBytes) {
      cur.end = e
      cur.items.push(it)
      continue
    }
    cur = { file: it.file, start: s, end: e, items: [it] }
    windows.push(cur)
  }
  return windows
}

// matchAll's per-run descriptor cache: each image's descriptors load from project
// storage once per run instead of once per pair, but do not stay resident for the
// whole run. Holding every image was 10 MB per 20 k-keypoint SIFT image: 50 GB at
// 5 000 images (TODO ▸ SC-2).
//
// Two releases keep it bounded:
//   • reference counts: an image's entries are dropped after its last pair, known up
//     front from the run's pair list (`release(uuid)` after each pair);
//   • a byte budget: over it, the resolved entry whose next pair is furthest ahead goes
//     first (Belady's MIN, as the dense fusion and orthophoto caches evict). The pair
//     list is the order the run takes its pairs in, so the next use of every image is
//     known. Least recently used was the old rule, and an exhaustive pair list sweeps
//     the block row by row: once its descriptors outgrew the budget, every pair missed.
//     PUTI at 4,000 px (444 photos, 4.4 GB of descriptors, 2 GiB) loaded them 71,313
//     times for 98,346 pairs, and the loads were most of matching's time.
//
// An entry is an image's descriptors (key = its uuid) or something derived from them
// that is worth keeping on its own, such as its subset-gate sample (key = anything,
// `owner` = the image's uuid): it lives and is released with its owner, and counts
// toward the same budget, but goes only after every full descriptor set has gone,
// because it is small and saves the full load. Entries with no pair left (or not in
// the pair list) go first; a tie goes least recently used first.
//
// It stores PROMISES (concurrent pairs sharing an image must share one load), so an
// entry's bytes count once it resolves: `byteLength` of the value.
export function createDescriptorCache({ pairs = [], budgetBytes = 1024 ** 3 } = {}) {
  // uuid → the positions of its pairs, ascending; `done` counts the ones released.
  const uses = new Map()
  pairs.forEach(([a, b], p) => {
    for (const u of [a.uuid, b.uuid]) {
      let list = uses.get(u)
      if (!list) uses.set(u, (list = []))
      list.push(p)
    }
  })
  const done = new Map()
  const nextUse = (uuid) => uses.get(uuid)?.[done.get(uuid) ?? 0] ?? Infinity

  const entries = new Map() // key → { promise, bytes, owner, derived } in use order (LRU first)
  let bytes = 0,
    loads = 0,
    hits = 0,
    evictions = 0,
    loadedBytes = 0,
    readMs = 0,
    convertMs = 0,
    byteLoads = 0,
    peak = 0

  const drop = (key, e) => {
    entries.delete(key)
    if (e.bytes != null) bytes -= e.bytes
  }
  // The resolved entry to drop: full descriptors before derived entries, then the one
  // used furthest ahead, then the least recently used.
  const victim = () => {
    let best = null,
      bestKey = null,
      bestRank = -1
    for (const [key, e] of entries) {
      if (e.bytes == null) continue // still loading
      const rank = (e.derived ? 0 : 2 ** 52) + Math.min(nextUse(e.owner), 2 ** 51)
      if (rank > bestRank) {
        best = e
        bestKey = key
        bestRank = rank
      }
    }
    return best ? [bestKey, best] : null
  }
  const evict = () => {
    while (bytes > budgetBytes) {
      const v = victim()
      if (!v) return
      drop(...v)
      evictions++
    }
  }
  return {
    has: (key) => entries.has(key),
    get(key) {
      const e = entries.get(key)
      if (!e) return undefined
      hits++
      entries.delete(key)
      entries.set(key, e) // most recently used
      return e.promise
    },
    // `owner`: the image an entry derived from it belongs to (default: the key itself,
    // an image's own descriptors).
    set(key, promise, { owner = key } = {}) {
      const derived = owner !== key
      if (!derived) loads++
      const old = entries.get(key)
      if (old) drop(key, old)
      const e = { promise, bytes: null, owner, derived }
      entries.set(key, e)
      promise.then(
        (d) => {
          if (entries.get(key) !== e) return
          e.bytes = d?.byteLength ?? 0
          if (!derived) loadedBytes += e.bytes
          bytes += e.bytes
          if (bytes > peak) peak = bytes
          evict()
        },
        () => {
          if (entries.get(key) === e) entries.delete(key)
        },
      )
    },
    // One of `uuid`'s pairs finished: drop its entries once no pair needs them any more.
    release(uuid) {
      const n = (done.get(uuid) ?? 0) + 1
      done.set(uuid, n)
      if (n < (uses.get(uuid)?.length ?? 1)) return
      for (const [key, e] of entries) if (e.owner === uuid) drop(key, e)
    },
    // Where a load's time went (pairMatch loadDesc): the storage read, the conversion.
    noteLoad(t) {
      readMs += t.readMs ?? 0
      convertMs += t.convertMs ?? 0
      if (t.bytes) byteLoads++
    },
    stats: () => ({
      loads,
      byteLoads,
      hits,
      evictions,
      loadedBytes,
      readMs,
      convertMs,
      budgetBytes,
      peakBytes: peak,
      residentBytes: bytes,
    }),
  }
}

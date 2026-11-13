// A tiled orthophoto's visit cache (core/products/ortho.js orthorectifyTiled): the run
// visits each group's maps once per pass, in a sequence known in advance, so a map's
// planes and photo stay while a later visit wants them and the one wanted furthest
// ahead goes first (Belady). A pass that needs photos names them first and the next few
// load ahead. A photo decode that runs out of memory shrinks the cache. Pure.

import { viewBytes } from './orthoPlan.js'

// `sequence`: the map of every visit, in order; `cacheBytes`: the cache's budget;
// `loadMap(mi)` / `loadImage(mi, m, pxPerCell, opts)` read a map and its photo;
// `mapPxPerCell(m)` the photo resolution a map needs; `tick()` counts a visit.
// → { fetch, planPhotos, visited, clock, ms, skip, clear, counts }
export function createVisits({ sequence, cacheBytes, loadMap, loadImage, mapPxPerCell, opts, tick }) {
  const nextUse = new Float64Array(sequence.length)
  {
    const seen = new Map()
    for (let p = sequence.length - 1; p >= 0; p--) {
      nextUse[p] = seen.get(sequence[p]) ?? Infinity
      seen.set(sequence[p], p)
    }
  }
  const cache = new Map() // mi → { m, photo, hasPhoto, bytes, next }
  let cached = 0,
    mapLoads = 0,
    photoLoads = 0,
    cacheHits = 0
  // The cache's limit: `cacheBytes`, until a photo decode runs out of memory (below).
  let cacheLimit = cacheBytes,
    shrinks = 0
  // A prefetched entry (`pinned`, below) stays until its visit.
  const evict = (keep = -1) => {
    for (const [mi, e] of cache)
      if (e.next === Infinity && mi !== keep && !e.pinned) {
        cache.delete(mi)
        cached -= e.bytes
      }
    while (cached > cacheLimit && cache.size > (cache.has(keep) ? 1 : 0)) {
      let worst = -1,
        far = -Infinity
      for (const [mi, e] of cache)
        if (e.next > far && mi !== keep && !e.pinned) {
          far = e.next
          worst = mi
        }
      if (worst < 0) break
      cached -= cache.get(worst).bytes
      cache.delete(worst)
    }
  }
  // The tab's real ceiling is below what the arithmetic allows when buffers come and go
  // (quarry-347 at long side 12,000: 56 photo decodes failed "Out of memory at ImageData
  // creation" at 14.6 GB of process data, with an 8.6 GB cache). A decode that runs out of
  // memory takes a quarter off the cache for the rest of the run and is tried once more;
  // only a second failure falls back to the map's own colour. (Halving cost the same run
  // 1,313 photo decodes instead of ~900 after one refusal.)
  const loadPhoto = async (mi, e) => {
    try {
      return await loadImage(mi, e.m, mapPxPerCell(e.m), { rethrowOutOfMemory: true })
    } catch (err) {
      if (!err?.outOfMemory) throw err
      shrinks++
      cacheLimit = Math.max(1, Math.min(cacheLimit, cached) * 0.75)
      evict(mi)
      return loadImage(mi, e.m, mapPxPerCell(e.m))
    }
  }
  // A map's planes, and its photo once a pass needs colour (the mosaic's label pass
  // does not), loaded on a miss.
  // Where the time goes (ms), for the caller's debug log: map reads + photo decodes,
  // the label pass, the colour pass, and a multiband blend's ring samples and pyramids.
  const ms = { read: 0, label: 0, colour: 0, ring: 0, pyramid: 0 }
  const clock = (key, t) => {
    ms[key] += performance.now() - t
  }
  // A pass that needs photos names its maps in visit order first (planPhotos), and up to
  // `opts.photoPrefetch` of the next ones load ahead: the browser decodes a photo off the
  // worker's thread (createImageBitmap), so several decodes then run while this one
  // computes, where one at a time they ran end to end. The photos are the same either
  // way; the caller leaves room in the cache budget for the extra entries.
  const prefetchDepth = loadImage ? Math.max(0, opts.photoPrefetch ?? 0) : 0
  let plan = [],
    planPos = 0
  const pending = new Map() // mi → its entry's load
  const topUp = () => {
    while (pending.size < prefetchDepth && planPos < plan.length) {
      const mi = plan[planPos++]
      if (cache.get(mi)?.hasPhoto || pending.has(mi)) continue
      pending.set(mi, fetchEntry(mi, true, true))
    }
  }
  const planPhotos = (list) => {
    plan = list
    planPos = 0
    topUp()
  }
  const fetch = async (mi, wantPhoto) => {
    const t = performance.now()
    try {
      if (wantPhoto && pending.has(mi)) {
        const e = await pending.get(mi)
        pending.delete(mi)
        e.pinned = false
        cacheHits++
        topUp()
        return e
      }
      return await fetchEntry(mi, wantPhoto)
    } finally {
      clock('read', t)
    }
  }
  const fetchEntry = async (mi, wantPhoto, prefetch = false) => {
    let e = cache.get(mi)
    if (e && (!wantPhoto || e.hasPhoto) && !prefetch) cacheHits++
    if (!e) {
      const entry = { m: null, photo: null, hasPhoto: false, bytes: 0, next: Infinity, pinned: prefetch }
      e = entry
      cache.set(mi, e)
      e.mapLoad = loadMap(mi).then((m) => {
        mapLoads++
        entry.m = m
        entry.bytes = opts.mapsResident ? 0 : viewBytes(m)
        cached += entry.bytes
      })
      await e.mapLoad
    } else {
      if (prefetch) e.pinned = true
      if (!e.m) await e.mapLoad // a prefetch is reading it
    }
    if (wantPhoto && !e.hasPhoto) {
      e.hasPhoto = true // claimed before the await: a second request waits on the first
      e.photoLoad = loadImage ? loadPhoto(mi, e) : Promise.resolve(null)
      e.photo = await e.photoLoad
      if (e.photo) {
        photoLoads++
        const b = e.photo.data?.byteLength ?? 0
        e.bytes += b
        cached += b
      }
    } else if (wantPhoto && e.photoLoad) await e.photoLoad
    return e
  }
  let pos = 0
  const visited = (mi, e) => {
    const p = pos++
    if (e) e.next = nextUse[p]
    else {
      const c = cache.get(mi)
      if (c) c.next = nextUse[p]
    }
    evict()
    tick()
  }
  return {
    fetch,
    planPhotos,
    visited,
    clock,
    // Where the time went (ms), by step.
    ms,
    // Visits another worker made (a group it claimed): passed over, so what comes next stays in step.
    skip: (n) => {
      pos += n
    },
    clear: () => cache.clear(),
    counts: () => ({ mapLoads, photoLoads, cacheHits, shrinks, cacheLimit }),
  }
}

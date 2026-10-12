// matchAll's per-run descriptor cache: each image's descriptors load from OPFS once
// per run instead of once per pair — but no longer stay resident for the whole run.
// Holding every image was 10 MB per 20 k-keypoint SIFT image: 50 GB at 5 000 images
// (TODO ▸ SC-2).
//
// Two releases keep it bounded:
//   • reference counts — an image's entry is dropped after its last pair, known up
//     front from the run's pair list (`release(uuid)` after each pair);
//   • a byte budget — over it, the least recently used resolved entries go; a later
//     pair simply reloads them (a cheap OPFS read next to a match).
// It stores PROMISES (concurrent pairs sharing an image must share one load), so an
// entry's bytes count once it resolves.
export function createDescriptorCache({ pairs = [], budgetBytes = 1024 ** 3 } = {}) {
  const remaining = new Map()
  for (const [a, b] of pairs) {
    remaining.set(a.uuid, (remaining.get(a.uuid) ?? 0) + 1)
    remaining.set(b.uuid, (remaining.get(b.uuid) ?? 0) + 1)
  }
  const entries = new Map() // uuid → { promise, bytes } in use order (LRU first)
  let bytes = 0, loads = 0, peak = 0

  const evict = () => {
    for (const [uuid, e] of entries) {
      if (bytes <= budgetBytes) break
      if (e.bytes == null) continue // still loading
      entries.delete(uuid); bytes -= e.bytes
    }
  }
  return {
    has: (uuid) => entries.has(uuid),
    get(uuid) {
      const e = entries.get(uuid)
      if (!e) return undefined
      entries.delete(uuid); entries.set(uuid, e) // most recently used
      return e.promise
    },
    set(uuid, promise) {
      loads++
      const e = { promise, bytes: null }
      entries.set(uuid, e)
      promise.then((d) => {
        if (entries.get(uuid) !== e) return
        e.bytes = d?.byteLength ?? 0
        bytes += e.bytes
        if (bytes > peak) peak = bytes
        evict()
      }, () => { if (entries.get(uuid) === e) entries.delete(uuid) })
    },
    // One of `uuid`'s pairs finished: drop it once no pair needs it any more.
    release(uuid) {
      const n = (remaining.get(uuid) ?? 1) - 1
      remaining.set(uuid, n)
      if (n > 0) return
      const e = entries.get(uuid)
      if (e) { entries.delete(uuid); if (e.bytes != null) bytes -= e.bytes }
    },
    stats: () => ({ loads, peakBytes: peak, residentBytes: bytes }),
  }
}

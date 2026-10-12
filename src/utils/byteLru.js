// A byte-bounded LRU for per-item buffers that live on disk and are read on demand
// (an image's keypoints, a pair's matches — TODO ▸ SC-2/SC-3). Plain data, never
// reactive: what a viewer re-renders on is the record's count/status, not this.
//
// Two kinds of entry:
//   • clean — a copy of bytes that are also on disk; evictable, least recently used
//     first, whenever the total is over `budgetBytes`;
//   • pinned — the only copy (fresh detection/matching not yet persisted, or a project
//     that cannot persist). Never evicted; `unpin(key, value)` once the save landed.
// Pinned bytes count toward the total, so a long unsaved run shows up in `stats()`,
// but only clean entries are ever dropped to make room.
export function createByteLru({ budgetBytes = 256 * 2 ** 20 } = {}) {
  const entries = new Map() // key → { value, bytes, pinned } in use order (LRU first)
  let bytes = 0, peak = 0, hits = 0, misses = 0, evictions = 0

  function evict() {
    if (bytes <= budgetBytes) return
    for (const [key, e] of entries) {
      if (bytes <= budgetBytes) break
      if (e.pinned) continue
      entries.delete(key); bytes -= e.bytes; evictions++
    }
  }

  return {
    has: (key) => entries.has(key),
    // The value, marked most recently used; undefined on a miss.
    get(key) {
      const e = entries.get(key)
      if (!e) { misses++; return undefined }
      hits++
      entries.delete(key); entries.set(key, e)
      return e.value
    },
    // The value without touching recency (diagnostics, identity checks).
    peek: (key) => entries.get(key)?.value,
    set(key, value, size, { pinned = false } = {}) {
      const old = entries.get(key)
      if (old) { entries.delete(key); bytes -= old.bytes }
      const b = Math.max(0, Number(size) || 0)
      entries.set(key, { value, bytes: b, pinned: !!pinned })
      bytes += b
      if (bytes > peak) peak = bytes
      evict()
      return value
    },
    // The save of `value` landed: it may be evicted from now on. A no-op when the key
    // has since been replaced (a newer value is still unsaved).
    unpin(key, value) {
      const e = entries.get(key)
      if (!e || (value !== undefined && e.value !== value)) return false
      e.pinned = false
      evict()
      return true
    },
    isPinned: (key) => !!entries.get(key)?.pinned,
    delete(key) {
      const e = entries.get(key)
      if (!e) return false
      entries.delete(key); bytes -= e.bytes
      return true
    },
    clear() { entries.clear(); bytes = 0 },
    setBudget(next) { budgetBytes = next; evict() },
    stats() {
      let pinnedBytes = 0, pinned = 0
      for (const e of entries.values()) if (e.pinned) { pinned++; pinnedBytes += e.bytes }
      return { entries: entries.size, bytes, pinned, pinnedBytes, peakBytes: peak, budgetBytes, hits, misses, evictions }
    },
  }
}

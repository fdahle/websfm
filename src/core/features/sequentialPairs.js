// Pair selection for an ordered capture (video frames, a flight strip, or an
// orbit around an object). Each image is matched to the next `overlap` images in
// capture order, reducing exhaustive O(N²) matching to O(N·overlap). Optional
// wrapping closes a circular orbit by also linking the end of the sequence back
// to its beginning.

/**
 * @template T
 * @param {T[]} items
 * @param {{ overlap?: number, loopClosure?: boolean }} options
 * @returns {[T, T][]}
 */
export function sequentialPairs(items, { overlap = 10, loopClosure = false } = {}) {
  const n = items.length
  if (n < 2) return []

  const span = Math.min(n - 1, Math.max(1, Math.floor(Number(overlap) || 1)))
  const pairs = []
  const seen = new Set()
  for (let i = 0; i < n; i++) {
    for (let offset = 1; offset <= span; offset++) {
      let j = i + offset
      if (j >= n) {
        if (!loopClosure) break
        j %= n
      }
      if (i === j) continue
      const key = i < j ? `${i}:${j}` : `${j}:${i}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push([items[i], items[j]])
    }
  }
  return pairs
}

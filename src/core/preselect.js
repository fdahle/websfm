// Pair preselection for matching. Given camera positions, keep only each image's
// nearest neighbours so an ordered strip / block costs ~O(N·k) matches instead of
// the exhaustive O(N²). Pure — the store supplies positions (from imported poses)
// and turns the returned key set back into image pairs.

// Sorted "uuidA--uuidB" key, matching useMatchesStore.pairId so the store can test
// membership directly.
function pairKey(a, b) {
  return a < b ? `${a}--${b}` : `${b}--${a}`
}

function dist3(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = (a[2] ?? 0) - (b[2] ?? 0)
  return Math.hypot(dx, dy, dz)
}

// items: [{ uuid, pos: [x, y, z] }]. Returns a Set of pair keys to match.
// A pair is kept if it is among *either* endpoint's `maxNeighbors` nearest (the
// relation is symmetric), and within `maxDistance` if given.
export function preselectPairs(items, { maxNeighbors = 10, maxDistance = Infinity } = {}) {
  const keep = new Set()
  for (let i = 0; i < items.length; i++) {
    const near = []
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue
      const d = dist3(items[i].pos, items[j].pos)
      if (d <= maxDistance) near.push([d, items[j].uuid])
    }
    near.sort((a, b) => a[0] - b[0])
    const k = Math.min(maxNeighbors, near.length)
    for (let n = 0; n < k; n++) keep.add(pairKey(items[i].uuid, near[n][1]))
  }
  return keep
}

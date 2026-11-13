// The matching-cost statistics a depth map's log line and the run summary report.

// Median / p95 of the matching cost over the pixels with depth. A histogram, not a
// sort: costs live in [0, 2], and copying + comparator-sorting the ~20 M costs of a
// 4570² map took most of the per-image tail on Casa Grande's 1978 scans (62 s in
// node for 19 M values). 4096 bins resolve 0.0005, below the logged 2 decimals.
const COST_BINS = 4096,
  COST_MAX = 2
// → { median, p95, valid }: valid = the pixels with a depth.
export function costStats(depth, cost) {
  const hist = new Uint32Array(COST_BINS)
  let n = 0
  for (let k = 0; k < depth.length; k++) {
    if (!(depth[k] > 0)) continue
    const c = cost[k]
    hist[c >= COST_MAX ? COST_BINS - 1 : c > 0 ? Math.floor(c * (COST_BINS / COST_MAX)) : 0]++
    n++
  }
  if (!n) return { median: 0, p95: 0, valid: 0 }
  const at = (q) => {
    const target = Math.min(n - 1, Math.round(q * (n - 1)))
    let acc = 0
    for (let b = 0; b < COST_BINS; b++) {
      acc += hist[b]
      if (acc > target) return (b + 0.5) * (COST_MAX / COST_BINS)
    }
    return COST_MAX
  }
  return { median: at(0.5), p95: at(0.95), valid: n }
}

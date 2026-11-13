// Small order statistics shared across the code: medians, quantiles, the NMAD and a
// clamp. Each convention has its own name, so a caller keeps the one it was tuned with
// (the SfM golden test pins them) and two copies of the same formula cannot drift apart.
//
// None of them mutates its input. Empty input gives NaN; a caller that wants null or 0
// says so where it calls (`v.length ? median(v) : null`).
//
// Pure module: no Vue/Pinia/OPFS, so it bundles into the worker unchanged.

import { NMAD_K } from './constants.js'

const sortedCopy = (values) => Float64Array.from(values).sort()

/** The median: the middle value, or the mean of the two middle values for an even count. */
export function median(values) {
  const s = sortedCopy(values)
  const n = s.length
  if (!n) return NaN
  const m = n >> 1
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** The upper median: the middle value, or the upper of the two for an even count. Always a sample. */
export function upperMedian(values) {
  const s = sortedCopy(values)
  return s.length ? s[s.length >> 1] : NaN
}

/** The q-quantile of sorted values, interpolated linearly between ranks (R type 7, NumPy's default). */
export function quantileSorted(sorted, q) {
  const n = sorted.length
  if (!n) return NaN
  const h = (n - 1) * q
  const lo = Math.max(0, Math.min(n - 1, Math.floor(h)))
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

/** The q-quantile, interpolated linearly between ranks (see quantileSorted). */
export function quantile(values, q) {
  return quantileSorted(sortedCopy(values), q)
}

/** The sample of sorted values nearest the q-quantile's position (n − 1)·q. Always a sample. */
export function quantileNearest(sorted, q) {
  const n = sorted.length
  if (!n) return NaN
  return sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]
}

/** The sample of sorted values at rank ⌊q·n⌋: the share q of the values lies below it. */
export function quantileRank(sorted, q) {
  const n = sorted.length
  if (!n) return NaN
  return sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))]
}

/**
 * The normalized median absolute deviation about `center` (the median by default):
 * NMAD_K · median |x − center|, which equals σ for normally distributed values.
 */
export function nmad(values, center = median(values)) {
  const dev = new Float64Array(values.length)
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i] - center)
  return NMAD_K * median(dev)
}

/** v limited to [lo, hi] (lo ≤ hi). NaN stays NaN. */
export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

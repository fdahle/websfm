// Pure DEM-vs-reference-DEM comparison for Quality Report ▸ Products (TODO.md ▸
// A-6). The computed DEM minus an imported reference DEM over their overlap: an
// independent, area-wide accuracy check where DEM vs GCPs is a handful of points.
//
// Sign: ΔZ = DEM − reference, so positive means the computed DEM sits ABOVE the
// reference (red on the difference map).
//
// The DEM is read cell by cell (no interpolation: its own heights, exactly); the
// reference is sampled at each cell centre through `sampleRef(x, y)`, which takes
// DEM-frame coordinates and does the reprojection (useExternalStore
// `referenceDemSampler`). A large DEM is compared on a regular sub-grid of at most
// `maxSide` cells a side — a quarter-million samples pin every statistic below to
// far better than the reference's own accuracy, and keep the per-point
// reprojection affordable on the main thread.
//
// Robust statistics are the headline (Höhle & Höhle 2009): photogrammetric DEM
// errors are heavy-tailed (blunders on water, shadows, vegetation edges), so the
// median and NMAD describe the bulk while mean/RMSE are kept for comparison with
// reports that quote them.

const NMAD_K = 1.4826 // NMAD = 1.4826 · median |ΔZ − median|; equals σ for a normal

// dem: { width, height, gsd, originX, originY, data:Float32(NaN = nodata), mask?,
//        support?:Uint8Array (the share of the cell measured, 0–255: 255 = points
//        landed in it, 0 = filled by interpolation; core/products/dem.js) }
// sampleRef: (x, y) → z | null, in the DEM's frame.
// include: (x, y) → bool, in the DEM's frame: only cells it accepts are compared
//   (stable ground, an area of interest); `excluded` counts the DEM cells it refused.
// → { step, width, height, diff:Float32Array (NaN = not compared), demOnly:Uint8Array,
//     demCells, compared, excluded, stats, bySupport } — `diff` is the sub-grid, row 0
//     north, for the map image; `demOnly` marks its cells with a DEM height but no
//     reference one (drawn grey, so missing reference coverage is not mistaken for a
//     DEM hole). `demCells` counts sampled cells with a DEM height; `compared` those
//     that also had a reference height. With `dem.support`, `bySupport` is
//     { direct, interpolated }: the statistics of the cells at least half measured
//     and of the rest, apart (null
//     without a support layer). Async only to yield to the UI every ~`sliceMs`;
//     `signal.aborted` stops it (returns null).
export async function compareDemToReference(
  dem,
  sampleRef,
  { maxSide = 512, sliceMs = 30, signal = null, include = null } = {},
) {
  const { width: w, height: h, gsd, originX, originY, data, mask, support } = dem
  const step = Math.max(1, Math.ceil(Math.max(w, h) / maxSide))
  const gw = Math.ceil(w / step),
    gh = Math.ceil(h / step)
  const diff = new Float32Array(gw * gh).fill(NaN)
  const demOnly = new Uint8Array(gw * gh)
  const half = step >> 1
  let demCells = 0,
    compared = 0,
    excluded = 0
  // Per compared sub-grid cell: 1 = direct, 0 = interpolated (with a support layer).
  const direct = support ? new Uint8Array(gw * gh) : null
  let sliceStart = now()

  for (let gr = 0; gr < gh; gr++) {
    const r = Math.min(h - 1, gr * step + half)
    const y = originY - (r + 0.5) * gsd
    for (let gc = 0; gc < gw; gc++) {
      const c = Math.min(w - 1, gc * step + half)
      const i = r * w + c
      if (mask && !mask[i]) continue
      const z = data[i]
      if (!Number.isFinite(z)) continue
      const x = originX + (c + 0.5) * gsd
      if (include && !include(x, y)) {
        excluded++
        continue
      }
      demCells++
      const ref = sampleRef(x, y)
      if (ref == null || !Number.isFinite(ref)) {
        demOnly[gr * gw + gc] = 1
        continue
      }
      diff[gr * gw + gc] = z - ref
      if (direct) direct[gr * gw + gc] = support[i] >= 128 ? 1 : 0
      compared++
    }
    if (now() - sliceStart > sliceMs) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (signal?.aborted) return null
      sliceStart = now()
    }
  }
  if (signal?.aborted) return null

  const values = new Float32Array(compared)
  let k = 0
  for (let i = 0; i < diff.length; i++) if (!Number.isNaN(diff[i])) values[k++] = diff[i]
  let bySupport = null
  if (direct) {
    const split = [[], []]
    for (let i = 0; i < diff.length; i++) if (!Number.isNaN(diff[i])) split[direct[i]].push(diff[i])
    bySupport = { direct: summarizeDifferences(split[1]), interpolated: summarizeDifferences(split[0]) }
  }
  return {
    step,
    width: gw,
    height: gh,
    diff,
    demOnly,
    demCells,
    compared,
    excluded,
    stats: summarizeDifferences(values),
    bySupport,
  }
}

// Summary of signed differences. Sorts a copy; NaN-free input expected.
// → null for no values, else { n, mean, std, rmse, median, nmad, min, max,
//   le90, le95, q02, q98 }. LE90/LE95 are the 90th/95th percentiles of |ΔZ|
//   (the linear error a map-accuracy standard quotes).
export function summarizeDifferences(values) {
  const n = values?.length ?? 0
  if (!n) return null
  const sorted = Float64Array.from(values).sort()
  let sum = 0,
    sumSq = 0
  for (let i = 0; i < n; i++) {
    sum += sorted[i]
    sumSq += sorted[i] * sorted[i]
  }
  const mean = sum / n
  const median = quantile(sorted, 0.5)
  const absDev = new Float64Array(n),
    absErr = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    absDev[i] = Math.abs(sorted[i] - median)
    absErr[i] = Math.abs(sorted[i])
  }
  absDev.sort()
  absErr.sort()
  return {
    n,
    mean,
    std: n > 1 ? Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / (n - 1))) : 0,
    rmse: Math.sqrt(sumSq / n),
    median,
    nmad: NMAD_K * quantile(absDev, 0.5),
    min: sorted[0],
    max: sorted[n - 1],
    le90: quantile(absErr, 0.9),
    le95: quantile(absErr, 0.95),
    q02: quantile(sorted, 0.02),
    q98: quantile(sorted, 0.98),
  }
}

// Fixed-width histogram of the differences over [lo, hi]; values outside are
// counted in `below`/`above`, never folded into the end bins (that would draw a
// blunder tail as a spike at the edge).
// → { lo, hi, binWidth, counts:number[], below, above }
export function differenceHistogram(diff, lo, hi, bins = 40) {
  if (!(hi > lo)) {
    lo -= 0.5
    hi += 0.5
  }
  const counts = new Array(bins).fill(0)
  const binWidth = (hi - lo) / bins
  let below = 0,
    above = 0
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i]
    if (Number.isNaN(v)) continue
    if (v < lo) {
      below++
      continue
    }
    if (v > hi) {
      above++
      continue
    }
    counts[Math.min(bins - 1, Math.floor((v - lo) / binWidth))]++
  }
  return { lo, hi, binWidth, counts, below, above }
}

// The symmetric colour range for the difference map: white is agreement, so the
// ramp is centred on ZERO (not on the bias — a bias must show as a colour cast),
// and clipped at the 2nd/98th percentile so one blunder does not wash it out.
export function differenceRange(stats) {
  if (!stats) return 1
  const r = Math.max(Math.abs(stats.q02), Math.abs(stats.q98))
  return r > 0 ? r : 1
}

// Sub-grid → RGBA bytes on a diverging ramp over [−range, +range]; DEM-only cells
// (no reference height) in translucent grey, DEM holes transparent. `ramp(t)` →
// [r, g, b] for t ∈ [0, 1] (colormap.js rdBuColor).
export function differenceRgba({ width, height, diff, demOnly = null }, range, ramp) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i]
    if (Number.isNaN(v)) {
      if (demOnly?.[i]) {
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 128
        rgba[i * 4 + 3] = 90
      }
      continue
    }
    const [r, g, b] = ramp(0.5 + 0.5 * Math.max(-1, Math.min(1, v / range)))
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

// Linear-interpolated quantile of an ascending array (the R-7 / NumPy default).
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos),
    hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

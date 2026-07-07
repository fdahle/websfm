// Pure JS reference port of `plane_cost` from crates/reconstruction/src/mvs.rs.
// Its sole job is to validate the WebGPU kernel transcription during the dense-MVS
// GPU port: the worker runs the GPU kernel and this reference on the same pixels
// and compares the cost (GPU f32 vs this). Kept numerically faithful to the Rust —
// nearest reference sample, bilinear source sample, ZNCC over a (2r+1)² window,
// cost = 1 − ncc in [0, 2]. Intensities are 0..255 (matches both the Rust path and
// the GPU kernel, which scales its 0..1 texels back to 0..255 so the textureless
// `denom` cutoff lines up).
//
// "No measurement" vs "bad hypothesis" (Step 1 — adaptive best-K over valid
// sources): a source that cannot see the reference patch — the warp leaves the
// source image, lands on a masked texel, covers <4 pixels, or is textureless —
// yields NO measurement and returns the INVALID sentinel (1e9; test with ≥1e8).
// Aggregation (aggregateValidCosts) EXCLUDES sentinels rather than averaging a
// max-cost 2.0 in, so a source whose footprint doesn't cover the pixel can't
// floor the aggregated cost. A degenerate *plane* (|n·P|<1e-9) is a bad
// hypothesis, not a missing measurement, so it still scores the real max cost 2.0.

// Sentinel returned by planeCostRef when a source provides no measurement.
// Aggregation treats any value ≥ 1e8 as "exclude from best-K".
export const INVALID = 1e9

// Bilinear grayscale sample at (x, y); edge-clamped. Mirrors mvs.rs sample_gray.
function sampleGrayBilinear(img, w, h, x, y) {
  if (w === 0 || h === 0) return 0
  const xc = Math.min(Math.max(x, 0), w - 1)
  const yc = Math.min(Math.max(y, 0), h - 1)
  const x0 = Math.floor(xc), y0 = Math.floor(yc)
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1)
  const fx = xc - x0, fy = yc - y0
  const p00 = img[y0 * w + x0], p10 = img[y0 * w + x1]
  const p01 = img[y1 * w + x0], p11 = img[y1 * w + x1]
  const a = p00 + (p10 - p00) * fx
  const b = p01 + (p11 - p01) * fx
  return a + (b - a) * fy
}

// Cost of the plane (depth at (u,v), unit normal `n` in the reference camera frame)
// scoring the reference patch against one source view.
//   ref: { gray, w, h, fx, fy, cx, cy }
//   src: { gray, w, h, fx, fy, cx, cy, R:[[…]×3], t:[x,y,z], mask? }  (R,t: ref→src frame)
//        mask, when present, is a length-w*h 0/1 lookup (1 = excluded, e.g. film
//        frame / fiducials): a patch warping onto a masked source texel is rejected
//        like an out-of-bounds warp, so the source can't match against its border.
//   n:   [nx, ny, nz] unit normal;  radius: half window
export function planeCostRef(ref, src, u, v, depth, n, radius) {
  const pu = (u - ref.cx) / ref.fx
  const pv = (v - ref.cy) / ref.fy
  const P = [pu * depth, pv * depth, depth]
  const d = n[0] * P[0] + n[1] * P[1] + n[2] * P[2]
  if (Math.abs(d) < 1e-9) return 2.0

  const R = src.R, t = src.t
  let sumR = 0, sumS = 0, sumRR = 0, sumSS = 0, sumRS = 0, cnt = 0
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const xi = u + x, yi = v + y
      if (xi < 0 || yi < 0 || xi >= ref.w || yi >= ref.h) continue
      const ray = [(xi - ref.cx) / ref.fx, (yi - ref.cy) / ref.fy, 1]
      const nr = n[0] * ray[0] + n[1] * ray[1] + n[2] * ray[2]
      // Plane-induced homography R + t·nᵀ/d for the plane n·X = d (d = n·P above).
      // The "+" (not the Hartley–Zisserman "−", which is the n·X + d = 0 convention)
      // is what makes the cost bottom out at the true depth — see mvs.rs for the
      // derivation and the freckle bug it fixes. Keep the three kernels in lockstep.
      const xs = [
        R[0][0] * ray[0] + R[0][1] * ray[1] + R[0][2] * ray[2] + t[0] * nr / d,
        R[1][0] * ray[0] + R[1][1] * ray[1] + R[1][2] * ray[2] + t[1] * nr / d,
        R[2][0] * ray[0] + R[2][1] * ray[1] + R[2][2] * ray[2] + t[2] * nr / d,
      ]
      if (Math.abs(xs[2]) < 1e-9) continue
      const su = src.fx * (xs[0] / xs[2]) + src.cx
      const sv = src.fy * (xs[1] / xs[2]) + src.cy
      if (su < 0 || sv < 0 || su >= src.w || sv >= src.h) return INVALID // warp left source → no measurement
      if (src.mask && src.mask[(sv | 0) * src.w + (su | 0)]) return INVALID // masked texel → no measurement
      const rval = ref.gray[yi * ref.w + xi]
      const sval = sampleGrayBilinear(src.gray, src.w, src.h, su, sv)
      sumR += rval; sumS += sval
      sumRR += rval * rval; sumSS += sval * sval; sumRS += rval * sval
      cnt++
    }
  }
  if (cnt < 4) return INVALID // too little overlap → no measurement
  const mr = sumR / cnt, ms = sumS / cnt
  const vr = sumRR / cnt - mr * mr, vs = sumSS / cnt - ms * ms
  const cov = sumRS / cnt - mr * ms
  const denom = Math.sqrt(vr * vs)
  if (denom < 1e-6) return INVALID // textureless patch → no measurement
  const ncc = Math.max(-1, Math.min(1, cov / denom))
  return 1 - ncc
}

// Aggregate per-source costs over the best-K *valid* sources (occlusion-robust).
// Sentinels (≥1e8) are excluded, not averaged in. Returns the mean of the k
// smallest valid costs (k clamped to the valid count), or the max cost 2.0 when
// no source provided a measurement. Mirrors aggCost in patchmatch.wgsl and
// agg_cost in mvs.rs — keep the three in lockstep (the GPU↔CPU A/B check depends
// on it). `costs` may contain INVALID entries; it is not mutated.
export function aggregateValidCosts(costs, bestK) {
  const valid = costs.filter((c) => c < 1e8)
  if (valid.length === 0) return 2.0
  valid.sort((a, b) => a - b)
  const k = Math.min(Math.max(bestK, 1), valid.length)
  let sum = 0
  for (let j = 0; j < k; j++) sum += valid[j]
  return sum / k
}

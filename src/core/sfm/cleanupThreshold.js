// Bounded-damage reprojection thresholds for track cleanup.
//
// The track filter's job is to remove the outlier tail that bundle adjustment can
// only down-weight. Its thresholds (`filterMaxReprojPx` and 2× that) are absolute
// pixel figures, and they are calibrated for a model whose intrinsics are already
// approximately right. When they are NOT — a scanned aerial frame with no focal
// length falls back to `fx = max(w,h)`, which can be ~50% off — the whole residual
// distribution shifts above the threshold and an absolute gate deletes the model
// instead of its tail. (2026-07-24, CA…V TMA run: the pre-BA cleanup removed 1032
// of 1042 points; BA then fit the 10 survivors to 0.11px and every downstream
// number looked healthy while describing nothing.)
//
// The fix is to floor the threshold at a quantile of the CURRENT residuals, so a
// cleanup pass can never remove more than `maxRemovedFrac` of the observations it
// judges. On a healthy model the quantile sits below the absolute threshold and
// this is a no-op — the absolute figure still decides, exactly as before. On a
// systematically shifted model it degrades to "cull the worst fraction", leaving
// enough structure for BA and self-calibration to pull the intrinsics back.
//
// Pure: numbers in, numbers out.

export const CLEANUP_THRESHOLD_DEFAULTS = {
  // Pre-BA gross cleanup: explicitly only a tail-strip ahead of the first solve,
  // so it is held to a tenth of the observations.
  preBaMaxRemovedFrac: 0.10,
  // Post-BA track filter passes: these ARE the real filter and a hard block can
  // legitimately lose a lot, so the bound is loose — it exists solely to stop the
  // pass from annihilating the model, not to shape ordinary filtering.
  filterMaxRemovedFrac: 0.50,
}

// Resolve the reprojection threshold a cleanup pass should actually use.
//   residuals   current per-observation reprojection errors (px)
//   absolutePx  the pass's configured absolute threshold
// Returns { px, adaptive, quantilePx, absolutePx }: `px` is the threshold to
// apply, `adaptive` true when the quantile floor raised it (i.e. the absolute
// threshold would have exceeded the damage bound) — worth logging, since it is a
// strong signal that the intrinsics are wrong rather than the tracks bad.
export function adaptiveReprojThreshold(residuals, absolutePx, opts = {}) {
  const { maxRemovedFrac = CLEANUP_THRESHOLD_DEFAULTS.preBaMaxRemovedFrac } = opts
  const n = residuals.length
  if (n === 0) return { px: absolutePx, adaptive: false, quantilePx: null, absolutePx }

  // Value at the (1 − maxRemovedFrac) quantile: filtering at `> q` removes at most
  // that fraction. Clamped to [0,1] so a nonsense fraction can't invert the sense.
  const frac = Math.min(1, Math.max(0, maxRemovedFrac))
  const sorted = Float64Array.from(residuals).sort()
  const idx = Math.min(n - 1, Math.max(0, Math.round((1 - frac) * (n - 1))))
  const quantilePx = sorted[idx]

  if (!(quantilePx > absolutePx)) return { px: absolutePx, adaptive: false, quantilePx, absolutePx }
  return { px: quantilePx, adaptive: true, quantilePx, absolutePx }
}

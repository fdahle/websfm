// Detection-scale context — resolves a pixel threshold expressed in *detection*
// pixels into the *native* pixel frame every downstream stage actually works in.
//
// ── Why this exists ────────────────────────────────────────────────────────────
// `rasterize` (compute.worker.js) caps the detector input at `maxDim`, so a
// keypoint is localized at scale
//
//     s = min(1, maxDim / max(natW, natH))          (always ≤ 1 — never upscales)
//
// but `workers/ops/detect.js` maps it straight back to native coordinates
// (`x: dx / scale`) before anything else sees it. So every threshold downstream —
// the F-RANSAC inlier distance, the PnP/BA reprojection gates, the track filter —
// is expressed in *native* pixels, while the measurement that produced those
// coordinates has a quantum of 1/s native px.
//
// The two ends of our own benchmark range:
//
//   10137×9600 film scan, maxDim 2400 → s ≈ 0.237 → ~4.2 native px per detect px
//    2000×1500 phone photo, maxDim 2400 → s = 1     → 1.0 native px per detect px
//
// The default F-RANSAC gate is 2.0 native px. On the film scan that gate is
// *tighter than the noise floor of the data it judges* — RANSAC is asked to
// discriminate below the resolution at which the keypoints were measured. On the
// phone photo the identical constant is comfortably loose. One number, two
// opposite meanings, ~4× apart.
//
// The scale-invariant quantity is the threshold in *detection* pixels. That is
// what the UI numbers mean from here on; this module resolves them per run.
//
// ── Why this is safe to enable by default ──────────────────────────────────────
// s = 1 ⇒ factor 1 ⇒ every existing value resolves to itself. Any image set that
// was never downscaled for detection (the common case for hand-held photo sets,
// and for any set whose native size is already under `maxDim`) behaves bit-identically
// to before. The correction only engages where the old behaviour was wrong.
//
// Back-compat: `detectScale` is absent on projects that predate it, and absent ⇒ 1
// ⇒ no correction. An old project therefore reproduces its old numbers until the
// images are re-detected. Do NOT "heal" a missing detectScale by re-deriving it
// from meta dimensions and the current modal setting — the setting may have changed
// since detection, and a wrong factor is worse than no factor.
//
// Related but distinct: `core/sfm/cleanupThreshold.js` bounds the *damage* a
// cleanup pass may do when the residual distribution is shifted by wrong
// intrinsics. That is a different root cause (a bad focal) with a different fix (a
// quantile floor). This module fixes the case where the threshold itself is
// denominated in the wrong unit. They compose: the scaled threshold is what the
// quantile bound is applied to.
//
// Pure: numbers in, numbers out. No Vue / Pinia / OPFS / worker imports.

// Co-located defaults (the self-contained-pure-module exception in CLAUDE.md ▸
// Conventions — tuning.js points here rather than duplicating these).
export const SCALE_CONTEXT_DEFAULTS = {
  // Hard ceiling on the correction factor. A factor above this means detection
  // threw away so much resolution that the honest fix is to raise `maxDim`, not to
  // open the gates to ~10× their nominal width. Callers should log when it binds.
  maxFactor: 8,
  // Below this, treat the factor as 1 and skip the correction entirely. Avoids
  // logging a "correction" for a 1.02× rounding artefact.
  minFactor: 1.05,
}

// Read an image entry's detection scale. Accepts anything carrying `detectScale`
// (the store's image object, the worker's marshalled copy, a plain record).
// Anything missing, non-finite, ≤ 0 or > 1 ⇒ 1 (no correction). The > 1 rejection
// matters: `rasterize` clamps to 1, so a value above it is corrupt data, not an
// upscale, and honouring it would *tighten* every gate.
export function detectScaleOf(entry) {
  const s = entry?.detectScale
  return Number.isFinite(s) && s > 0 && s <= 1 ? s : 1
}

// Median of a numeric array (upper median for even counts — matches numStats
// elsewhere in core). Empty ⇒ null.
function median(values) {
  if (values.length === 0) return null
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.round(0.5 * (sorted.length - 1)))]
}

// Build the run-wide context from the image entries participating in a stage.
//
// The *median* scale is the representative one: a mixed set (a few full-res images
// among many downscaled ones) should be judged by its bulk, and the median is what
// resists a handful of odd entries. `minScale`/`maxScale` are carried so a caller
// can warn about a genuinely heterogeneous set, where no single factor is right.
//
// Returns { n, medianScale, minScale, maxScale, factor, rawFactor, clamped, mixed }.
export function buildScaleContext(entries, opts = {}) {
  const {
    maxFactor = SCALE_CONTEXT_DEFAULTS.maxFactor,
    minFactor = SCALE_CONTEXT_DEFAULTS.minFactor,
  } = opts

  const scales = (entries ?? []).map(detectScaleOf)
  if (scales.length === 0) {
    return { n: 0, medianScale: 1, minScale: 1, maxScale: 1, factor: 1, rawFactor: 1, clamped: false, mixed: false }
  }

  const medianScale = median(scales)
  let minScale = scales[0], maxScale = scales[0]
  for (const s of scales) { if (s < minScale) minScale = s; if (s > maxScale) maxScale = s }

  const rawFactor = 1 / medianScale
  const clamped = rawFactor > maxFactor
  const factor = rawFactor < minFactor ? 1 : Math.min(rawFactor, maxFactor)

  // "Mixed" = the extremes disagree by more than the engage threshold, i.e. one
  // factor cannot be right for every image in the set.
  const mixed = maxScale / minScale > minFactor

  return { n: scales.length, medianScale, minScale, maxScale, factor, rawFactor, clamped, mixed }
}

// Two-image context for a pairwise stage (matching). Uses the *coarser* of the two
// scales, not their mean: an epipolar residual is measured in both images, so the
// localization noise is set by the worse one. Erring toward the looser gate is the
// correct direction here — this module exists to stop a gate sitting below the
// noise floor, and a mean would leave it there whenever one image is sharp.
export function pairScaleContext(a, b, opts = {}) {
  const sa = detectScaleOf(a), sb = detectScaleOf(b)
  return buildScaleContext([{ detectScale: Math.min(sa, sb) }], opts)
}

// Resolve a threshold. `px` is in detection pixels; the result is native pixels.
// Non-finite / non-positive input passes through untouched so a caller that means
// "no gate" (0, Infinity) keeps meaning it.
export function resolveScaledPx(px, ctx) {
  if (!Number.isFinite(px) || px <= 0) return px
  const factor = Number.isFinite(ctx?.factor) && ctx.factor >= 1 ? ctx.factor : 1
  return px * factor
}

// One-line audit string for `onLog`. Every derived value gets a log line the user
// can check (CLAUDE.md ▸ Conventions), and this one has to make the *inputs*
// visible: the factor alone is not auditable, the median scale behind it is.
export function describeScaleContext(ctx, label = 'thresholds') {
  if (!ctx || ctx.n === 0) return `${label}: no detection scale available — using values as given`

  const n = `${ctx.n} image${ctx.n === 1 ? '' : 's'}`
  const parts = [ctx.factor === 1
    ? `${label}: unscaled — detection scale ${ctx.medianScale.toFixed(3)} (${n})`
    : `${label}: ×${ctx.factor.toFixed(2)} for detection scale ${ctx.medianScale.toFixed(3)} (${n})`]

  // Both caveats must be reported independently of whether the factor engaged. A
  // set half at full resolution and half heavily downscaled has a median scale of
  // 1 and therefore NO correction — which is exactly the case where the user most
  // needs to be told, and the case a "factor === 1 ⇒ nothing to say" early return
  // would have silently swallowed.
  if (ctx.clamped) {
    parts.push(`— CLAMPED from ×${ctx.rawFactor.toFixed(2)}; detection discarded so much `
      + `resolution that the gate cannot follow it — raise the detection resolution instead`)
  }
  if (ctx.mixed) {
    parts.push(`— mixed detection scales ${ctx.minScale.toFixed(3)}…${ctx.maxScale.toFixed(3)}; `
      + `one run-wide factor cannot suit every image (matching scales per pair, `
      + `but the SfM gates are model-wide)`)
  }
  return parts.join(' ')
}

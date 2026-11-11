// Detection working resolution — resolving `maxDim` against the actual image size.
//
// ── The problem with an absolute cap ──────────────────────────────────────────
// `maxDim` is a single pixel figure applied to every image, but the sets this app
// targets span an order of magnitude in native size:
//
//   10137×9600 aerial film scan   at maxDim 2400 → 5.6% of the pixels survive
//    6000×4000 DSLR frame         at maxDim 2400 → 24%
//    2000×1500 phone photo        at maxDim 2400 → 100% (no downscale at all)
//
// One number cannot be right across that range. Raising it helps the scan and
// wastes time on the phone photo; lowering it does the reverse. The 2026-07-24
// bump from 1200 → 2400 was a stopgap that moved the compromise without removing
// it — a film scan still discards ~94% of its pixels.
//
// ── The rule ──────────────────────────────────────────────────────────────────
// Take a *fraction* of the native long side, then clamp it into a band:
//
//   effective = clamp(round(fraction × max(natW, natH)), floorPx, ceilPx)
//
// **The floor is that preset's old absolute value.** That single choice is what
// makes the rule safe: the resolved resolution is then never *lower* than what the
// absolute cap would have given, for any image size. Auto only ever hands more
// resolution to large images — it cannot quietly downgrade a set. (An earlier draft
// used a floor below the absolute default and silently detected a 2000 px image at
// 1600 px instead of its full 2000; the monotonicity test caught it.)
//
// The ceiling is the compute budget — detection cost is ~quadratic in the working
// edge, and the keypoint cap costs again, quadratically, at the *next* stage
// (brute-force matching is O(Na·Nb)). Between floor and ceiling the fraction gives
// big images proportionally more resolution without letting them run unbounded.
//
// With the shipped SIFT medium band (0.4 / 2400 / 4000):
//
//   10137 px scan  → 4055 → capped at 4000    (was 2400 — +67% linear resolution)
//    8000 px scan  → 3200                     (was 2400)
//    6000 px DSLR  → 2400                     (unchanged — the band is centred here)
//    2000 px phone → 800 → floored to 2400 → capped at native 2000  (full, as before)
//
// ── Where it is the default ───────────────────────────────────────────────────
// SIFT's default rule is 'scene', By project type (effectiveDimMode below): this rule
// in an object project, where the close-range band holds, and the fixed size
// elsewhere. Aerial blocks are mixed: film scans gain from more resolution (Iceland
// 1980 checkpoints 1.97/2.46 → 1.45/1.96 m), a 42 MP drone block loses height
// (UseGeo 1 cameras V 6.1 → 9.6 cm), both at 2.5–4× the time, so they keep the fixed
// size and Scale with image size stays a choice. Learned detectors default to fixed.
// It is safe to adopt later precisely because core/scaleContext.js is already in:
// the reprojection and RANSAC gates are denominated in detection pixels and follow
// whatever resolution detection actually used, so changing that resolution does
// not silently re-tighten every downstream threshold.
//
// Pure: numbers in, numbers out. No Vue / Pinia / OPFS / worker imports.

// Co-located defaults (the self-contained-pure-module exception in CLAUDE.md ▸
// Conventions). Bands are per detection preset, since the compute ceiling is the
// thing a preset is really choosing.
// INVARIANT: each `floorPx` equals that preset's absolute `maxDim` in
// defaults.user.js (DETECT_SIFT_DEFAULTS / _PRESETS and the SuperPoint, DISK and ALIKED pairs).
// That is what guarantees auto ≥ absolute at every image size; a test pins it.
export const DETECT_RESOLUTION_BANDS = {
  // SIFT: the ceiling is set by matching cost at the next stage, not detection.
  sift: {
    low: { fraction: 0.25, floorPx: 1400, ceilPx: 2000 },
    medium: { fraction: 0.4, floorPx: 2400, ceilPx: 4000 },
    high: { fraction: 0.65, floorPx: 4000, ceilPx: 6000 },
  },
  // SuperPoint: far tighter. LightGlue's attention is O(N²) in keypoints and ORT's
  // int32 shape math overflows past ~16 MP in a single untiled pass
  // (DETECT_TUNING.spMaxUntiledInputPx), so the ceiling is a hard constraint rather
  // than a speed dial — it deliberately stays below the untiled-overflow size.
  superpoint: {
    low: { fraction: 0.2, floorPx: 1200, ceilPx: 1600 },
    medium: { fraction: 0.3, floorPx: 1600, ceilPx: 2400 },
    high: { fraction: 0.45, floorPx: 2400, ceilPx: 3600 },
  },
  // DISK: tighter still — 128 full-resolution channels make memory, not the
  // keypoint budget, the binding limit (DETECT_TUNING.diskMaxUntiledInputPx).
  disk: {
    low: { fraction: 0.1, floorPx: 768, ceilPx: 1024 },
    medium: { fraction: 0.15, floorPx: 1024, ceilPx: 1600 },
    high: { fraction: 0.25, floorPx: 1600, ceilPx: 2000 },
  },
  // ALIKED: DISK's memory profile (DETECT_TUNING.alikedMaxUntiledInputPx), DISK's bands.
  aliked: {
    low: { fraction: 0.1, floorPx: 768, ceilPx: 1024 },
    medium: { fraction: 0.15, floorPx: 1024, ceilPx: 1600 },
    high: { fraction: 0.25, floorPx: 1600, ceilPx: 2000 },
  },
}

// Close-range photos (an object project: a building, a room, an object at a few metres)
// fill the frame with fine texture, and a 6,000 px photo detected at 2,400 px loses the
// keypoints a low-texture interior needs to register. ETH3D's 6,048 px photos at the
// medium band's 2,400 px: office 20 of 26 cameras, pipes 8 of 14; at 4,000 px every
// camera of all six scenes, at the same or better pose accuracy (pipes median 3.9 →
// 1.6 mm). South Building's 3,072 px photos gain nothing from more, so the rule is a
// fraction (0.66 × 6,048 ≈ 4,000; 0.66 × 3,072 → the 2,400 floor). The keypoint cap
// stays as configured: scaling it with the area (28 k at 4,000 px) changed the pose
// error by noise and took 2–4× the matching time (courtyard 93 → 352 s on the CPU).
// Aerial photos keep the general band: a nadir block gained nothing from 4,000 px
// (GeoScan PUTI, 2026-11-10). The measurements are in the CHANGELOG entry.
// Only the medium preset has a close-range band; the others use the general ones.
export const DETECT_CLOSE_RANGE_BANDS = {
  sift: {
    medium: { fraction: 0.66, floorPx: 2400, ceilPx: 4000, scaleKeypoints: false },
  },
}

// The rule a setting resolves to: 'auto' (Scale with image size) or 'absolute' (Fixed
// for all images). 'scene' (By project type, SIFT's default) is 'auto' where the
// project has a close-range band (an object project at the medium preset), else
// 'absolute'.
export function effectiveDimMode(settings = {}) {
  const mode = settings.maxDimMode ?? 'absolute'
  if (mode !== 'scene') return mode
  return detectBand(settings).closeRange ? 'auto' : 'absolute'
}

// The band auto mode applies: the close-range one for an object project where there is
// one, else the preset's general band.
export function detectBand({ detector = 'sift', preset = 'medium', sceneType = null } = {}) {
  const close = sceneType === 'object' ? DETECT_CLOSE_RANGE_BANDS[detector]?.[preset] : null
  if (close) return { ...close, closeRange: true }
  const bands = DETECT_RESOLUTION_BANDS[detector] ?? DETECT_RESOLUTION_BANDS.sift
  return { ...(bands[preset] ?? bands.medium), closeRange: false }
}

// Resolve the working resolution for one image.
//
//   nativeMax   the image's long side in px (0/unknown ⇒ fall back to absolute)
//   settings    { maxDim, maxDimMode, detector, preset, sceneType }
//
// Returns { maxDim, mode, band, nativeMax, reason } — `reason` is a short audit
// string for the log, since a silently-derived resolution is exactly the kind of
// value CLAUDE.md ▸ Conventions requires be auditable.
export function resolveDetectMaxDim(nativeMax, settings = {}) {
  const { maxDim = 2400 } = settings
  const byScene = settings.maxDimMode === 'scene'

  if (effectiveDimMode(settings) !== 'auto') {
    return {
      maxDim,
      mode: 'absolute',
      band: null,
      nativeMax,
      reason: `fixed ${maxDim}px` + (byScene ? ' (by project type)' : ''),
    }
  }
  // Without a native size there is nothing to take a fraction OF. Falling back to
  // the absolute value is the only honest option — guessing from a stale meta or a
  // previous image would produce a resolution the log could not justify.
  if (!Number.isFinite(nativeMax) || nativeMax <= 0) {
    return { maxDim, mode: 'absolute', band: null, nativeMax, reason: `fixed ${maxDim}px (native size unknown)` }
  }

  const band = detectBand(settings)
  const raw = Math.round(band.fraction * nativeMax)
  const clampedLow = raw < band.floorPx
  const clampedHigh = raw > band.ceilPx
  const resolved = Math.min(band.ceilPx, Math.max(band.floorPx, raw))

  // Never upscale: a maxDim above the native size just pads the raster.
  const maxDimOut = Math.min(resolved, nativeMax)

  const reason =
    (maxDimOut >= nativeMax
      ? `${maxDimOut}px = full native resolution`
      : `${maxDimOut}px = ${(band.fraction * 100).toFixed(0)}% of ${nativeMax}px` +
        (clampedLow ? ` (raised to the ${band.floorPx}px floor)` : '') +
        (clampedHigh ? ` (capped at the ${band.ceilPx}px ceiling)` : '')) +
    (band.closeRange ? ', close-range band' : '') +
    (byScene ? ' (by project type)' : '')

  return { maxDim: maxDimOut, mode: 'auto', band, nativeMax, reason }
}

// ── Keypoint budget in auto mode ──────────────────────────────────────────────
// Auto hands a large image more resolution, but a fixed `maxKeypoints` then keeps
// the same number of features spread over more pixels: on film scans and satellite
// frames detected at 3–4 k px the 10 k cap bound on every image (Casa Grande 1978,
// Iceland 1980, the synthetic KH-9 blocks), while a 6000 × 4000 photo at 2400 px
// sits right at it. So in auto mode the SIFT cap scales with the detected AREA:
//
//   effective = clamp(round(maxKeypoints × detectPx / refPx), maxKeypoints, maxFactor × maxKeypoints)
//
// refPx is a 3 : 2 frame at the medium band's floor (2400 × 1600), where the default
// cap was tuned; the floor is the configured cap (auto never takes keypoints away,
// as it never takes resolution away), the ceiling bounds the matching cost
// (brute-force O(Na·Nb)): 4 × 10 k = Metashape's default 40 k. Learned detectors keep
// their cap — LightGlue's attention is O(N²) and its budget is a hard limit.
export const DETECT_KEYPOINT_SCALING = {
  sift: { refPx: 2400 * 1600, maxFactor: 4 },
}

// The working size of an image whose long side is brought to ≤ maxDim.
export function detectSize(natW, natH, maxDim) {
  const s = Math.min(1, maxDim / Math.max(natW, natH))
  return { width: Math.round(natW * s), height: Math.round(natH * s) }
}

// Resolve the keypoint cap for one image. `size` is the detection working size;
// settings as resolveDetectMaxDim. Returns { maxKeypoints, factor, reason }.
export function resolveDetectKeypoints(size, settings = {}) {
  const { maxKeypoints = 10000, detector = 'sift' } = settings
  const rule = DETECT_KEYPOINT_SCALING[detector]
  const px = (size?.width || 0) * (size?.height || 0)
  if (effectiveDimMode(settings) !== 'auto' || !rule || !(px > 0)) {
    return { maxKeypoints, factor: 1, reason: `fixed ${maxKeypoints}` }
  }
  if (detectBand(settings).scaleKeypoints === false) {
    return { maxKeypoints, factor: 1, reason: `${maxKeypoints} (configured cap; close-range band)` }
  }
  const factor = Math.min(rule.maxFactor, Math.max(1, px / rule.refPx))
  const out = Math.round(maxKeypoints * factor)
  return {
    maxKeypoints: out,
    factor,
    reason:
      factor <= 1
        ? `${out} (configured cap; ${(px / 1e6).toFixed(1)} MP detected)`
        : `${out} = ${factor.toFixed(2)}× ${maxKeypoints} for ${(px / 1e6).toFixed(1)} MP detected` +
          (factor >= rule.maxFactor ? ` (capped at ${rule.maxFactor}×)` : ''),
  }
}

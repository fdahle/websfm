// Recommended settings (usability track U2).
//
// Turn a `DatasetProfile` (core/profile.js, U1) into derived pipeline settings —
// the "autos are good, experts keep every knob" model (see TODO ▸ U). Each derived
// knob is a `{ value, reason }` pair: U3 diffs these against `defaults.user.js` and
// shows a "recommended for this dataset" banner where they differ, with `reason` on
// hover. This is a PREFILL, never a hidden override — the user can always ignore it.
//
// Return shape mirrors `defaults.user.js` (detect / match / sfm / depthmap / fuse),
// but carries ONLY the knobs we can meaningfully derive from metadata; every knob
// not listed keeps its static default. Pure: plain data in, plain data out.
//
// A note on `detect`: `maxDim`/`tiling`/`tileSize` are shared by both detectors, but
// `maxKeypoints` is expressed in **SIFT** units (the default front end). SuperPoint's
// LightGlue attention is O(N²) and wants its own tight cap (~2048), so a consumer on
// the SuperPoint path should not apply `detect.maxKeypoints` verbatim — the reason
// string says so.

/** @typedef {import('./types').DatasetProfile} DatasetProfile */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const rec = (value, reason) => ({ value, reason })

// Matching can safely select proximity by default only when at least two loaded
// images have usable camera positions. Kept pure so the modal's automatic initial
// state and its availability gate share a directly testable rule.
export function initialMatchStrategy(positionCount) {
  return Number(positionCount) >= 2 ? 'preselect' : 'exhaustive'
}

// ── detect ──────────────────────────────────────────────────────────────────
function recommendDetect(p) {
  const out = {}

  if (p.maxDim != null) {
    // Detection at ~half the native long edge is the usual quality/speed sweet
    // spot; the clamp keeps a phone photo from running too small and a film scan
    // from running absurdly large (tiling handles the rest of the scan case).
    const v = clamp(Math.round(0.5 * p.maxDim), 1200, 3200)
    out.maxDim = rec(v, `Half of the native ${p.maxDim} px long edge, clamped to [1200, 3200].`)
  }

  // SIFT keypoint budget scales inversely with set size: a few images need every
  // tie point; hundreds pay O(N²) matching, so keep the per-image cap modest.
  const kp = { small: 8000, medium: 5000, large: 4000 }[p.scale]
  out.maxKeypoints = rec(kp, `${p.nImages} image(s) (${p.scale} set) — SIFT budget; SuperPoint and DISK keep their own ~2048 cap.`)

  // Very large scans (film) tile so a single detector pass isn't downscaled to
  // nothing — maxDim already clamped to 3200, so an 11 000 px scan would lose
  // detail without tiling.
  if (p.maxDim != null && p.maxDim > 6000) {
    out.tiling = rec('auto', `Native long edge ${p.maxDim} px > 6000 — automatic tiled detection preserves fine keypoints a single downscaled pass would miss.`)
    out.tileSize = rec(1536, 'Larger tiles than the 1024 default for a high-resolution scan.')
  }

  return out
}

// ── match ───────────────────────────────────────────────────────────────────
function recommendMatch(p) {
  const out = {}

  // Strategy (a top-level match-stage choice the modal emits: exhaustive |
  // sequential | preselect). Priors → prune pairs before the O(N²) match.
  if (p.hasPoses) {
    out.strategy = rec('preselect', 'Camera positions present — preselect by proximity instead of matching all pairs.')
    out.preselectMethod = rec('position', 'Nearest-camera preselection from the available positions.')
  } else if (p.sequentialNames && p.scale === 'large') {
    // Contiguous filenames alone don't prove a strip — cameras number files
    // sequentially for any shoot — so sequential matching is only recommended
    // when the set is large enough that exhaustive is prohibitively expensive and
    // the naming at least gives an ordering to exploit. Enable loop closure by
    // hand if the sequence actually loops back.
    out.strategy = rec('sequential', 'Large set with sequential filenames — match capture-order neighbours to avoid the O(N²) exhaustive cost; enable loop closure if the sequence returns to its start.')
  } else {
    out.strategy = rec('exhaustive', 'No motion priors — match all pairs so no loop closure is missed (the subset gate still skips non-overlapping pairs cheaply).')
  }

  return out
}

// ── sfm ─────────────────────────────────────────────────────────────────────
function recommendSfm(p) {
  // `refineIntrinsics: 'auto'` (the default) already resolves correctly in
  // core/sfm/sfm.js — 'f,k1' for EXIF-only/film, 'none' when a calibrated Brown
  // model exists. So there is nothing to override; the reason just makes the
  // auto-behaviour auditable in the banner. Value equals the default, so U3's
  // diff hides it unless the user has changed it away from 'auto'.
  return {
    refineIntrinsics: rec('auto', p.hasCalibratedDistortion
      ? 'A sensor carries calibrated distortion — self-cal stays off ("none") to avoid double-correcting.'
      : 'No calibrated distortion — self-cal solves one shared focal + k1 during BA.'),
  }
}

// ── depthmap (dense Stage A) ──────────────────────────────────────────────────
function recommendDepthmap(p, budget) {
  const out = {}
  const memGB = budget && Number.isFinite(budget.deviceMemoryGB) ? budget.deviceMemoryGB : null

  let quality = 'medium'
  let reason = 'Balanced ¼-native default.'
  if (memGB != null && memGB < 4) {
    quality = 'low'
    reason = `Low device memory (~${memGB} GB) — ⅛-native depth maps to stay within budget.`
  } else if (p.scale === 'large') {
    quality = 'low'
    reason = `Large set (${p.nImages} images) — ⅛-native keeps Stage A tractable; raise it for a subset.`
  } else if (memGB != null && memGB >= 8 && p.scale === 'small') {
    quality = 'high'
    reason = `Small set with ample memory (~${memGB} GB) — ½-native depth maps for a denser cloud.`
  }
  out.quality = rec(quality, reason)
  return out
}

// ── fuse (dense Stage B) ──────────────────────────────────────────────────────
function recommendFuse() {
  // Fusion runs in `auto` mode by default (derives minViews/maxCost from the
  // data), and the geometric-outlier gates are dataset-independent. There is
  // nothing to derive from metadata alone here.
  return {}
}

/**
 * Derive recommended settings from a dataset profile.
 *
 * @param {DatasetProfile} profile  from `profileDataset` (U1).
 * @param {{ deviceMemoryGB?: number, source?: string } | null} [budget]  optional
 *   hardware budget (C1). When absent, dense quality falls back to a size-based pick.
 * @returns {{ detect: object, match: object, sfm: object, depthmap: object, fuse: object }}
 *   Each stage is a map of knob → `{ value, reason }`; only derived knobs appear.
 */
export function recommendSettings(profile, budget = null) {
  if (!profile) return { detect: {}, match: {}, sfm: {}, depthmap: {}, fuse: {} }
  return {
    detect: recommendDetect(profile),
    match: recommendMatch(profile),
    sfm: recommendSfm(profile),
    depthmap: recommendDepthmap(profile, budget),
    fuse: recommendFuse(),
  }
}

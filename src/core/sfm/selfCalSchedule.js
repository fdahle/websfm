// Staged self-calibration schedule (WS2). Which shared intrinsic terms bundle
// adjustment is allowed to refine depends on how well the model constrains them:
// distortion is barely observable on a thin 2–3 view model, and higher-order radial
// terms (k2, k3) or a floating principal point overfit to a small/noisy set. So the
// terms are unlocked as the model grows.
//
// This is the schedule for the `auto` self-cal mode only. During incremental
// registration the interim/rescue BA stays at the base 'f,k1' (distortion just barely
// identifiable once a few cameras are in — see register.js distortionCalMinCams); the
// *post-filter* passes escalate via `stagedSelfCalTerms` below as the camera and
// observation counts clear each gate. An explicit user refine string (anything other
// than 'auto') bypasses staging entirely and is used verbatim.
//
// Co-located defaults (tuning.js points here rather than duplicating them): the gates
// are deliberately conservative — a term that overfits corrupts the whole calibration.

export const SELF_CAL_STAGE_DEFAULTS = {
  k2MinCams: 8,   k2MinObs: 10_000,   // add k2 once the model is well populated
  cxcyMinCams: 10,                    // add principal point once many cameras constrain it
  k3MinCams: 20,  k3MinObs: 30_000,   // add k3 only on a large, well-observed model
  // k4 exists only on a four-term (Kannala–Brandt, OPENCV_FISHEYE) lens. It is the θ⁸
  // term: at 75° (θ = 1.31) θ⁸ ≈ 8.7 against θ⁶ ≈ 5.0, so on its own it trades
  // almost one for one with k3. It is added only on a pass AFTER one that already
  // refined k3 (k1–k3 have settled; k4 then fits what they leave), and at the k3 gates.
  k4MinCams: 20,  k4MinObs: 30_000,
}

// The base terms solved during registration (interim / rescue BA) and the floor the
// post-filter staging escalates from.
export const SELF_CAL_BASE_TERMS = 'f,k1'

// Resolve the refine-terms string for a post-filter BA pass under the `auto` schedule.
// Order is fixed (f, cxcy, k1, k2, k3, k4) but the crate's bitmask parser is order-free.
//   lensTerms  — the most self-calibratable k terms any camera's lens has (4 for a
//                four-term fisheye; 0 for the pinhole + Brown residual, which has no k4)
//   k3Settled  — an earlier pass of this run already refined k3
export function stagedSelfCalTerms({ nCams, nObs, lensTerms = 0, k3Settled = false }, cfg = SELF_CAL_STAGE_DEFAULTS) {
  const c = { ...SELF_CAL_STAGE_DEFAULTS, ...cfg }
  const terms = ['f']
  if (nCams >= c.cxcyMinCams) terms.push('cxcy')
  terms.push('k1')
  if (nCams >= c.k2MinCams && nObs >= c.k2MinObs) terms.push('k2')
  const k3 = nCams >= c.k3MinCams && nObs >= c.k3MinObs
  if (k3) terms.push('k3')
  if (k4Applies(lensTerms) && k3 && k3Settled && nCams >= c.k4MinCams && nObs >= c.k4MinObs) terms.push('k4')
  return terms.join(',')
}

const k4Applies = (lensTerms) => lensTerms >= 4

// ── Distortion identifiability ──────────────────────────────────────────────
// Camera count is a proxy, not the condition. What actually separates a radial
// coefficient from point depth is seeing the SAME 3D point from several viewpoints
// at different image radii: a 2-view track can absorb any radial shift into its
// depth and still fit perfectly, so a model built from 2-view tracks lets BA
// "converge" on whatever the noise prefers no matter how many cameras it has.
//
// Observed 2026-07-24 (CA…V, 5 cameras — well clear of the old `nCams < 3` floor):
// 715 ×2-view, 83 ×3-view, 0 ×4+-view tracks, and k1 flipped sign between the two
// post-filter passes (+0.02574 → −0.02048), each fold physically moving the
// keypoints ~20px. A fold is destructive, so refusing to fit noise beats folding it.
export const DISTORTION_IDENT_DEFAULTS = {
  minCams: 3,                 // below this nothing is identifiable (incl. focal)
  minMultiViewFrac: 0.15,     // ≥3-view tracks as a share of all tracks…
  minMultiViewTracks: 200,    // …or enough of them outright, on a big sparse model
}

// Can this model's geometry identify radial distortion?
//   { nCams, nTracks, nMultiViewTracks }  — multi-view = tracks with ≥3 views
// Returns { ok, scope, reason }: scope 'all' ⇒ refine nothing (too few cameras to
// identify even focal), 'distortion' ⇒ drop the radial terms but keep refining f
// (and cx,cy), which stay observable from camera geometry alone. The fraction and
// the absolute count are OR'd: a large model with a low multi-view *share* still
// carries plenty of constraining tracks in absolute terms.
export function distortionIdentifiable({ nCams, nTracks, nMultiViewTracks }, cfg = DISTORTION_IDENT_DEFAULTS) {
  const c = { ...DISTORTION_IDENT_DEFAULTS, ...cfg }
  if (nCams < c.minCams) {
    return { ok: false, scope: 'all',
      reason: `${nCams} camera(s) cannot identify intrinsics (a 2-view model hides distortion in its points)` }
  }
  const frac = nTracks > 0 ? nMultiViewTracks / nTracks : 0
  if (frac >= c.minMultiViewFrac || nMultiViewTracks >= c.minMultiViewTracks) return { ok: true, scope: null, reason: null }
  return { ok: false, scope: 'distortion',
    reason: `only ${nMultiViewTracks}/${nTracks} tracks (${(100 * frac).toFixed(1)}%) span ≥3 views `
      + `— a 2-view track absorbs any radial coefficient into its depth, so k1 would fit noise `
      + `(needs ≥${(100 * c.minMultiViewFrac).toFixed(0)}% or ≥${c.minMultiViewTracks} such tracks)` }
}

// Drop the radial terms from a refine string, keeping f / cx,cy. Returns 'none' if
// nothing identifiable is left.
export function withoutDistortionTerms(refineMode) {
  const kept = String(refineMode).split(',').map((s) => s.trim())
    .filter((t) => t && !/^k[1-4]$/.test(t))
  return kept.length ? kept.join(',') : 'none'
}

// Human-readable note on which terms are deferred and why, for the run log.
export function stagedSelfCalDeferred({ nCams, nObs, lensTerms = 0, k3Settled = false }, cfg = SELF_CAL_STAGE_DEFAULTS) {
  const c = { ...SELF_CAL_STAGE_DEFAULTS, ...cfg }
  const out = []
  if (nCams < c.cxcyMinCams) out.push(`cx,cy (needs ≥${c.cxcyMinCams} cams, have ${nCams})`)
  if (!(nCams >= c.k2MinCams && nObs >= c.k2MinObs))
    out.push(`k2 (needs ≥${c.k2MinCams} cams & ≥${c.k2MinObs} obs, have ${nCams}/${nObs})`)
  const k3 = nCams >= c.k3MinCams && nObs >= c.k3MinObs
  if (!k3) out.push(`k3 (needs ≥${c.k3MinCams} cams & ≥${c.k3MinObs} obs, have ${nCams}/${nObs})`)
  if (k4Applies(lensTerms)) {
    if (!(nCams >= c.k4MinCams && nObs >= c.k4MinObs))
      out.push(`k4 (needs ≥${c.k4MinCams} cams & ≥${c.k4MinObs} obs, have ${nCams}/${nObs})`)
    else if (!(k3 && k3Settled)) out.push('k4 (waits for a pass that has refined k3)')
  }
  return out
}

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
}

// The base terms solved during registration (interim / rescue BA) and the floor the
// post-filter staging escalates from.
export const SELF_CAL_BASE_TERMS = 'f,k1'

// Resolve the refine-terms string for a post-filter BA pass under the `auto` schedule.
// Order is fixed (f, cxcy, k1, k2, k3) but the crate's bitmask parser is order-free.
export function stagedSelfCalTerms({ nCams, nObs }, cfg = SELF_CAL_STAGE_DEFAULTS) {
  const c = { ...SELF_CAL_STAGE_DEFAULTS, ...cfg }
  const terms = ['f']
  if (nCams >= c.cxcyMinCams) terms.push('cxcy')
  terms.push('k1')
  if (nCams >= c.k2MinCams && nObs >= c.k2MinObs) terms.push('k2')
  if (nCams >= c.k3MinCams && nObs >= c.k3MinObs) terms.push('k3')
  return terms.join(',')
}

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
    .filter((t) => t && !/^k[123]$/.test(t))
  return kept.length ? kept.join(',') : 'none'
}

// Human-readable note on which terms are deferred and why, for the run log.
export function stagedSelfCalDeferred({ nCams, nObs }, cfg = SELF_CAL_STAGE_DEFAULTS) {
  const c = { ...SELF_CAL_STAGE_DEFAULTS, ...cfg }
  const out = []
  if (nCams < c.cxcyMinCams) out.push(`cx,cy (needs ≥${c.cxcyMinCams} cams, have ${nCams})`)
  if (!(nCams >= c.k2MinCams && nObs >= c.k2MinObs))
    out.push(`k2 (needs ≥${c.k2MinCams} cams & ≥${c.k2MinObs} obs, have ${nCams}/${nObs})`)
  if (!(nCams >= c.k3MinCams && nObs >= c.k3MinObs))
    out.push(`k3 (needs ≥${c.k3MinCams} cams & ≥${c.k3MinObs} obs, have ${nCams}/${nObs})`)
  return out
}

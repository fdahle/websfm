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

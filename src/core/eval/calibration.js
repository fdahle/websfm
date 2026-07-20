// Pure calibration-check math for Evaluate ▸ Calibration (PLAN-eval-views step 4).

// Radial distortion displacement curve Δr(r) for a Brown k-bag, sampled n+1 points
// over [0, rMax]. The radial model scales a point at normalized radius r by
// (1 + k1 r² + k2 r⁴ + k3 r⁶), so the displacement is Δr = r·(k1 r² + k2 r⁴ + k3 r⁶).
// `r` is in whatever units the k-bag was fit in (normalized image radius for the
// composed self-cal bag); the caller plots the shape, not absolute units.
export function radialCurve({ k1 = 0, k2 = 0, k3 = 0 } = {}, rMax = 1, n = 32) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const r = (rMax * i) / n
    const r2 = r * r
    const dr = r * (k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2)
    out.push({ r, dr })
  }
  return out
}

// Refined vs nominal focal length. deltaPct is relative to the nominal; null-safe.
export function focalDelta(refinedFx, nominalFx) {
  if (refinedFx == null || nominalFx == null) return { deltaPx: null, deltaPct: null }
  const deltaPx = refinedFx - nominalFx
  const deltaPct = nominalFx !== 0 ? (deltaPx / nominalFx) * 100 : null
  return { deltaPx, deltaPct }
}

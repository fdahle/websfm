// Pre-commit plausibility guard for bundle-adjustment self-calibration.
//
// BA cost alone is not a sufficient acceptance test for intrinsics: on a thin block,
// points can absorb a bad focal/distortion solution while reprojection RMS falls. The
// sparse pipeline folds accepted distortion into every keypoint, so validation must run
// before cameras, points, Kmap, or keypoints are mutated.

const finite = (v) => Number.isFinite(v)

export const SELF_CAL_GUARD_DEFAULTS = {
  maxFocalStepFrac: 0.25,       // one BA pass may not move focal by more than 25%
  maxFocalNominalFrac: 0.35,    // nor end >35% from the ingest/EXIF focal
  maxPrincipalOffsetFrac: 0.10, // principal point must remain within 10% of image size of centre
  maxCornerShiftFrac: 0.25,     // radial displacement at a corner, relative to image diagonal
  // When the starting focal is resolveK's default-FOV guess (fx = max(w,h): no EXIF focal,
  // no sensor format), that "nominal" is not evidence. A 153 mm lens on a 230 mm film
  // frame sits 33% below it, an 88 mm super-wide 62%. The 25% / 35% bounds above rejected
  // the focal pre-solve that exists for exactly this case (CA213732V strip: a 29.9% step,
  // fx stuck at the guess; VERIFICATION SFM-12). A guessed focal gets these instead,
  // i.e. fx may end anywhere in [0.3, 1.7] × the guess.
  maxGuessFocalStepFrac: 0.6,
  maxGuessFocalNominalFrac: 0.7,
}

function radialScale(k, r2) {
  return 1 + (k.k1 || 0) * r2 + (k.k2 || 0) * r2 * r2 + (k.k3 || 0) * r2 * r2 * r2
}

// The fold maps OBSERVED (distorted) keypoints to ideal ones, so the forward curve
// f(r) = r·s(r²) must rise monotonically until it reaches the observed corner
// radius — otherwise no inverse exists there and the fold moves corner keypoints to
// garbage. Evaluating s at the corner as if it were an IDEAL radius (the check
// below) misses this: it accepted k1 down to ≈ −0.7 at a 4000×3000 / f=3000
// corner, where an inverse stops existing near k1 ≈ −0.21.
function invertibleTo(k, rObs) {
  const k1 = k.k1 || 0, k2 = k.k2 || 0, k3 = k.k3 || 0
  const steps = 512, rMax = 4 * rObs
  for (let i = 1; i <= steps; i++) {
    const r = (i / steps) * rMax, r2 = r * r
    if (!(1 + r2 * (3 * k1 + r2 * (5 * k2 + r2 * 7 * k3)) > 0)) return false // f'(r) ≤ 0: the curve folds
    if (r * radialScale(k, r2) >= rObs) return true
  }
  return false
}

/**
 * Validate one proposed shared-intrinsics update.
 * Returns a stable plain diagnostic suitable for the run summary.
 */
export function validateSelfCalUpdate({ before, proposed, nominalFx, width, height, focalIsGuess = false }, opts = {}) {
  const c = { ...SELF_CAL_GUARD_DEFAULTS, ...opts }
  const maxStep = focalIsGuess ? c.maxGuessFocalStepFrac : c.maxFocalStepFrac
  const maxNominal = focalIsGuess ? c.maxGuessFocalNominalFrac : c.maxFocalNominalFrac
  const nominalName = focalIsGuess ? 'the default-FOV guess' : 'nominal'
  const fail = (reason, code) => ({ ok: false, code, reason })
  if (!before || !proposed || !finite(proposed.fx) || !finite(proposed.fy)
      || proposed.fx <= 0 || proposed.fy <= 0) {
    return fail('self-calibration returned non-finite or non-positive focal values', 'invalid-focal')
  }

  const stepFrac = before.fx > 0 ? Math.abs(proposed.fx - before.fx) / before.fx : 0
  if (stepFrac > maxStep) {
    return fail(`focal step ${(100 * stepFrac).toFixed(1)}% exceeds the ${(100 * maxStep).toFixed(0)}% safety limit`, 'focal-step')
  }
  const nominalFrac = nominalFx > 0 ? Math.abs(proposed.fx - nominalFx) / nominalFx : 0
  if (nominalFrac > maxNominal) {
    return fail(`focal is ${(100 * nominalFrac).toFixed(1)}% from ${nominalName}, beyond the ${(100 * maxNominal).toFixed(0)}% safety limit`, 'focal-nominal')
  }

  if (width > 0 && height > 0) {
    if (!finite(proposed.cx) || !finite(proposed.cy)) {
      return fail('self-calibration returned a non-finite principal point', 'invalid-principal-point')
    }
    const ox = Math.abs(proposed.cx - width / 2) / width
    const oy = Math.abs(proposed.cy - height / 2) / height
    if (Math.max(ox, oy) > c.maxPrincipalOffsetFrac) {
      return fail(`principal point moved ${(100 * Math.max(ox, oy)).toFixed(1)}% of the image size from centre`, 'principal-point')
    }

    // Check the proposed forward radial map at all four corners. A negative scale
    // folds the image; a very large displacement is almost always thin-block overfit.
    let maxShift = 0
    for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
      const nx = (x - proposed.cx) / proposed.fx
      const ny = (y - proposed.cy) / proposed.fy
      const r2 = nx * nx + ny * ny
      const scale = radialScale(proposed, r2)
      if (!finite(scale) || scale <= 0 || !invertibleTo(proposed, Math.sqrt(r2))) {
        return fail('radial curve folds or becomes non-finite before the image corner', 'radial-fold')
      }
      maxShift = Math.max(maxShift, Math.hypot(nx * (scale - 1) * proposed.fx, ny * (scale - 1) * proposed.fy))
    }
    const shiftFrac = maxShift / Math.hypot(width, height)
    if (shiftFrac > c.maxCornerShiftFrac) {
      return fail(`radial corner shift ${(100 * shiftFrac).toFixed(1)}% exceeds the ${(100 * c.maxCornerShiftFrac).toFixed(0)}% image-diagonal limit`, 'radial-shift')
    }
  }

  return { ok: true, code: null, reason: null, stepFrac, nominalFrac }
}

import { computed } from 'vue'
import { fitFiducialAffine, mmToScan } from '../core/sfm/fiducials.js'
import { fitFiducialTransform, applyFiducialTransform } from '../core/sfm/fiducialCalibration.js'

// Live fiducial feedback for the image viewer (film sensors, F4): the scan→mm fit
// over this image's placed marks, per-mark residuals, which marks are placed, a
// rough position label per mark, and the predicted ("ghost") position of each
// mark not placed yet. The pure functions below do the work; the composable
// wraps them in computeds over the viewer's props.

/**
 * Join this image's observations ([{ fidId, px, py }]) with the sensor's
 * calibrated marks ([{ id, xMm, yMm }]) and fit the calibration's scan→mm model —
 * reconstruction fits exactly this one, so the live residuals must too (an affine
 * readout misreports a conformal/projective fit). The affine needs ≥3 marks.
 * Returns { obs, fit } with `fit` null until a fit exists.
 */
export function fitFiducialObservations(observations, marks, model = 'affine') {
  const byId = new Map(marks.map((m) => [m.id, m]))
  const obs = observations
    .map((o) => {
      const m = byId.get(o.fidId)
      return m ? { fidId: o.fidId, px: o.px, py: o.py, xMm: m.xMm, yMm: m.yMm } : null
    })
    // Only complete pairs: the fit skips any other, and its residuals are matched
    // back to `obs` by index (fiducialResiduals).
    .filter((o) => o && [o.px, o.py, o.xMm, o.yMm].every(Number.isFinite))
  return {
    obs,
    fit: model === 'affine' ? (obs.length >= 3 ? fitFiducialAffine(obs) : null) : fitFiducialTransform(obs, model),
  }
}

/** fidId → residual µm, from a fitFiducialObservations result (empty without a fit). */
export function fiducialResiduals({ obs, fit }) {
  const m = new Map()
  if (fit) obs.forEach((o, i) => m.set(o.fidId, fit.residualsUm[i]))
  return m
}

/**
 * Rough position label per mark ("top-left", "mid-top", "center"…) derived from
 * its calibrated mm coordinates relative to the layout centroid. A guide only —
 * tells the user which physical corner/edge a mark id refers to. The mm frame is
 * camera-standard (x right, y up), so larger yMm ⇒ top. Map id → label.
 */
export function fiducialMarkPositions(fiducialMarks) {
  const marks = fiducialMarks.filter((m) => Number.isFinite(m.xMm) && Number.isFinite(m.yMm))
  const out = new Map()
  if (!marks.length) return out
  let cx = 0,
    cy = 0,
    ext = 0
  for (const m of marks) {
    cx += m.xMm
    cy += m.yMm
  }
  cx /= marks.length
  cy /= marks.length
  for (const m of marks) ext = Math.max(ext, Math.abs(m.xMm - cx), Math.abs(m.yMm - cy))
  const tol = 0.15 * (ext || 1)
  for (const m of marks) {
    const dx = m.xMm - cx,
      dy = m.yMm - cy
    const v = dy > tol ? 'top' : dy < -tol ? 'bottom' : ''
    const h = dx > tol ? 'right' : dx < -tol ? 'left' : ''
    const label = [v, h].filter(Boolean).join('-') || 'center'
    out.set(m.id, v && h ? label : v || h ? `mid-${label}` : 'center')
  }
  return out
}

/**
 * Ghost guides: once a fit exists, predict where each not-yet-placed mark (id not
 * in `placed`) should land on the raster (mm → scan px), so the user can aim at
 * the remaining fiducials. [{ id, px, py }] in native image pixels.
 */
export function fiducialGhosts(fit, fiducialMarks, placed) {
  if (!fit) return []
  const out = []
  for (const m of fiducialMarks) {
    if (placed.has(m.id) || !Number.isFinite(m.xMm) || !Number.isFinite(m.yMm)) continue
    const p = fit.A
      ? mmToScan(m.xMm, m.yMm, fit.A)
      : applyFiducialTransform({ x: m.xMm, y: m.yMm }, { forward: fit.inverse })
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push({ id: m.id, px: p.x, py: p.y })
  }
  return out
}

// Deps (getters): isFilm, marks ([{ id, xMm, yMm }]), obs ([{ fidId, px, py }]),
// transform (the calibration's model name; falsy = 'affine').
export function useFiducialFit({ isFilm, marks, obs, transform }) {
  const fidFit = computed(() => {
    if (!isFilm() || !obs()?.length) return { obs: [], fit: null }
    return fitFiducialObservations(obs(), marks(), transform() || 'affine')
  })
  // fidId → residual µm (aligned with fidFit.obs order).
  const fidResidual = computed(() => fiducialResiduals(fidFit.value))
  // Which mark ids are already placed on this image (for the menu ✓).
  const markedFidIds = computed(() => new Set(obs().map((o) => o.fidId)))
  const fidMarkPos = computed(() => fiducialMarkPositions(marks()))
  const fidGhosts = computed(() => fiducialGhosts(fidFit.value.fit, marks(), markedFidIds.value))
  return { fidResidual, markedFidIds, fidMarkPos, fidGhosts }
}

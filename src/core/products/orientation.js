// User ORIENTATION of the local product frame (Tools ▸ Model ▾ ▸ Orient model) —
// which way is up, where the origin is and which way X points, for a project with
// no georeference (object capture, an indoor scene, a scale-bar-only survey).
// Pure, no Vue/Pinia/OPFS/DOM.
//
// Same rule as scale (CLAUDE.md ▸ Scale & units): it lives in the FRAME, never in
// the coordinates. The sparse/dense/mesh coordinates stay exactly as the
// reconstruction made them; products, exports and readouts are expressed in the
// oriented frame through the one resolver (stores/reconstruction/frames.js), the
// same way a scale-bar factor is. A georeference outranks it.
//
// Without an orientation the local frame guesses up from the camera viewing
// directions (buildLocalFrame), which is right for a nadir aerial block and wrong
// for a turntable or a façade.
//
// It is model-frame data, so it is stamped with the model it was set on and a
// stale one is ignored (the region / scale-fit rule).
//
// Shape: { up: [x,y,z], origin: [x,y,z], headingDeg: number, sourceStamp: { id, createdAt } }

import { basisFromUp } from './projection.js'

const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** A usable orientation, or null. */
export function normalizeOrientation(o) {
  if (!o || !Array.isArray(o.up) || !Array.isArray(o.origin)) return null
  const up = unit(o.up.map(Number))
  const origin = o.origin.map(Number)
  const headingDeg = Number.isFinite(Number(o.headingDeg)) ? Number(o.headingDeg) : 0
  if (!up || !origin.every(Number.isFinite) || origin.length !== 3) return null
  return { up, origin, headingDeg, ...(o.sourceStamp ? { sourceStamp: { ...o.sourceStamp } } : {}) }
}

/** { active, reason } — same stamp rule as the region and the scale fit. */
export function orientationStatus(o, model) {
  if (!o) return { active: false, reason: 'none' }
  if (!normalizeOrientation(o)) return { active: false, reason: 'invalid' }
  if (!model) return { active: false, reason: 'no-model' }
  const s = o.sourceStamp
  if (!s || s.id !== model.id || s.createdAt !== (model.createdAt ?? null)) return { active: false, reason: 'stale' }
  return { active: true, reason: null }
}

/**
 * The orthonormal frame basis an orientation defines: `up` as given, east/north
 * from basisFromUp (the same default the auto frame uses) turned by `headingDeg`
 * counter-clockwise about up — so heading 0 keeps today's east, and the user turns
 * X towards the feature they want it on.
 * @returns {{ origin, east, north, up }} unit vectors, east × north = up
 */
export function orientationBasis(o) {
  const n = normalizeOrientation(o)
  if (!n) return null
  const { east, north, up } = basisFromUp(n.up)
  const h = (n.headingDeg * Math.PI) / 180
  const c = Math.cos(h), s = Math.sin(h)
  const e = unit([c * east[0] + s * north[0], c * east[1] + s * north[1], c * east[2] + s * north[2]])
  return { origin: [...n.origin], east: e, north: unit(cross(up, e)), up }
}

/**
 * Up from a ground plane: the plane's normal, turned to the side the cameras are
 * on (a camera looks at the surface from above it). `cameraCentres` is a list of
 * [x,y,z]; without cameras the normal is returned as fitted.
 */
export function upFromPlane(normal, point, cameraCentres = []) {
  const n = unit(normal)
  if (!n) return null
  let side = 0
  for (const c of cameraCentres) side += (c[0] - point[0]) * n[0] + (c[1] - point[1]) * n[1] + (c[2] - point[2]) * n[2]
  // 0 − v rather than −v: a flipped zero component stays +0, not −0.
  return side < 0 ? [0 - n[0], 0 - n[1], 0 - n[2]] : n
}

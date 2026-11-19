// Where to look for each GCP target in one photo (Tools ▸ Images ▸ Detect targets,
// core/sfm/targetDetect.js finds it there). Pure.
//
// A GCP marked in two or more other photos is triangulated from those marks; one with
// coordinates and a georeference is placed through it. Either way it is projected into
// this photo's camera, and its expected half-size in pixels follows from the target's
// size, the distance and the focal length.
//
// targetPredictions(ctx) → [{ gcpId, name, u, v, depth, halfPx }]
//   u, v       the camera's pinhole pixel (pixel centres at integers); the caller turns
//              it into a photo pixel through the lens (displayFrame.js)
//   halfPx     the target's half-size in pixels, null when the scale is unknown
// ctx = {
//   gcps        [{ id, name, enabled, role, observations: [{ imageId, px, py }] }],
//               marks already in the cameras' pinhole frame
//   imageId     the photo
//   cam         its { R, t, K }
//   cameras     Map imageId → { R, t, K } of the registered photos
//   toModel     ([x, y, z] project coordinates) → model point, or null without a
//               georeference
//   sizeM       the target's side in metres; metresPerUnit the model's scale (null: unknown)
//   replaceDetected   an earlier detection in this photo ({ source: 'detected' }) is
//               searched again instead of kept
// }

import { triangulateGcp } from './gcpTriangulation.js'
import { projectWithDepth } from './geometry.js'
import { gridToLocal } from '../products/localFrame.js'

export async function targetPredictions({
  gcps,
  imageId,
  cam,
  cameras,
  toModel = null,
  sizeM,
  metresPerUnit = null,
  replaceDetected = false,
}) {
  const out = []
  for (const g of gcps) {
    if (g.enabled === false) continue
    const obs = g.observations ?? []
    // A mark here stays, unless it is an earlier detection being replaced.
    if (obs.some((o) => o.imageId === imageId && !(replaceDetected && o.source === 'detected'))) continue
    let X = null
    const others = obs.filter((o) => o.imageId !== imageId && cameras.has(o.imageId))
    if (others.length >= 2) {
      const tri = await triangulateGcp(others, cameras, { robust: true })
      if (tri && Number.isFinite(tri.x)) X = [tri.x, tri.y, tri.z]
    }
    if (!X && toModel && g.role !== 'marker' && Number.isFinite(g.x) && Number.isFinite(g.y))
      X = toModel([g.x, g.y, g.z ?? 0])
    if (!X) continue
    const p = projectWithDepth(cam, X[0], X[1], X[2])
    if (!p) continue
    const halfPx = metresPerUnit > 0 && sizeM > 0 ? ((sizeM / 2) * cam.K.fx) / (p.depth * metresPerUnit) : null
    out.push({ gcpId: g.id, name: g.name, u: p.u, v: p.v, depth: p.depth, halfPx })
  }
  return out
}

// Where one GCP should be in every registered photo that has no mark of it yet (the
// GCP view's likely places, components/viewers/ViewerGcp.vue): the same two sources
// as targetPredictions, but triangulated once for all the photos.
//   gcp       { role, x, y, z, enabled, observations: [{ imageId, px, py }] }, marks
//             in the cameras' pinhole frame
//   cameras   Map imageId → { R, t, K } of the registered photos
//   toModel   as above, or null
// → { from: 'marks' | 'coordinates' | null, viewCount, rejected, places: [{ imageId,
//   u, v, depth }] } with u, v the pinhole pixel; from null and no places when neither
//   source is there. Unlike targetPredictions it needs Z for the coordinates: a guessed
//   height shifts the place by the parallax, which in a photo from 100 m up is metres.
export async function gcpPlaces({ gcp, cameras, toModel = null }) {
  const none = { from: null, viewCount: 0, rejected: 0, places: [] }
  if (!gcp || gcp.enabled === false) return none
  const obs = (gcp.observations ?? []).filter((o) => o.px != null && o.py != null)
  const marked = new Set(obs.map((o) => o.imageId))
  const views = obs.filter((o) => cameras.has(o.imageId))
  let X = null,
    from = null,
    rejected = 0
  if (views.length >= 2) {
    const tri = await triangulateGcp(views, cameras, { robust: true })
    if (tri && Number.isFinite(tri.x)) {
      X = [tri.x, tri.y, tri.z]
      from = 'marks'
      rejected = tri.rejectedImageIds?.length ?? 0
    }
  }
  if (
    !X &&
    toModel &&
    gcp.role !== 'marker' &&
    Number.isFinite(gcp.x) &&
    Number.isFinite(gcp.y) &&
    Number.isFinite(gcp.z)
  ) {
    X = toModel([gcp.x, gcp.y, gcp.z])
    from = X ? 'coordinates' : null
  }
  if (!X) return none
  const places = []
  for (const [imageId, cam] of cameras) {
    if (marked.has(imageId)) continue
    const p = projectWithDepth(cam, X[0], X[1], X[2])
    if (p) places.push({ imageId, u: p.u, v: p.v, depth: p.depth })
  }
  return { from, viewCount: from === 'marks' ? views.length : 0, rejected, places }
}

// The detector's sampling radius for a target of `halfPx`: inside the mat (its four
// quadrants), clear of the ground around it. Without a scale, a middle value.
export function quadRadiusFor(halfPx) {
  if (!(halfPx > 0)) return 10
  return Math.max(3, Math.min(60, 0.6 * halfPx))
}

// A project point → the model, through a georeference's similarity { scale, R, t, local }
// (products/georef.js applySimilarity, inverted): the local tangent frame first when the
// fit was made in one.
export function modelFromProject({ scale, R, t, local = null }, p) {
  const q = local ? gridToLocal(p, local) : p
  const d = [q[0] - t[0], q[1] - t[1], q[2] - t[2]]
  return [0, 1, 2].map((j) => (R[0][j] * d[0] + R[1][j] * d[1] + R[2][j] * d[2]) / scale)
}

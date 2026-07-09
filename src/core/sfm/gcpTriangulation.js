// Triangulate GCP (ground control point) image observations into the current
// SfM frame, so they can be compared against their surveyed CRS position (the
// georeferencing fit + accuracy report) and, optionally, anchored into bundle
// adjustment. Pure, no Vue/Pinia/OPFS/DOM.
//
// A GCP's observations are `{ imageId, px, py }` pixel marks on one or more
// *registered* images (images with a camera pose in the current sparse
// cloud). Two-view DLT triangulation (reusing the same WASM path as SfM point
// triangulation) on the widest-baseline pair gives the 3D position; any
// further observations only contribute a reprojection-residual diagnostic —
// this keeps the accuracy report meaningful without a new N-view WASM routine.

import { triangulateDlt, makeP34flat } from './reconstruction.js'
import { cameraCenter, projectPoint } from './geometry.js'

// Euclidean distance between two cameras' centres — a parallax proxy usable
// before the 3D point is known (the DLT pair is chosen by this, not by the
// true triangulation angle).
function baseline(camA, camB) {
  const Ca = cameraCenter(camA), Cb = cameraCenter(camB)
  return Math.hypot(Ca[0] - Cb[0], Ca[1] - Cb[1], Ca[2] - Cb[2])
}

// Triangulate one GCP's observations.
//   observations: [{ imageId, px, py }]
//   camerasByImageId: Map<imageId, { R, t, K }> — only *registered* images
// Returns { x, y, z, viewCount, perViewReprojPx: [{ imageId, reprojPx }] } or
// null when fewer than 2 observations resolve to a registered camera.
export async function triangulateGcp(observations, camerasByImageId) {
  const views = (observations || [])
    .map((o) => ({ ...o, cam: camerasByImageId.get(o.imageId) }))
    .filter((v) => v.cam && v.px != null && v.py != null)
  if (views.length < 2) return null

  // Widest-baseline pair for the DLT triangulation.
  let a = null, b = null, bestBaseline = -1
  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      const d = baseline(views[i].cam, views[j].cam)
      if (d > bestBaseline) { bestBaseline = d; a = views[i]; b = views[j] }
    }
  }

  const normalize = (v) => ({ x: (v.px - v.cam.K.cx) / v.cam.K.fx, y: (v.py - v.cam.K.cy) / v.cam.K.fy })
  const PA = makeP34flat(a.cam.R, a.cam.t)
  const PB = makeP34flat(b.cam.R, b.cam.t)
  const tri = await triangulateDlt([normalize(a)], [normalize(b)], PA, PB)
  if (!tri.length) return null
  const { x, y, z } = tri[0]

  const perViewReprojPx = views.map((v) => {
    const proj = projectPoint(v.cam, x, y, z)
    return { imageId: v.imageId, reprojPx: proj ? Math.hypot(proj.u - v.px, proj.v - v.py) : null }
  })

  return { x, y, z, viewCount: views.length, perViewReprojPx }
}

// Triangulate every enabled GCP against the current sparse cloud.
//   gcps: [{ id, enabled, observations }] (useGcpsStore shape)
//   sparseCameras: Map<imageUuid, { R, t, K }>
//   imagesById: Map<imageId, { uuid }> (or anything with a `.uuid` field)
// Returns [{ gcp, tri }] — `tri` is null when not triangulable (surfaced in
// the UI as "insufficient views").
export async function triangulateAllGcps(gcps, sparseCameras, imagesById) {
  const out = []
  for (const gcp of gcps) {
    if (gcp.enabled === false) { out.push({ gcp, tri: null }); continue }
    const camerasByImageId = new Map()
    for (const o of gcp.observations || []) {
      const uuid = imagesById.get(o.imageId)?.uuid
      const cam = uuid != null ? sparseCameras.get(uuid) : null
      if (cam) camerasByImageId.set(o.imageId, cam)
    }
    const tri = await triangulateGcp(gcp.observations, camerasByImageId)
    out.push({ gcp, tri })
  }
  return out
}

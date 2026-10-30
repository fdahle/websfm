// Extending a saved sparse model with images it does not hold (Sparse Model ▸ Add to the
// model): the model's cameras and points become the run's starting state in place of a
// seed pair, and registration, the refinement and the registration check then work on
// the new images only. Pure, no Vue/Pinia/OPFS/DOM.
//
// The cameras the model holds stay where they are: every solve holds them fixed
// (bundleSession.js `fixedCameras`), so depth maps, clouds and rasters built from them
// stay valid. Self-calibration is off for the run, and each image takes its group's
// lens as the model solved it, so a new image lands in the same pinhole frame as the
// old ones (displayFrame.js, the chain dense uses). The saved observations carry their
// BA-frame pixel (sparsePoints.js vx/vy): the old images' keypoints are rebuilt through
// that chain, checked against those pixels, and then take them exactly, so the first
// solve starts from the model as it was saved.
//
// seedFromModel(ctx) — ctx = {
//   imgs,               the run's images (kpStatus 'done'), `img.kp` already ingested
//   rawKp,              uuid → the image's keypoint set before ingest (detection's frame)
//   base,               { cameras: Map | [{ uuid, R, t, K }], points: SparsePoints, summary }
//   Kmap,               uuid → K (ingest's), replaced for every image the model's lens covers
//   fiducialTransforms, uuid → film transform (ingest's), the model's for its own images
//   cameras, tracks, ids,  the run's empty model state, seeded here
//   maxFrameMedianPx,   the largest median gap between rebuilt and saved pixels accepted
// }
// → { ok: true, fixed: Set<uuid>, added: [uuid], ownLens: n, frame: { n, medianPx, p95Px } }
//   | { ok: false, reason }

import { makeFrameModelResolver, makeScanCentreToPinhole } from './displayFrame.js'
import { mapPositions } from './keypointSet.js'
import { isFisheyeModel } from './distortion.js'
import { pluralize } from '../textFormat.js'

const groupOf = (img) => (img.sensorId != null ? `sensor:${img.sensorId}` : `image:${img.uuid}`)
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0)

export function seedFromModel({ imgs, rawKp, base, Kmap, fiducialTransforms, cameras, tracks, ids, maxFrameMedianPx }) {
  const baseCams = base.cameras instanceof Map ? base.cameras : new Map(base.cameras.map((c) => [c.uuid, c]))
  const points = base.points
  const summary = base.summary ?? {}
  const imgByUuid = new Map(imgs.map((im) => [im.uuid, im]))

  const missing = [...baseCams.keys()].filter((u) => !imgByUuid.has(u)).length
  if (missing)
    return {
      ok: false,
      reason: `${pluralize(missing, 'camera')} of the model ${missing === 1 ? 'has' : 'have'} no features to read`,
    }
  if (!points?.vx || !points.viewTotal)
    return { ok: false, reason: 'the model keeps no image observations (an imported model)' }
  // A fisheye camera is solved in recorded pixels with its lens in the solve
  // (bundleSession.js lensFrame), not in a pinhole frame this seeding can rebuild.
  if (
    imgs.some((im) => isFisheyeModel(im.sensor?.distortionModel)) ||
    (summary.selfCalDistortion ?? []).some((d) => d.fisheye)
  )
    return { ok: false, reason: 'a fisheye camera cannot be added to a model yet' }

  // The saved pixel of each observed keypoint, per image index.
  const saved = new Map() // image index → Map(kp → slot)
  for (let i = 0, n = points.length; i < n; i++) {
    for (let s = points.vstart[i]; s < points.vstart[i + 1]; s++) {
      const uuid = points.viewUuids[points.vcam[s]]
      const img = baseCams.has(uuid) ? ids.img(uuid) : -1
      if (img < 0) continue
      if (!saved.has(img)) saved.set(img, new Map())
      saved.get(img).set(points.vkp[s], s)
    }
  }

  // Each group's K as the model solved it: the first of its cameras, in the model's order.
  const groupK = new Map()
  for (const [uuid, cam] of baseCams) {
    const key = groupOf(imgByUuid.get(uuid))
    if (!groupK.has(key)) groupK.set(key, cam.K)
  }
  const sensors = []
  const seenSensor = new Set()
  for (const im of imgs) {
    if (im.sensorId == null || !im.sensor || seenSensor.has(im.sensorId)) continue
    seenSensor.add(im.sensorId)
    sensors.push({ id: im.sensorId, ...im.sensor })
  }
  const frameModel = makeFrameModelResolver({ summary, sensors })

  const gaps = []
  let ownLens = 0
  for (const im of imgs) {
    const K = baseCams.get(im.uuid)?.K ?? groupK.get(groupOf(im))
    if (!K) {
      // A new camera on a lens the model has not seen: ingest's frame, as in a new run.
      ownLens++
      continue
    }
    const raw = rawKp.get(im.uuid)
    const fm = frameModel(im)
    // The model's film transform for its own images (the frame it was solved in);
    // ingest's fit for a new one.
    const fiducial = baseCams.has(im.uuid) ? fm.fiducial : (fiducialTransforms.get(im.uuid) ?? null)
    if (fiducial) fiducialTransforms.set(im.uuid, fiducial)
    const toPinhole = makeScanCentreToPinhole({ K, dist: fm.dist, selfCal: fm.selfCal, fiducial })
    const own = saved.get(ids.img(im.uuid))
    if (own) {
      for (const kp of own.keys())
        if (!(kp < raw.n))
          return {
            ok: false,
            reason: `the features of ${im.name} changed since the model was built (detect them again, or rebuild the model)`,
          }
    }
    im.kp = mapPositions(raw, (x, y, kp) => {
      const p = toPinhole(x, y)
      const s = own?.get(kp)
      if (s == null) return p
      const sx = points.vx[s],
        sy = points.vy[s]
      if (!Number.isFinite(sx)) return p
      gaps.push(Math.hypot(p.x - sx, p.y - sy))
      return { x: sx, y: sy }
    })
    Kmap.set(im.uuid, { ...K })
  }
  gaps.sort((a, b) => a - b)
  const frame = { n: gaps.length, medianPx: quantile(gaps, 0.5), p95Px: quantile(gaps, 0.95) }
  // Re-detected features, or a model the frame chain cannot reproduce: its saved
  // observations no longer describe these keypoints.
  if (frame.medianPx > maxFrameMedianPx)
    return {
      ok: false,
      reason:
        `the images' features no longer match the model's observations (median ${frame.medianPx.toFixed(1)} px ` +
        `apart, ${maxFrameMedianPx} px allowed): rebuild the model instead`,
    }

  for (const [uuid, cam] of baseCams)
    cameras.set(uuid, { R: cam.R.map((row) => [...row]), t: [...cam.t], K: { ...cam.K } })
  for (let i = 0, n = points.length; i < n; i++) {
    const p = tracks.addPoint(points.pos[3 * i], points.pos[3 * i + 1], points.pos[3 * i + 2])
    for (let s = points.vstart[i]; s < points.vstart[i + 1]; s++) {
      const uuid = points.viewUuids[points.vcam[s]]
      if (baseCams.has(uuid)) tracks.addView(p, ids.img(uuid), points.vkp[s])
    }
  }
  return {
    ok: true,
    fixed: new Set(baseCams.keys()),
    added: imgs.filter((im) => !baseCams.has(im.uuid)).map((im) => im.uuid),
    ownLens,
    frame,
  }
}

// Why the main sparse model cannot take more images, or null. `cloud` is the store's
// sparse cloud; `newImages` the images with features it does not hold.
export function extensionBlocker(cloud, newImages) {
  if (!cloud?.cameras?.size) return 'there is no sparse model yet'
  if (cloud.imported) return 'an imported model keeps no observations to build on'
  if (!cloud.points?.hasPixels) return 'the model keeps no image observations; rebuild it once'
  if (!(newImages > 0)) return 'every image with features is already in the model'
  return null
}

// Existing cameras: 'fixed' keeps every camera the model holds where it is, so what was
// built from them stays valid; 'refined' then lets every camera move (Optimize cameras).
// Auto keeps them fixed when something was built from them, and refines them otherwise.
export function resolveExistingCameras(setting, { hasProducts = false } = {}) {
  if (setting === 'fixed' || setting === 'refined') return setting
  return hasProducts ? 'fixed' : 'refined'
}

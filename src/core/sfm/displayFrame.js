// Canonical/pinhole pixel → the raw scan pixel a viewer actually draws on. Pure,
// no Vue/Pinia/OPFS/DOM.
//
// Everything the pipeline computes after ingest lives in a *pinhole* frame:
// distortion is folded out of the keypoints once (core/sfm/distortion.js), and a
// film sensor's scan geometry is folded out on top of that into a per-sensor
// canonical pixel frame (core/sfm/fiducials.js). Store keypoints, GCP marks and the
// displayed image all stay in the original scan frame, so anything that draws a
// *computed* pixel position over the image has to come back — otherwise it lands
// offset by the distortion (a calibrated lens) or by the whole scan→canonical
// affine (a film scan, where the offset can be enormous).
//
// The chain is exactly the one workers/ops/dense.js applies to build its sample
// map, and this module is where both get it from:
//   canonical px →(self-cal bag, then any calibrated bag)→ distorted canonical
//                →(canonicalToScan)→ scan px
// The two distortion bags compose in that order because the self-cal fold happened
// *after* ingest removed the calibrated one, so undoing them runs newest-first.

import { distortPixel, undistortPixel, hasDistortion, distortionOf } from './distortion.js'
import { canonicalToScan, scanToCanonical } from './fiducials.js'
import { toScaledPx, fromScaledPx, scaleAxes } from './geometry.js'
import { rollingShutterPixel } from './rollingShutter.js'

// Apply both distortion bags: ideal pinhole pixel → the pixel the lens recorded.
// `Kw` must be the K the coefficients were fitted against (working-res if the
// caller scaled it). A no-op when both bags are empty.
export function distortComposed(u, v, Kw, dist, selfCal) {
  let x = u,
    y = v
  if (hasDistortion(selfCal)) {
    const p = distortPixel(x, y, Kw, selfCal)
    x = p.x
    y = p.y
  }
  if (hasDistortion(dist)) {
    const p = distortPixel(x, y, Kw, dist)
    x = p.x
    y = p.y
  }
  return { x, y }
}

// Build the canonical→scan mapper for one image, or **null** when the image needs
// no correction at all (no distortion bags, not a film scan) — callers treat null
// as identity and skip the per-point work, which is the common case.
//   K        — the canonical/pinhole intrinsics the positions were computed in
//   dist     — calibrated lens bag removed at ingest (distortion.js distortionOf, or null)
//   selfCal  — composed self-calibration bag from summary.selfCalDistortion (or null)
//   fiducial — { A, frame } from summary.fiducialTransforms for this image (or null)
export function makeCanonicalToScan({ K, dist = null, selfCal = null, fiducial = null } = {}) {
  return makeSampleMap({ K, dist, selfCal, fiducial })
}

// Camera-frame (pinhole) pixel → mark pixel, for anything that produces or draws a
// mark: GCP guides and estimates, Find-GCPs candidates. makeCanonicalToScan plus the
// half-pixel convention shift (see markToCentrePx); always a function.
export function makePinholeToMark({ K, dist = null, selfCal = null, fiducial = null } = {}) {
  const toScan = makeCanonicalToScan({ K, dist, selfCal, fiducial })
  return (u, v) => {
    const p = toScan ? toScan(u, v) : { x: u, y: v }
    return { x: centreToMarkPx(p.x), y: centreToMarkPx(p.y) }
  }
}

// The same chain, but between two *scaled* grids — the form a resampler needs.
// `outScale` is the resolution of the (u,v) grid relative to K's own frame,
// `srcScale` the resolution of the source raster relative to the scan frame; both
// default to 1, which recovers makeCanonicalToScan exactly.
//
// Scaling the grid rather than K is safe and is why only one primitive is needed:
// distortPixel normalizes by K, so distortComposed(u, v, scaleK(K, s)) is
// identically toScaledPx(distortComposed(fromScaledPx(u, s), …, K), s) — the
// normalized coordinates are the same number either way, because scaleK moves the
// principal point by the same centre-aligned rule.
//
// Returns **null** when the whole chain is the identity (no bags, no fiducial, both
// scales 1); callers treat null as "no work to do", which is the common
// EXIF-only digital case.
//
// `rs`: a rolling-shutter photo's warp (rollingShutter.js rollingShutterWarps): the
// output grid is the principal row's pose, so each pixel first moves to where the
// photo recorded it, in the pinhole frame, before the lens.
export function makeSampleMap({
  K,
  dist = null,
  selfCal = null,
  fiducial = null,
  outScale = 1,
  srcScale = 1,
  rs = null,
} = {}) {
  const needsDist = !!K && (hasDistortion(dist) || hasDistortion(selfCal))
  const needsRs = !!K && !!rs
  // Either scale may be per axis [sx, sy] (geometry.js scaleAxes): a raster resized to
  // a rounded size has slightly different factors per axis.
  const [ox, oy] = scaleAxes(outScale),
    [qx, qy] = scaleAxes(srcScale)
  const needsScale = ox !== 1 || oy !== 1 || qx !== 1 || qy !== 1
  if (!needsDist && !fiducial && !needsScale && !needsRs) return null
  return (u, v) => {
    // Into K's own (full-resolution canonical) frame — pixel-centre aligned
    // (geometry.js toScaledPx), the same convention scaleK uses.
    let x = ox === 1 ? u : fromScaledPx(u, ox)
    let y = oy === 1 ? v : fromScaledPx(v, oy)
    if (needsRs) {
      const r = rollingShutterPixel(rs, K, x, y)
      x = r.x
      y = r.y
    }
    if (needsDist) {
      const d = distortComposed(x, y, K, dist, selfCal)
      x = d.x
      y = d.y
    }
    if (fiducial) {
      const s = canonicalToScan(x, y, fiducial.transform ?? fiducial.A, fiducial.frame)
      x = s.x
      y = s.y
    }
    // Into the source raster's grid.
    if (qx !== 1) x = toScaledPx(x, qx)
    if (qy !== 1) y = toScaledPx(y, qy)
    return { x, y }
  }
}

// ── Marks vs keypoints: two pixel conventions ────────────────────────────────
// Marks (GCP / marker / scale-bar clicks, imported Metashape marks, Find-GCPs
// candidates) use the viewer's pixel-EDGE convention: the image's top-left corner is
// (0, 0), pixel i spans [i, i + 1] and its centre is i + ½ (ViewerImage toImagePixel).
// Keypoints, K and every camera projection use pixel CENTRES at integers. Convert at
// the boundary — marks into the camera frame (makeScanToPinhole, sfm.js GCP ingest)
// and camera-frame positions back into marks (makePinholeToMark) — never in storage.
// GeoScan checkpoints: H 4.2 → 3.3 cm, V 8.1 → 7.1 cm (2026-10-06).
export const markToCentrePx = (x) => x - 0.5
export const centreToMarkPx = (x) => x + 0.5

// The reverse chain: a raw scan pixel (a GCP mark, anything the user clicked) →
// the pinhole/canonical pixel the reconstructed cameras project into. Exactly the
// steps ingest and the self-cal fold apply to keypoints, in order: mark → pixel-
// centre convention, scan→canonical (film), remove the calibrated bag, remove the
// composed self-cal bag. Triangulating raw marks against pinhole cameras instead is
// off by the whole lens distortion — and on a film scan by the entire scan→canonical
// affine. Never the identity (the half-pixel convention shift always applies).
export function makeScanToPinhole({ K, dist = null, selfCal = null, fiducial = null } = {}) {
  const toPinhole = makeScanCentreToPinhole({ K, dist, selfCal, fiducial })
  return (px, py) => toPinhole(markToCentrePx(px), markToCentrePx(py))
}

// The same chain for a position already in the pixel-centre convention: a keypoint as
// detection stored it. Extending a saved model (extendModel.js) moves an image's
// keypoints into the model's frame with it.
export function makeScanCentreToPinhole({ K, dist = null, selfCal = null, fiducial = null } = {}) {
  const undoDist = !!K && hasDistortion(dist),
    undoSelf = !!K && hasDistortion(selfCal)
  return (px, py) => {
    let x = px,
      y = py
    if (fiducial) {
      const c = scanToCanonical(x, y, fiducial.transform ?? fiducial.A, fiducial.frame)
      x = c.x
      y = c.y
    }
    if (undoDist) {
      const p = undistortPixel(x, y, K, dist)
      x = p.x
      y = p.y
    }
    if (undoSelf) {
      const p = undistortPixel(x, y, K, selfCal)
      x = p.x
      y = p.y
    }
    return { x, y }
  }
}

// ONE join from the persisted run record to each image's frame model — the
// calibrated bag of its sensor (or the run's self-calibrated fisheye lens), the
// composed self-cal bag, the film transform.
// Dense, exports, the GCP tools and the image overlays all need it, and copies
// of this join had drifted (one normalised an all-zero self-cal bag, others
// passed it raw). Returns image → { dist, selfCal, fiducial, filmMissing }.
//   summary  — the sparse run summary ({ selfCalDistortion, fiducialTransforms })
//   sensors  — the sensor list (plain or reactive)
// `summary` must be plain (a store passes toRaw of its reactive summary): the
// fiducial records built here go to workers, and a Proxy cannot be posted.
//   calibration — a sparse cloud's own calibration (calibrationSnapshot below): when
//                 given, it is the join, and `summary` is not read. An image whose group
//                 the snapshot does not hold (added after the run) takes its sensor's lens.
export function makeFrameModelResolver({ summary = null, sensors = [], calibration = null } = {}) {
  if (calibration) return resolverFromCalibration(calibration, sensors)
  return resolverFromSummary(summary, sensors)
}

function resolverFromSummary(summary, sensors) {
  const sensorById = new Map((sensors || []).map((s) => [s.id, s]))
  // A row is a sensor's, or — `sensorId` null — one sensorless image's (`imageUuid`):
  // such an image self-calibrates as its own group (runRecord.js ▸ selfCalDistortion (rows built by selfCalFold.js)).
  const rows = summary?.selfCalDistortion ?? []
  const selfCalBySensor = new Map(rows.filter((d) => d.sensorId != null).map((d) => [d.sensorId, d]))
  const selfCalByImage = new Map(
    rows.filter((d) => d.sensorId == null && d.imageUuid != null).map((d) => [d.imageUuid, d]),
  )
  const fidByUuid = new Map(
    (summary?.fiducialTransforms ?? []).map((t) => [
      t.uuid,
      { A: t.A ?? null, transform: t.transform ?? null, frame: t.frame },
    ]),
  )
  return (image) => {
    const sensor = image?.sensorId != null ? sensorById.get(image.sensorId) : null
    const sc =
      image?.sensorId != null
        ? selfCalBySensor.get(image.sensorId)
        : image?.uuid != null
          ? selfCalByImage.get(image.uuid)
          : null
    const fiducial = image?.uuid != null ? (fidByUuid.get(image.uuid) ?? null) : null
    // A `full` row (and every `fisheye` row) is the run's whole solved lens
    // (selfCalFold.js): it replaces the sensor's, it does not compose on top of it.
    if (sc?.fisheye) {
      return {
        dist: { fisheye: true, k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0, k4: sc.k4 || 0 },
        selfCal: null,
        fiducial,
        filmMissing: false,
      }
    }
    if (sc?.full) {
      const lens = { k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0, p1: sc.p1 || 0, p2: sc.p2 || 0 }
      return {
        dist: lens.k1 || lens.k2 || lens.k3 || lens.p1 || lens.p2 ? lens : null,
        selfCal: null,
        fiducial,
        filmMissing: sensor?.kind === 'film' && !fiducial,
      }
    }
    const selfCal = sc && (sc.k1 || sc.k2 || sc.k3) ? { k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0 } : null
    return {
      dist: sensor ? distortionOf(sensor) : null,
      selfCal,
      fiducial,
      filmMissing: sensor?.kind === 'film' && !fiducial,
    }
  }
}

// A camera group's key in a calibration snapshot: its sensor, or a sensorless image.
const groupKeyOf = (image) => (image?.sensorId != null ? `sensor:${image.sensorId}` : `image:${image?.uuid}`)

// A sparse cloud's calibration: for every camera group of `images` ([{ uuid, sensorId }],
// the cloud's registered images), the frame model the run's join gives it now — the whole
// lens (`dist`), an older run's radial correction on top of it (`selfCal`, null for a
// lens solved whole) — and the film transforms of those images. The cloud keeps it, so
// what draws the cloud no longer depends on the sensor table or on which run wrote the
// project summary last. Plain data (it is saved with the cloud and posted to workers).
//   resolve  — the join to snapshot (makeFrameModelResolver over a run's summary)
//   source   — 'run' | 'colmap' | 'metashape' | 'migrated' | 'not-recorded'
export function calibrationSnapshot({ resolve, images = [], source = 'run' }) {
  const groups = new Map()
  const fiducialTransforms = []
  for (const image of images) {
    const fm = resolve(image)
    const key = groupKeyOf(image)
    if (!groups.has(key)) {
      groups.set(key, {
        ...(image.sensorId != null ? { sensorId: image.sensorId } : { imageUuid: image.uuid }),
        dist: fm.dist ? { ...fm.dist } : null,
        selfCal: fm.selfCal ? { ...fm.selfCal } : null,
      })
    }
    if (fm.fiducial) fiducialTransforms.push({ uuid: image.uuid, ...structuredClone(fm.fiducial) })
  }
  return { groups: [...groups.values()], fiducialTransforms, source }
}

function resolverFromCalibration(calibration, sensors) {
  const sensorById = new Map((sensors || []).map((s) => [s.id, s]))
  const groupBy = new Map(
    (calibration.groups ?? []).map((g) => [g.sensorId != null ? `sensor:${g.sensorId}` : `image:${g.imageUuid}`, g]),
  )
  const fidByUuid = new Map(
    (calibration.fiducialTransforms ?? []).map((t) => [
      t.uuid,
      { A: t.A ?? null, transform: t.transform ?? null, frame: t.frame },
    ]),
  )
  return (image) => {
    const sensor = image?.sensorId != null ? sensorById.get(image.sensorId) : null
    const fiducial = image?.uuid != null ? (fidByUuid.get(image.uuid) ?? null) : null
    const g = groupBy.get(groupKeyOf(image))
    return {
      dist: g ? g.dist : sensor ? distortionOf(sensor) : null,
      selfCal: g ? g.selfCal : null,
      fiducial,
      filmMissing: sensor?.kind === 'film' && !fiducial,
    }
  }
}

// GCP / marker observations → the cameras' pinhole frame, for triangulation.
// `gcps` keep their identity fields; only observations whose image is registered
// and needs a correction are copied with mapped px/py (store state is never
// mutated — the marks themselves stay in scan pixels, where they were clicked).
//   imagesById    Map<imageId, image>       sparseCameras  Map<uuid, { K }>
//   frameModel    image → { dist, selfCal, fiducial } (makeFrameModelResolver)
export function gcpsInPinholeFrame(gcps, { imagesById, sparseCameras, frameModel }) {
  if (!frameModel) return gcps
  const maps = new Map()
  const mapperFor = (imageId) => {
    if (maps.has(imageId)) return maps.get(imageId)
    const im = imagesById.get(imageId),
      cam = im ? sparseCameras.get(im.uuid) : null
    const m = cam?.K ? makeScanToPinhole({ K: cam.K, ...frameModel(im) }) : null
    maps.set(imageId, m)
    return m
  }
  return (gcps || []).map((g) => {
    let changed = false
    const observations = (g.observations || []).flatMap((o) => {
      const m = o.px != null && o.py != null ? mapperFor(o.imageId) : null
      if (!m) return [o]
      changed = true
      const p = m(o.px, o.py)
      // A fisheye mark past 90° off-axis has no pinhole image: drop it.
      return Number.isFinite(p.x) && Number.isFinite(p.y) ? [{ ...o, px: p.x, py: p.y }] : []
    })
    return changed ? { ...g, observations } : g
  })
}

// A guide computed in the pinhole frame → the scan pixels the viewer draws on.
// A point maps exactly. An epipolar line is a line only in the pinhole frame: it
// is re-fitted through two of its points either side of the principal point, mapped
// to the scan (exact for a film affine, a chord of the true curve under lens
// distortion — the same approximation the guide already documents).
export function guideToScan(guide, toScan, K) {
  if (!guide || !toScan) return guide
  if (guide.kind === 'point') {
    const p = toScan(guide.u, guide.v)
    return { ...guide, u: p.x, v: p.y }
  }
  if (guide.kind !== 'line' || !guide.line || !K) return guide
  const [a, b, c] = guide.line
  const off = a * K.cx + b * K.cy + c
  const fx = K.cx - off * a,
    fy = K.cy - off * b,
    D = Math.max(K.cx, K.cy, 1)
  const p = toScan(fx - D * b, fy + D * a),
    q = toScan(fx + D * b, fy - D * a)
  const la = q.y - p.y,
    lb = p.x - q.x,
    n = Math.hypot(la, lb)
  if (!(n > 1e-12)) return null
  return { ...guide, line: [la / n, lb / n, -(la * p.x + lb * p.y) / n] }
}

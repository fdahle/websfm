// The run's lens state for one single-model run: which images share a calibration (a
// sensor, or a sensorless image alone), each group's complete lens, each image's
// K-frame size, and the pinhole view of every image's keypoints and GCP marks.
//
// The keypoints and marks as the lens recorded them are the record (ingest.js
// `recordedByUuid`; an image without a calibrated lens records what it had when this
// state was made). `img.kp` and the marks the pipeline reads are a VIEW of them: the
// recorded pixels undistorted by the group's current lens about the image's current K.
// Every bundle adjustment fits the recorded pixels with the whole lens
// (bundleSession.js lensFrame, bundleAdjust `fullLens`), so self-calibration solves
// the lens itself, Brown k1–k3 and p1/p2 or a fisheye's k1–k4, and an accepted solve
// re-derives the view from the record (`fold`). Nothing is corrected on top of an
// earlier correction, and the lens the summary stores is the one the solve found.
// A rational lens (k4–k6) is not a solver model: its group keeps the calibrated lens,
// solves in the pinhole view, and self-calibrates its K only.
//
// createSelfCalFold(ctx) — ctx = {
//   imgs, cameras, Kmap, moveGcpObs, sensorIntByUuid, fiducialTransforms, log,
//   recordedByUuid?,   ingest.js's record (uuid → { kp, marks, K, lens })
// }
// Created before registration: the interim BA self-calibrates f,k1 mid-registration
// (D3), so bundleSession.js's runBundleAdjust folds during the registration call.

import { undistortPixel, undistortKeypoint, distortionOf, coeffsForModel } from './distortion.js'
import { mapPositions } from './keypointSet.js'
import { undistortBrownPixels } from './reconstruction.js'
import { pluralize } from '../textFormat.js'

const kChanged = (a, b) => a.fx !== b.fx || a.fy !== b.fy || a.cx !== b.cx || a.cy !== b.cy
const LENS_TERMS = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'p1', 'p2']
const lensChanged = (a, b) => LENS_TERMS.some((t) => (a?.[t] || 0) !== (b?.[t] || 0))
const anyTerm = (l) => !!l && LENS_TERMS.some((t) => l[t])

// A sensor's calibrated lens as the run's lens state: { kind, …coefficients }.
//   'fisheye'   Kannala–Brandt k1–k4 (`terms`: how many its model lets self-cal refine)
//   'brown'     k1–k3, p1, p2 (the solver's Brown model; all zero = a pinhole lens)
//   'rational'  k1–k6, p1, p2: kept as calibrated, solved in the pinhole view
function lensFromSensor(sensor) {
  const d = distortionOf(sensor)
  if (d?.fisheye) {
    return {
      kind: 'fisheye',
      terms: coeffsForModel(sensor.distortionModel).length,
      k1: d.k1,
      k2: d.k2,
      k3: d.k3,
      k4: d.k4,
    }
  }
  if (d && (d.k4 || d.k5 || d.k6)) return { kind: 'rational', ...d }
  return { kind: 'brown', k1: d?.k1 || 0, k2: d?.k2 || 0, k3: d?.k3 || 0, p1: d?.p1 || 0, p2: d?.p2 || 0 }
}
// The bag distortion.js undistorts with (null for a lens that changes nothing).
const bagOf = (lens) =>
  !anyTerm(lens)
    ? null
    : lens.kind === 'fisheye'
      ? { fisheye: true, k1: lens.k1, k2: lens.k2, k3: lens.k3, k4: lens.k4 }
      : lens

export function createSelfCalFold({
  imgs,
  cameras,
  Kmap,
  moveGcpObs,
  sensorIntByUuid,
  fiducialTransforms,
  log,
  recordedByUuid = new Map(),
}) {
  // Self-calibration group of an image: its sensor's (BA shares one focal scale,
  // principal-point offset and lens across a sensor), or — with no sensor — the
  // image's own (the crate gives every `sensorOfCam` −1 camera a group of its own).
  // `imgsBySelfCalGroup` lists EVERY image of a group, registered or not: a refined
  // calibration reaches all of them (fold below).
  const selfCalGroupOf = (uuid) => {
    const g = sensorIntByUuid.get(uuid) ?? -1
    return g >= 0 ? `sensor:${g}` : `image:${uuid}`
  }
  const imgsBySelfCalGroup = new Map() // group key → [img, …]
  for (const img of imgs) {
    const key = selfCalGroupOf(img.uuid)
    if (!imgsBySelfCalGroup.has(key)) imgsBySelfCalGroup.set(key, [])
    imgsBySelfCalGroup.get(key).push(img)
  }
  const imgByUuid = new Map(imgs.map((img) => [img.uuid, img]))

  // Each group's lens: the sensor's, replaced by every accepted solve that refines it.
  // The BA's recorded-pixel observations, the view and the summary all read it here.
  const lensByGroup = new Map() // group key → lens state (lensFromSensor's shape)
  const refinedLensGroups = new Set() // groups whose lens a solve has changed
  function groupLens(key) {
    if (!lensByGroup.has(key)) lensByGroup.set(key, lensFromSensor(imgsBySelfCalGroup.get(key)?.[0]?.sensor))
    return lensByGroup.get(key)
  }
  // The lens a bundle adjustment fits on this image's recorded pixels, as bundleAdjust's
  // intrinsics carry it: a fisheye's (`fisheye`, `fisheyeTerms`, k1–k4), a Brown one's
  // (k1–k3, p1, p2, all zero for a pinhole lens), or null for a rational lens (its
  // camera solves in the pinhole view).
  function baLensOf(uuid) {
    if (!imgByUuid.has(uuid)) return null
    const l = groupLens(selfCalGroupOf(uuid))
    if (l.kind === 'fisheye')
      return { fisheye: true, fisheyeTerms: l.terms, k1: l.k1 || 0, k2: l.k2 || 0, k3: l.k3 || 0, k4: l.k4 || 0 }
    if (l.kind === 'rational') return null
    return { k1: l.k1, k2: l.k2, k3: l.k3, p1: l.p1, p2: l.p2 }
  }
  // The fisheye lens of an image (the BA's Kannala–Brandt seed and what dense pairs with
  // its K), or null.
  const lensOf = (uuid) => {
    const l = baLensOf(uuid)
    return l?.fisheye ? { fisheye: true, terms: l.fisheyeTerms, k1: l.k1, k2: l.k2, k3: l.k3, k4: l.k4 } : null
  }

  // An image's size in K's pixel frame — what the self-cal guards measure the
  // principal point and corners against. A film scan's K lives in the fiducial
  // canonical frame (ingest.js applyFiducialFrames), not in its scan pixels.
  // 0 × 0 when unknown.
  const kFrameDims = (img) => {
    const frame = img ? fiducialTransforms.get(img.uuid)?.frame : null
    if (frame) return { width: frame.width, height: frame.height }
    return { width: img?.meta?.width ?? img?.width ?? 0, height: img?.meta?.height ?? img?.height ?? 0 }
  }

  // An image's record: ingest's, or — an image whose sensor has no calibrated lens, so
  // its view IS its recorded pixels until a solve gives the group a lens — what it has
  // now, kept the first time it is asked for (before any re-derivation).
  function recordOf(img) {
    let rec = recordedByUuid.get(img.uuid)
    if (!rec && img.kp) {
      const marks = []
      moveGcpObs(img.uuid, (x, y) => (marks.push([x, y]), { x, y }))
      rec = { kp: img.kp, marks }
      recordedByUuid.set(img.uuid, rec)
    }
    return rec
  }
  // Capture the record of every image that has none before the first view changes.
  for (const img of imgs) recordOf(img)

  // Re-derive `entries`' ([{ img, Kc }], one group) keypoints and marks from their
  // record through `lens` about each image's new K. Brown and rational lenses go to the
  // crate in one call (its thread pool in the threaded build); a fisheye, and the JS path
  // before the wasm has loaded, map per point. Returns the keypoints' summed shift from
  // the view they replace (px) and their count.
  function rebuildViews(entries, lens) {
    const bag = bagOf(lens)
    let shift = 0,
      n = 0
    const moved = (before, after) => {
      const a = before.xy,
        b = after.xy
      for (let j = 0; j < before.n; j++) {
        // eslint-disable-next-line no-self-compare
        if (a[2 * j] !== a[2 * j] || b[2 * j] !== b[2 * j]) continue // a missing point
        shift += Math.hypot(b[2 * j] - a[2 * j], b[2 * j + 1] - a[2 * j + 1])
        n++
      }
    }
    const withRecord = entries.filter(({ img }) => recordOf(img)?.kp?.n)
    let batch = null
    if (bag && !bag.fisheye && withRecord.length) {
      let total = 0
      for (const { img } of withRecord) total += recordOf(img).kp.n
      const xy = new Float64Array(2 * total),
        starts = new Uint32Array(withRecord.length + 1),
        kk = new Float64Array(4 * withRecord.length)
      withRecord.forEach(({ img, Kc }, i) => {
        const rec = recordOf(img).kp
        xy.set(rec.xy.subarray(0, 2 * rec.n), 2 * starts[i])
        starts[i + 1] = starts[i] + rec.n
        kk.set([Kc.fx, Kc.fy, Kc.cx, Kc.cy], 4 * i)
      })
      const out = undistortBrownPixels(xy, starts, kk, bag)
      if (out) batch = { out, starts }
    }
    withRecord.forEach(({ img, Kc }, i) => {
      const rec = recordOf(img)
      let view
      if (!bag) view = rec.kp
      else if (batch) {
        const xy = batch.out.slice(2 * batch.starts[i], 2 * batch.starts[i + 1])
        // A point missing in the record stays missing.
        for (let j = 0; j < rec.kp.n; j++) {
          // eslint-disable-next-line no-self-compare
          if (rec.kp.xy[2 * j] !== rec.kp.xy[2 * j]) xy[2 * j] = xy[2 * j + 1] = NaN
        }
        view = { n: rec.kp.n, xy, rgb: rec.kp.rgb, hasColor: rec.kp.hasColor }
      } else view = mapPositions(rec.kp, (x, y) => undistortKeypoint(x, y, Kc, bag))
      moved(img.kp, view)
      img.kp = view
      let m = 0
      moveGcpObs(img.uuid, () => {
        const p = rec.marks[m++]
        return bag ? undistortPixel(p[0], p[1], Kc, bag) : { x: p[0], y: p[1] }
      })
    })
    return { shift, n, images: withRecord.length }
  }

  // ── Adopt an accepted self-calibrating solve ───────────────────────────────────
  // A refined calibration belongs to the whole group, not just the cameras that were in
  // this solve: Kmap (what every later PnP resects with, and the K a camera registers
  // with) is updated for EVERY image of a solved group, whatever the mode. Each image
  // gets its OWN refined K: the crate keeps per-camera seed differences (fx = s·fx0_c,
  // cx = cx0_c + dcx), so a camera in this solve takes its output and one outside it the
  // group's update applied to its own K. The group's lens becomes the solved one, and
  // every image whose K or lens changed has its view re-derived from its record.
  //
  // One call per committed solve that refined at least one group: `solvedGroups` maps
  // each refined group key → the index of its first camera in the solve; `refined[ci]`
  // / `kList[ci]` are that solve's proposed / seed intrinsics per camera; `camIdxOf`
  // maps uuid → camera index in the solve.
  function fold({ label, solvedGroups, refined, kList, camIdxOf }) {
    let rebuiltImgs = 0,
      rebuiltShift = 0,
      rebuiltN = 0
    for (const [key, ci0] of solvedGroups) {
      const rk0 = refined[ci0],
        k0 = kList[ci0]
      const lensBefore = groupLens(key)
      // The solve fits the whole lens (bundleAdjust fullLens), so its terms ARE the lens.
      const lensAfter =
        lensBefore.kind === 'rational'
          ? lensBefore
          : lensBefore.kind === 'fisheye'
            ? { ...lensBefore, k1: rk0.k1 ?? 0, k2: rk0.k2 ?? 0, k3: rk0.k3 ?? 0, k4: rk0.k4 ?? 0 }
            : { kind: 'brown', k1: rk0.k1 ?? 0, k2: rk0.k2 ?? 0, k3: rk0.k3 ?? 0, p1: rk0.p1 ?? 0, p2: rk0.p2 ?? 0 }
      const changedLens = lensChanged(lensBefore, lensAfter)
      const rebuild = []
      for (const img of imgsBySelfCalGroup.get(key) ?? []) {
        const ci = camIdxOf.get(img.uuid)
        const k = Kmap.get(img.uuid)
        const own =
          ci != null
            ? refined[ci]
            : k && {
                fx: k.fx * (rk0.fx / k0.fx),
                fy: k.fy * (rk0.fy / k0.fy),
                cx: k.cx + (rk0.cx - k0.cx),
                cy: k.cy + (rk0.cy - k0.cy),
              }
        if (!own) continue
        const Kc = { fx: own.fx, fy: own.fy, cx: own.cx, cy: own.cy }
        // The view depends on K only through the lens: a lens-free image's view is its
        // record whatever its K.
        if (changedLens || (k && kChanged(k, Kc) && anyTerm(lensAfter))) rebuild.push({ img, Kc })
        if (k) Kmap.set(img.uuid, { ...k, ...Kc, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 })
      }
      if (changedLens) {
        lensByGroup.set(key, lensAfter)
        refinedLensGroups.add(key)
      }
      if (rebuild.length) {
        const r = rebuildViews(rebuild, lensAfter)
        rebuiltImgs += r.images
        rebuiltShift += r.shift
        rebuiltN += r.n
      }
    }
    if (rebuiltImgs > 0) {
      log(
        `${label} re-derived ${pluralize(rebuiltImgs, 'image')}' keypoints from the recorded pixels ` +
          `with the refined lens and K (mean change ${(rebuiltShift / Math.max(1, rebuiltN)).toFixed(2)}px)`,
        'info',
        'Reconstruction',
      )
    }
  }

  // The solved lens of every group a solve changed, as the run summary's
  // `selfCalDistortion` rows (runRecord.js assembleSummary documents the field). A row
  // is the group's WHOLE lens (`full`; a fisheye's also `fisheye`): it replaces the
  // sensor's for dense and the exports (displayFrame.js makeFrameModelResolver).
  function distortionSummary() {
    return [...refinedLensGroups].map((key) => {
      const img = imgsBySelfCalGroup.get(key)[0],
        lens = lensByGroup.get(key)
      const who = { sensorId: img.sensorId ?? null, ...(img.sensorId == null ? { imageUuid: img.uuid } : {}) }
      return lens.kind === 'fisheye'
        ? { ...who, full: true, fisheye: true, k1: lens.k1, k2: lens.k2, k3: lens.k3, k4: lens.k4, fitRmsPx: 0 }
        : { ...who, full: true, k1: lens.k1, k2: lens.k2, k3: lens.k3, p1: lens.p1, p2: lens.p2, fitRmsPx: 0 }
    })
  }

  return { groupOf: selfCalGroupOf, kFrameDims, fold, distortionSummary, lensOf, baLensOf }
}

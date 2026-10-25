// Self-calibration groups and the distortion fold (WS2) for one single-model run.
// Owns which images share a calibration (a sensor, or a sensorless image alone),
// each image's K-frame size, the pristine keypoint sets kept from before the first
// fold, and the composed {k1,k2,k3} bag per group that dense and the summary need.
// `fold()` is the destructive half of an accepted self-calibrating solve: it
// propagates the refined K to every image of a solved group (Kmap) and moves the
// radial terms into the keypoints and GCP marks, IN PLACE — `img.kp`, `Kmap` and the
// GCP observation objects are the run's own, seen by every other stage.
//
// createSelfCalFold(ctx) — ctx = {
//   imgs, cameras, Kmap, moveGcpObs, sensorIntByUuid, fiducialTransforms, log,
// }
// Created before registration: the interim BA self-calibrates f,k1 mid-registration
// (D3), so bundleSession.js's runBundleAdjust folds during the registration call.

import { undistortPixel, distortPixel, undistortKeypoint, distortionOf, coeffsForModel } from './distortion.js'
import { fitComposedRadialSets, radialCurveOk } from './selfCalCompose.js'
import { mapPositions } from './keypointSet.js'
import { undistortBrownPixels } from './reconstruction.js'
import { pluralize } from '../textFormat.js'

const xy = (p) => [p.x, p.y]
const kChanged = (a, b) => a.fx !== b.fx || a.fy !== b.fy || a.cx !== b.cx || a.cy !== b.cy
const lensChanged = (a, b) => a.k1 !== b.k1 || a.k2 !== b.k2 || a.k3 !== b.k3 || a.k4 !== b.k4

export function createSelfCalFold({ imgs, cameras, Kmap, moveGcpObs, sensorIntByUuid, fiducialTransforms, log }) {
  // Self-calibration group of an image: its sensor's (BA shares one focal scale,
  // principal-point offset and radial bag across a sensor), or — with no sensor — the
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
  // Fisheye lens per self-cal group: seeded from the sensor (distortionOf, plus how many
  // of its terms the sensor's model lets self-calibration refine), replaced by every
  // accepted solve that refines its k terms (fold). Every consumer — the BA's
  // recorded-pixel observations (bundleSession.js), the fold, the summary dense reads —
  // takes it from here, so all of them see the same lens at every point of the run.
  const lensByGroup = new Map() // group key → fisheye lens bag, or null (not a fisheye)
  const refinedLensGroups = new Set() // groups whose lens self-calibration has changed
  const imgByUuid = new Map(imgs.map((img) => [img.uuid, img]))
  function groupLens(key) {
    if (!lensByGroup.has(key)) {
      const img = imgsBySelfCalGroup.get(key)?.[0]
      const dist = distortionOf(img?.sensor)
      lensByGroup.set(key, dist?.fisheye ? { ...dist, terms: coeffsForModel(img.sensor.distortionModel).length } : null)
    }
    return lensByGroup.get(key)
  }
  const lensOf = (uuid) => (imgByUuid.has(uuid) ? groupLens(selfCalGroupOf(uuid)) : null)

  // An image's size in K's pixel frame — what the self-cal guards measure the
  // principal point and corners against. A film scan's K lives in the fiducial
  // canonical frame (ingest.js applyFiducialFrames), not in its scan pixels.
  // 0 × 0 when unknown.
  const kFrameDims = (img) => {
    const frame = img ? fiducialTransforms.get(img.uuid)?.frame : null
    if (frame) return { width: frame.width, height: frame.height }
    return { width: img?.meta?.width ?? img?.width ?? 0, height: img?.meta?.height ?? img?.height ?? 0 }
  }

  // Self-calibrated distortion bookkeeping (WS2). The sparse pipeline folds the
  // distortion out of the keypoints each self-cal pass (exact, in place); dense and
  // the run summary need ONE composed {k1,k2,k3} bag per self-cal group (a sensor, or
  // a sensorless image) to reproduce that fold on the rasters. `pristineKpByUuid`
  // keeps each eligible image's keypoint set from *before the first fold* (post-ingest
  // = pristine) — a reference, free because sets are immutable (keypointSet.js) — and
  // `selfCalDistByGroup` holds the composed bag fitted from pristine→folded about each
  // image's current K (selfCalCompose.js), refitted whenever a BA changes that K —
  // replacing the old additive-k1 sum, which was wrong beyond first order.
  const pristineKpByUuid = new Map() // uuid → KeypointSet before the first fold
  const foldedTermsByGroup = new Map() // group key → { k2, k3 } ever folded into its keypoints
  const selfCalDistByGroup = new Map() // group key → { sensorId, imageUuid, k1, k2, k3, fitRmsPx }

  // ── Propagate the refined calibration + fold distortion into the keypoints (WS2) ──
  // A refined calibration belongs to the whole group, not just the cameras that were
  // in this solve: Kmap (what every later PnP resects with, and the K a camera
  // registers with) is updated for EVERY image of a solved group, whatever the mode.
  // Updating it only alongside a k1 fold left focal-only / principal-point-only
  // self-cal ('f', 'f,cxcy', the rescue's 'f', 'auto' cut back to 'f') on the
  // registered cameras alone; later registrations took the nominal K, and the crate's
  // per-group focal SCALE then kept the two sets apart for the rest of the run.
  // Each image gets its OWN refined K: the crate keeps per-camera seed differences
  // (fx = s·fx0_c, cx = cx0_c + dcx), so a camera in this solve takes its output and
  // one outside it the group's update applied to its own K.
  //
  // BA also estimates shared radial coeffs (k1,k2,k3), but the rest of the pipeline is
  // pure pinhole (projectPoint, the track filter, reprojection stats, the dense/ortho
  // warp) — coeffs left on the model would be invisible to all of them. So we
  // re-undistort the observations with the full estimated bag (exactly what ingest
  // does with the sensor's coefficients) and keep the model radial coeffs at 0 (the
  // pinhole invariant, set at commit in runBundleAdjust). BA's forward model is the
  // inverse of undistortPixel with the same bag about the same per-camera K, so the
  // in-place fold is exact; the next self-cal pass estimates only the residual on the
  // already-folded keypoints. A sensorless camera is its own group and folds alike.
  //
  // cx/cy stay ON K (not folded) — projectPoint reads them; only the radial terms
  // move into the keypoints. For dense + the summary we need ONE composed {k1,k2,k3}
  // bag per group, fitted from the pristine (pre-fold) keypoints to their folded
  // positions (selfCalCompose.js) — correct across multiple passes, unlike the old
  // additive-k1 sum — and refitted about the new K after every refining solve, so a
  // later pass that moves f or cx/cy without k1 cannot leave it stale.
  //
  // One call per committed solve that refined at least one group: `solvedGroups` maps
  // each refined group key → the index of its first camera in the solve; `refined[ci]`
  // / `kList[ci]` are that solve's proposed / seed intrinsics per camera; `camIdxOf`
  // maps uuid → camera index in the solve.
  function fold({ label, refineMode, solvedGroups, refined, kList, camIdxOf }) {
    // Terms already baked into the keypoints by an EARLIER pass stay in the
    // composed bag even when this pass refines fewer (the staged schedule and
    // the identifiability guard can drop k2/k3 later): fitting only the current
    // pass's terms would silently erase them from what dense reproduces.
    const passTerms = { k2: refineMode.includes('k2'), k3: refineMode.includes('k3') }
    let foldedImgs = 0,
      foldedShift = 0,
      foldedN = 0,
      refitFisheye = 0
    for (const [key, ci0] of solvedGroups) {
      const rk0 = refined[ci0],
        k0 = kList[ci0]
      // A fisheye group's k terms are its own lens, solved in recorded pixels: it
      // never folds a Brown bag, it takes the new lens (fisheyeFold below).
      const lensBefore = groupLens(key)
      const lensAfter = lensBefore && {
        ...lensBefore,
        k1: rk0.k1 ?? lensBefore.k1,
        k2: rk0.k2 ?? lensBefore.k2,
        k3: rk0.k3 ?? lensBefore.k3,
        k4: rk0.k4 ?? lensBefore.k4,
      }
      const bag = lensBefore ? { k1: 0, k2: 0, k3: 0 } : { k1: rk0.k1 || 0, k2: rk0.k2 || 0, k3: rk0.k3 || 0 }
      const folds = !!(bag.k1 || bag.k2 || bag.k3)
      const toFold = [] // { img, Kc }: the group's images whose keypoints take the bag
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
        // Fold EVERY image on a solved group — not just the registered ones. When
        // this runs during registration, the next candidate to resect must already
        // have undistorted keypoints + a pinhole Kmap or its PnP re-applies the
        // now-removed distortion.
        if (folds && img.kp?.n) {
          // Keep the pristine (post-ingest, pre-first-fold) set once, so the
          // composed fit below always maps pristine → fully-folded.
          if (!pristineKpByUuid.has(img.uuid)) pristineKpByUuid.set(img.uuid, img.kp)
          toFold.push({ img, Kc })
        }
        // A fisheye image's keypoints are its recorded pixels undistorted about its K
        // and lens; the dense/ortho sample map pairs the CURRENT K with the current
        // lens, so a changed f, cx,cy or k must re-derive them (old K + lens → the
        // recorded pixel → new K + lens) or the rasters would no longer match the model.
        if (lensBefore && k && img.kp?.n && (kChanged(k, Kc) || lensChanged(lensBefore, lensAfter))) {
          const remap = (x, y) => undistortKeypoint(...xy(distortPixel(x, y, k, lensBefore)), Kc, lensAfter)
          img.kp = mapPositions(img.kp, remap)
          moveGcpObs(img.uuid, (x, y) => undistortPixel(...xy(distortPixel(x, y, k, lensBefore)), Kc, lensAfter))
          refitFisheye++
        }
        if (k) Kmap.set(img.uuid, { ...k, ...Kc, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 })
      }
      if (toFold.length) {
        const acc = foldKeypoints(toFold, bag, { shift: foldedShift, n: foldedN })
        foldedShift = acc.shift
        foldedN = acc.n
        foldedImgs += toFold.length
      }
      if (lensBefore && lensChanged(lensBefore, lensAfter)) {
        lensByGroup.set(key, lensAfter)
        refinedLensGroups.add(key)
      }
      if (folds) {
        const ever = foldedTermsByGroup.get(key) ?? { k2: false, k3: false }
        foldedTermsByGroup.set(key, {
          k2: ever.k2 || (passTerms.k2 && !!bag.k2),
          k3: ever.k3 || (passTerms.k3 && !!bag.k3),
        })
      }
      if (foldedTermsByGroup.has(key)) composeSelfCalRecord(key, label)
    }
    if (refitFisheye > 0) {
      log(
        `${label} re-mapped ${pluralize(refitFisheye, 'fisheye image')}' keypoints onto the refined lens / focal / principal point`,
        'info',
        'Reconstruction',
      )
    }
    if (foldedImgs > 0) {
      log(
        `${label} folded self-calibrated distortion into ${pluralize(foldedImgs, 'image')}' ` +
          `keypoints (mean shift ${(foldedShift / Math.max(1, foldedN)).toFixed(2)}px; model stays pinhole)`,
        'info',
        'Reconstruction',
      )
    }
  }

  // Undistort the keypoints and GCP marks of `toFold` ([{ img, Kc }], one group) through
  // `bag`, each about its own K, in place. The whole group goes to the crate in one call
  // (its thread pool in the threaded build); the JS path is the same arithmetic, used
  // before the wasm has loaded. `acc` = { shift, n }: the run's summed keypoint shift (px)
  // and count so far, returned with this group's points added in order.
  function foldKeypoints(toFold, bag, acc) {
    let shift = acc.shift,
      n = acc.n
    let total = 0
    for (const { img } of toFold) total += img.kp.n
    const xy = new Float64Array(2 * total),
      starts = new Uint32Array(toFold.length + 1),
      kk = new Float64Array(4 * toFold.length)
    toFold.forEach(({ img, Kc }, i) => {
      xy.set(img.kp.xy.subarray(0, 2 * img.kp.n), 2 * starts[i])
      starts[i + 1] = starts[i] + img.kp.n
      kk.set([Kc.fx, Kc.fy, Kc.cx, Kc.cy], 4 * i)
    })
    const out = undistortBrownPixels(xy, starts, kk, bag)
    toFold.forEach(({ img, Kc }, i) => {
      const set = img.kp
      if (out) {
        // The crate's points, as mapPositions would set them (a missing point stays NaN).
        const src = set.xy,
          xy = out.slice(2 * starts[i], 2 * starts[i + 1])
        for (let j = 0; j < set.n; j++) {
          // eslint-disable-next-line no-self-compare
          if (src[2 * j] !== src[2 * j]) continue // a missing point
          shift += Math.hypot(xy[2 * j] - src[2 * j], xy[2 * j + 1] - src[2 * j + 1])
          n++
        }
        img.kp = { n: set.n, xy, rgb: set.rgb, hasColor: set.hasColor }
      } else {
        img.kp = mapPositions(set, (x, y) => {
          const u = undistortPixel(x, y, Kc, bag)
          shift += Math.hypot(u.x - x, u.y - y)
          n++
          return u
        })
      }
      moveGcpObs(img.uuid, (x, y) => undistortPixel(x, y, Kc, bag))
    })
    return { shift, n }
  }

  // A folded group's composed self-cal record — the net pristine → folded map of its
  // keypoints — about each image's CURRENT K, which is what dense, the exports and the
  // GCP tools pair it with (stores/reconstruction/dense.js: the camera K + this bag must
  // reproduce the sparse fold). The fold calls this after every solve that refined the
  // group's intrinsics, so the record follows f / cx,cy changes made by passes that fold
  // nothing themselves. Only the run summary reads the record, and each call replaces
  // the last, so the call keeps its inputs (the keypoint sets are immutable, K is
  // copied) and the fit over every keypoint of the group runs once, for the last of
  // them (settleRecords): it was ~0.4 s per self-calibrating solve on 2.5 M keypoints.
  const pendingRecords = new Map() // group key → the last call's inputs, not yet fitted
  function composeSelfCalRecord(key, label) {
    const gimgs = imgsBySelfCalGroup.get(key) ?? []
    const setPairs = []
    let maxNormR = 0
    for (const img of gimgs) {
      const pristine = pristineKpByUuid.get(img.uuid)
      const K = cameras.get(img.uuid)?.K ?? Kmap.get(img.uuid)
      if (!pristine || !K) continue
      setPairs.push({ pristine, folded: img.kp, K: { fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy } })
      const { width, height } = kFrameDims(img)
      const w = width || 2 * K.cx,
        h = height || 2 * K.cy
      maxNormR = Math.max(maxNormR, Math.hypot(Math.max(K.cx, w - K.cx) / K.fx, Math.max(K.cy, h - K.cy) / K.fy))
    }
    if (!setPairs.length) return
    pendingRecords.set(key, { setPairs, maxNormR, terms: foldedTermsByGroup.get(key), label })
  }

  // Fit the records still pending, in the order the groups were first composed.
  function settleRecords() {
    for (const [key, { setPairs, maxNormR, terms, label }] of pendingRecords) {
      // Pool all group keypoints (each about its own K) for a well-constrained fit.
      const composed = fitComposedRadialSets(setPairs, setPairs[0].K, terms)
      // Guard: sample the composed radial map to the image corner; a non-monotonic
      // curve or a runaway corner shift means the higher-order fit overfit. Warn
      // (staged gating makes this rare) so a bad calibration is visible in the log.
      const guard = radialCurveOk(composed, maxNormR, setPairs[0].K.fx)
      if (!guard.ok) {
        log(
          `${label} self-cal composed radial fit looks unreliable — ${guard.reason}; ` +
            `dense will use it as-is but review the calibration`,
          'warn',
          'Reconstruction',
        )
      }
      const gimgs = imgsBySelfCalGroup.get(key)
      const sensorId = gimgs[0].sensorId ?? null
      selfCalDistByGroup.set(key, {
        sensorId,
        imageUuid: sensorId == null ? gimgs[0].uuid : null,
        k1: composed.k1,
        k2: composed.k2,
        k3: composed.k3,
        fitRmsPx: composed.fitRmsPx,
      })
    }
    pendingRecords.clear()
  }

  // The composed bags with any non-zero term, as the run summary's `selfCalDistortion`
  // rows (runRecord.js assembleSummary documents the field).
  // A fisheye group whose lens self-calibration changed adds a `fisheye: true` row: the
  // whole refined lens, which REPLACES the sensor's for dense and the exports
  // (displayFrame.js makeFrameModelResolver) instead of composing on top of it.
  function distortionSummary() {
    settleRecords()
    return [
      ...[...selfCalDistByGroup.values()]
        .filter((d) => d.k1 || d.k2 || d.k3)
        .map((d) => ({
          sensorId: d.sensorId,
          ...(d.imageUuid ? { imageUuid: d.imageUuid } : {}),
          k1: d.k1,
          k2: d.k2,
          k3: d.k3,
          fitRmsPx: d.fitRmsPx,
        })),
      ...[...refinedLensGroups].map((key) => {
        const img = imgsBySelfCalGroup.get(key)[0],
          lens = lensByGroup.get(key)
        return {
          sensorId: img.sensorId ?? null,
          ...(img.sensorId == null ? { imageUuid: img.uuid } : {}),
          fisheye: true,
          k1: lens.k1,
          k2: lens.k2,
          k3: lens.k3,
          k4: lens.k4,
          fitRmsPx: 0,
        }
      }),
    ]
  }

  return { groupOf: selfCalGroupOf, kFrameDims, fold, distortionSummary, lensOf }
}

// SfM ingest (pure): everything that moves keypoints ONCE, before reconstruction
// starts, so the rest of the pipeline is pinhole in one pixel frame per sensor.
// Lifted verbatim from sfm.js `reconstructSingleModel`, in the order it runs there:
//   1. applyFiducialFrames  — film scans: scan px → one canonical frame per sensor
//   2. resolveIntrinsics    — one K per image (after 1: film K comes from the frame)
//   3. gcpObservationMover  — GCP marks follow every keypoint move (here and the
//                             self-cal fold later)
//   4. undistortAtIngest    — calibrated Brown–Conrady removed from the keypoints
//   5. refitMovedPairs      — matching's F was fitted on the raw keypoints
// Each mutates the images / GCPs / pairs it is given, as the inline code did; the
// caller's `input` is already this sub-run's own copy (sfm.js cloneSfmInput).

import { resolveK } from './reconstruction.js'
import { undistortPixel, distortionOf } from './distortion.js'
import { fitFundamental, sampsonRmsPx } from './fundamental.js'
import { fitFiducialAffine, canonicalFrame, scanToCanonical } from './fiducials.js'
import { calibratedFiducialPairs } from './fiducialModel.js'
import { mapPositions, kpX, kpY } from './keypointSet.js'
import { asPairList } from './matchCodec.js'
import { fitFiducialTransform } from './fiducialCalibration.js'

// ── Fiducial interior orientation (F4) ───────────────────────────────────
// Scanned film: fit each image's scan→mm affine from its clicked fiducial
// marks, build ONE canonical pixel frame per sensor (median fitted pitch),
// and move that image's keypoints into the frame. This is the exact analogue
// of the distortion undistort below — scan geometry removed once at ingest,
// keypoint indices preserved (matches reference them), so the whole pipeline
// stays pinhole with one shared K per sensor. resolveK then returns the
// canonical K via `sensor._fiducialK` (path 0). Runs BEFORE the K-map so the
// resolveK below sees the stashed frame.
// Returns uuid → { A, transform, frame } for every film image it moved.
export function applyFiducialFrames({ imgs, gcps, log }) {
  const fiducialTransforms = new Map() // uuid → { A, frame }
  {
    const filmGroups = new Map() // sensorId → [{ img, fit }]
    for (const img of imgs) {
      const s = img.sensor
      const cal = s?.fiducialCalibration
      const legacy = s?.fiducials
      if (s?.kind !== 'film' || !(cal?.marks?.length || legacy?.marks?.length)) continue
      const obs = calibratedFiducialPairs(img, s)
      const fit = cal ? fitFiducialTransform(obs, cal.transform || 'affine') : fitFiducialAffine(obs)
      if (!fit) {
        log(`${img.name} — fiducial fit failed (${obs.length} usable mark(s), `
          + `need ≥3); falling back to standard intrinsics`, 'warn', 'Reconstruction')
        continue
      }
      const pitchUm = fit.pitchMm * 1000
      log(`${img.name} — fiducial ${cal?.transform || 'affine'} fit: pitch ${pitchUm.toFixed(2)}µm/px, `
        + `${fit.rotDeg == null ? '' : `rot ${fit.rotDeg.toFixed(2)}°, shear ${fit.shear.toFixed(4)}, `}RMS ${fit.rmsUm.toFixed(1)}µm`,
        'info', 'Reconstruction')
      if (fit.rmsUm > 0.5 * pitchUm) {
        log(`${img.name} — fiducial residual ${fit.rmsUm.toFixed(1)}µm exceeds `
          + `½ pixel (${(0.5 * pitchUm).toFixed(1)}µm) — check the clicked marks`, 'warn', 'Reconstruction')
      }
      const sid = img.sensorId ?? '__nosensor__'
      if (!filmGroups.has(sid)) filmGroups.set(sid, [])
      filmGroups.get(sid).push({ img, fit, calibration: cal || legacy })
    }
    for (const [sid, entries] of filmGroups) {
      const pitches = entries.map((e) => e.fit.pitchMm).sort((a, b) => a - b)
      const pitchMm = pitches[Math.floor(pitches.length / 2)] // median: one frame doesn't chase a single scan
      const fiducials = entries[0].calibration
      // Orientation of scan→mm: a y-up certificate against y-down scan rows is a
      // reflection (det < 0). The canonical frame must undo it or the whole model
      // comes out mirrored (see canonicalFrame). Majority vote over the batch.
      const reflected = entries.filter(({ fit }) => {
        const h = fit.forward ?? null, A = fit.A ?? null
        const det = h ? h[0] * h[4] - h[1] * h[3] : A ? A[0] * A[4] - A[1] * A[3] : NaN
        return det < 0
      }).length
      const yUp = reflected * 2 > entries.length
      if (yUp) {
        log(`sensor ${sid} — fiducial coordinates are y-up against y-down scan rows; `
          + 'the canonical frame flips y so the camera stays proper (not mirrored)', 'info', 'Reconstruction')
      }
      const frame = canonicalFrame(fiducials, pitchMm, { yUp })
      if (!frame) {
        log(`sensor ${sid} — could not build canonical frame (need ≥3 marks); `
          + `film images fall back to standard intrinsics`, 'warn', 'Reconstruction')
        continue
      }
      const source = `fiducial interior orientation (${fiducials.focalMm}mm ÷ ${(pitchMm * 1000).toFixed(2)}µm/px)`
      log(`sensor ${sid} — canonical frame ${frame.width}×${frame.height}px, `
        + `K fx=${frame.K.fx.toFixed(1)} cx=${frame.K.cx.toFixed(1)} cy=${frame.K.cy.toFixed(1)} `
        + `(median pitch ${(pitchMm * 1000).toFixed(2)}µm/px over ${entries.length} image(s))`,
        'info', 'Reconstruction')
      for (const { img, fit } of entries) {
        const scanTransform = fit.forward ? fit : fit.A
        img.sensor._fiducialK = { fx: frame.K.fx, fy: frame.K.fy, cx: frame.K.cx, cy: frame.K.cy, source }
        if (img.kp?.n) img.kp = mapPositions(img.kp, (x, y) => scanToCanonical(x, y, scanTransform, frame))
        fiducialTransforms.set(img.uuid, { A: fit.A ?? null, transform: fit.forward ? fit : null, frame })
      }
    }
    // GCP observations are in scan space too — push film-image observations
    // through the same scan→canonical map, or their reprojection residuals
    // explode only on film projects (they meet the same camera K downstream).
    if (fiducialTransforms.size && gcps.length) {
      let remapped = 0
      for (const g of gcps) {
        for (const o of g.observations || []) {
          const t = fiducialTransforms.get(o.uuid)
          if (!t) continue
          const c = scanToCanonical(o.px, o.py, t.transform ?? t.A, t.frame)
          o.px = c.x; o.py = c.y; remapped++
        }
      }
      if (remapped) {
        log(`remapped ${remapped} GCP observation(s) on film images `
          + `into the canonical frame`, 'info', 'Reconstruction')
      }
    }
  }
  return fiducialTransforms
}

// ── Build K map ────────────────────────────────────────────────────────
// `intrinsicsRecord` (sensorId → run-record row) gets each sensor's nominal focal.
export function resolveIntrinsics({ imgs, intrinsicsRecord, log }) {
  const Kmap = new Map() // uuid → K
  let defaultKCount = 0
  const ppWarned = new Set() // sensorId (or uuid) already warned about an off-centre principal point
  for (const img of imgs) {
    const K = resolveK(img.meta, img.sensor)
    Kmap.set(img.uuid, K)
    if (K.source.startsWith('default')) defaultKCount++
    // Nominal focal per sensor, before any self-calibration touches it — the
    // "from" half of the fx trajectory the digest reports (B4: 2389 → 2566 is a
    // healthy run, 2389 → 4796 is a runaway, and only the pair distinguishes them).
    const sid = img.sensorId ?? `image:${img.uuid}`
    if (!intrinsicsRecord.has(sid)) {
      intrinsicsRecord.set(sid, {
        sensorId: img.sensorId ?? null, label: img.sensor?.label ?? null,
        fxNominal: K.fx, source: K.source, fxFinal: null, cx: null, cy: null,
      })
    }
    const implied = K.impliedFilmWidthMm != null
      ? ` [implies ${K.impliedFilmWidthMm.toFixed(0)}mm film width]` : ''
    log(`K[${img.name}] fx=${K.fx.toFixed(1)} fy=${K.fy.toFixed(1)} `
      + `cx=${K.cx.toFixed(1)} cy=${K.cy.toFixed(1)} — ${K.source}${implied}`,
      'debug', 'Reconstruction')
    // A real principal point sits within a few % of the image centre. A cx/cy
    // far outside that is virtually always a convention mix-up — Metashape and
    // friends export cx/cy as OFFSETS from the centre, while websfm's sensor
    // table takes absolute pixels. Warn once per sensor, loudly: a corner
    // principal point silently destroys every downstream geometry gate.
    const iw = img.sensor?.width || img.meta?.width
    const ih = img.sensor?.height || img.meta?.height
    if (iw && ih && (Math.abs(K.cx - iw / 2) > 0.05 * iw || Math.abs(K.cy - ih / 2) > 0.05 * ih)) {
      const key = img.sensorId ?? img.uuid
      if (!ppWarned.has(key)) {
        ppWarned.add(key)
        log(`principal point cx=${K.cx.toFixed(1)} cy=${K.cy.toFixed(1)} is far from `
          + `the image centre (${(iw / 2).toFixed(0)}, ${(ih / 2).toFixed(0)}) — the sensor table takes `
          + `ABSOLUTE pixels. If this calibration came from Metashape (which reports centre offsets), `
          + `enter ${(iw / 2).toFixed(1)} + cx and ${(ih / 2).toFixed(1)} + cy instead.`,
          'warn', 'Reconstruction')
      }
    }
    // The pixel-pitch path can silently produce an off-standard film width (a
    // ~9% focal error on the CA…V set). Flag it so the user checks pitch/format.
    if (K.impliedFilmWidthMm != null && K.filmWidthOk === false) {
      log(`K[${img.name}] implied film width ${K.impliedFilmWidthMm.toFixed(0)}mm `
        + `is not a standard aerial format (~230/240mm) — check the scan pixel pitch, or use the `
        + `film/sensor-format (mm) field instead of pixel size.`, 'warn', 'Reconstruction')
    }
  }
  return { Kmap, defaultKCount }
}

// GCP marks meet the same cameras as the keypoints, so they must live in the
// same frame: whatever moves an image's keypoints (calibrated undistortion
// here, the self-cal fold later) moves that image's marks too. Otherwise the
// anchored BA pulls the model toward raw-lens marks at σ≈1 px.
// Returns moveGcpObs(uuid, map): apply a pixel map to that image's GCP marks.
export function gcpObservationMover(gcps) {
  const gcpObsByUuid = new Map()
  for (const g of gcps) {
    for (const o of g.observations || []) {
      if (o.uuid == null || !Number.isFinite(o.px) || !Number.isFinite(o.py)) continue
      if (!gcpObsByUuid.has(o.uuid)) gcpObsByUuid.set(o.uuid, [])
      gcpObsByUuid.get(o.uuid).push(o)
    }
  }
  const moveGcpObs = (uuid, map) => {
    for (const o of gcpObsByUuid.get(uuid) || []) { const u = map(o.px, o.py); o.px = u.x; o.py = u.y }
  }
  return moveGcpObs
}

// ── Undistort keypoints at ingest ────────────────────────────────────────
// Remove Brown–Conrady lens distortion once, up front, so every downstream
// step (init, PnP, triangulation, BA) is pure pinhole. Keypoint indices are
// preserved (matches reference them), only positions move.
export function undistortAtIngest({ imgs, Kmap, moveGcpObs, log }) {
  let undistortedImgs = 0
  let anyCalibratedDistortion = false
  const undistortedUuids = new Set()
  let shiftSum = 0, shiftMax = 0, shiftN = 0
  for (const img of imgs) {
    const dist = distortionOf(img.sensor)
    if (!dist || !img.kp?.n) continue
    anyCalibratedDistortion = true
    const K = Kmap.get(img.uuid)
    img.kp = mapPositions(img.kp, (x, y) => {
      const u = undistortPixel(x, y, K, dist)
      const d = Math.hypot(u.x - x, u.y - y)
      shiftSum += d; if (d > shiftMax) shiftMax = d; shiftN++
      return u
    })
    moveGcpObs(img.uuid, (x, y) => undistortPixel(x, y, K, dist))
    undistortedImgs++
    undistortedUuids.add(img.uuid)
  }
  if (undistortedImgs > 0) {
    log(`undistorted keypoints on ${undistortedImgs}/${imgs.length} image(s) `
      + `(lens distortion removed at ingest — pipeline stays pinhole; `
      + `mean shift ${(shiftSum / Math.max(1, shiftN)).toFixed(2)}px, max ${shiftMax.toFixed(2)}px)`,
      'info', 'Reconstruction')
  }
  return { anyCalibratedDistortion, undistortedUuids }
}

// ── Re-fit pairwise F on the moved keypoints ─────────────────────────────
// Each pair's F was fitted during matching, on RAW (distorted / scan-space)
// keypoints. Everything that reads e.F — the init pair's essential
// decomposition — would otherwise keep
// operating on the stale geometry, which for a wide-angle lens (tens of px of
// displacement) systematically bends every relative rotation. The stored
// matches are already RANSAC inliers, so a trimmed least-squares 8-point on
// the moved coordinates is enough — no re-RANSAC. Applies to both keypoint
// moves above: Brown undistortion and the film scan→canonical affine.
// `movedUuids`: the images whose keypoints moved (undistortion + film frames).
export function refitMovedPairs({ donePairs, movedUuids, imageByUuid, log }) {
  if (movedUuids.size > 0) {
    let refit = 0, skipped = 0
    const before = [], after = []
    for (const e of donePairs) {
      if (!e.F) continue
      if (!movedUuids.has(e.idA) && !movedUuids.has(e.idB)) continue
      const iA = imageByUuid(e.idA), iB = imageByUuid(e.idB)
      if (!iA || !iB || (e.matches?.length ?? 0) < 8) { skipped++; continue }
      const m = asPairList(e.matches)
      const ptsA = new Array(m.length), ptsB = new Array(m.length)
      for (let i = 0; i < m.length; i++) {
        ptsA[i] = { x: kpX(iA.kp, m.a(i)), y: kpY(iA.kp, m.a(i)) }
        ptsB[i] = { x: kpX(iB.kp, m.b(i)), y: kpY(iB.kp, m.b(i)) }
      }
      const fit = fitFundamental(ptsA, ptsB)
      if (!fit) { skipped++; continue }
      before.push(sampsonRmsPx(e.F, ptsA, ptsB))
      e.F = fit.F
      after.push(fit.rmsPx)
      refit++
    }
    if (refit > 0) {
      const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1]
      log(`re-fitted F on undistorted keypoints for ${refit} pair(s)`
        + `${skipped ? ` (${skipped} skipped)` : ''} — median epipolar RMS `
        + `${med(before).toFixed(2)}px → ${med(after).toFixed(2)}px (stale distorted-space fit replaced)`,
        'info', 'Reconstruction')
    }
  }
}

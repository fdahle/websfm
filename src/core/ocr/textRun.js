// Planning an Auto Mask ▸ Text run (composables/useTextMask.js): how many workers read
// at once, what of a photo's text is kept on its record, the coordinates a camera's
// frames share, and the regions masked on each photo. Pure.

import { calibratedFiducialPairs } from '../sfm/fiducialModel.js'
import { fitFiducialTransform, applyFiducialTransform, invertFiducialTransform } from '../sfm/fiducialCalibration.js'
import { markToCentrePx, centreToMarkPx } from '../sfm/pixelConvention.js'
import { OCR_TUNING } from '../tuning.js'
import {
  isSureText,
  isTextCandidate,
  linePolygon,
  recurringBoxes,
  mappedBox,
  boxPolygon,
  coveredShare,
} from './textMask.js'
import { growPolygon } from './quad.js'

// Names the models and the scale text is read at: text stored on a photo by another
// engine is read again (stores/images/photoText.js).
export const OCR_ENGINE = `ppocrv5-mobile-en@${OCR_TUNING.detMaxDim}`

// What one OCR job holds: the ONNX Runtime heap a 960 px tile grows to (about 150 MB
// over the runtime's own, measured in Node), plus the raster at the detection size as
// RGBA, grey, the probability map and the region labels.
const OCR_SESSION_BYTES = 300 * 1024 ** 2
const OCR_BYTES_PER_PX = 4 + 1 + 4 + 8

/** Workers that read at once within `budgetBytes` (at least 1, at most the pool). */
export function ocrConcurrency(count, poolSize, budgetBytes, maxDim = OCR_TUNING.detMaxDim) {
  const perJob = OCR_SESSION_BYTES + maxDim * maxDim * OCR_BYTES_PER_PX
  return Math.max(1, Math.min(poolSize, count, Math.floor(budgetBytes / perJob)))
}

const r1 = (v) => Math.round(v * 10) / 10
const r2 = (v) => Math.round(v * 100) / 100

/**
 * The lines kept on a photo's record: those that may be text, quads to 0.1 px, scores
 * to 0.01. Detector boxes that read as nothing are left out (a town can give hundreds).
 */
export function compactLines(lines) {
  return lines.filter(isTextCandidate).map((l) => ({
    quad: l.quad.map(([x, y]) => [r1(x), r1(y)]),
    text: l.text,
    score: r2(l.textScore),
    angle: l.angle ?? 0,
  }))
}

/** Stored lines back in the shape the mask rules read (`textScore`). */
export function storedToLines(stored) {
  return (stored ?? []).map((l) => ({ quad: l.quad, text: l.text, textScore: l.score, angle: l.angle }))
}

/**
 * The coordinates a photo shares with the other frames of its camera: film mm through
 * its fiducial fit when the camera is calibrated and the fit succeeds, else the
 * fraction of the photo. `{ film: { to, from } | null, fraction: { to, from } }`, each
 * mapping [x, y] native px ↔ shared.
 */
export function sharedCoords(image, sensor, natW, natH) {
  const fraction = {
    to: ([x, y]) => [x / natW, y / natH],
    from: ([u, v]) => [u * natW, v * natH],
  }
  let film = null
  const cal = sensor?.fiducialCalibration
  if (sensor?.kind === 'film' && cal?.marks?.length) {
    const fit = fitFiducialTransform(calibratedFiducialPairs(image, sensor), cal.transform || 'affine', {
      spacingMm: cal.reseau?.spacingMm,
    })
    if (fit) {
      // The fit maps pixel-centre coordinates; text quads are continuous ones, as a
      // fiducial mark is stored (sfm/pixelConvention.js).
      film = {
        to: ([x, y]) => {
          const p = applyFiducialTransform({ x: markToCentrePx(x), y: markToCentrePx(y) }, fit)
          return p ? [p.x, p.y] : [NaN, NaN]
        },
        from: ([u, v]) => {
          const p = invertFiducialTransform({ x: u, y: v }, fit)
          return p ? [centreToMarkPx(p.x), centreToMarkPx(p.y)] : [NaN, NaN]
        },
      }
    }
  }
  return { film, fraction }
}

// A photo whose text regions would cover more than this is not masked: the detector
// misfired (a print over the whole scan, a test chart), and the run says so.
export const MAX_TEXT_SHARE = 0.5

/**
 * The regions to mask on each photo. `frames`: `[{ id, natW, natH, camera, lines,
 * shared }]` with lines in native px (storedToLines) and `shared` from sharedCoords.
 * Sure text is masked where it was found; with `recurring`, text that recurs on a
 * camera's frames (textMask.recurringBoxes, in film mm when every frame of the camera
 * has a fiducial fit, else in fractions of the photo) on every frame of it. All grown
 * by `padPx`. Returns Map id → `{ polygons, sure, recurring, share, skipped }`.
 */
export function textMaskPlan(frames, { padPx = 0, recurring = true, minShare = 0.2 } = {}) {
  const out = new Map()
  for (const f of frames) {
    const sure = f.lines.filter(isSureText).map((l) => linePolygon(l, padPx))
    out.set(f.id, { polygons: sure, sure: sure.length, recurring: 0 })
  }
  if (recurring) {
    const byCamera = new Map()
    for (const f of frames) {
      const key = f.camera ?? `${f.natW}x${f.natH}`
      if (!byCamera.has(key)) byCamera.set(key, [])
      byCamera.get(key).push(f)
    }
    for (const group of byCamera.values()) {
      const useFilm = group.every((f) => f.shared?.film)
      const coords = (f) => (useFilm ? f.shared.film : f.shared.fraction)
      const boxes = recurringBoxes(
        group.map((f) => ({
          id: f.id,
          boxes: f.lines
            .filter(isTextCandidate)
            .map((l) => mappedBox(l.quad, coords(f).to))
            .filter((b) => b.every(Number.isFinite)),
        })),
        minShare,
      )
      for (const f of group) {
        const entry = out.get(f.id)
        for (const box of boxes) {
          const poly = boxPolygon(box, coords(f).from)
          if (!poly.flat().every(Number.isFinite)) continue
          entry.polygons.push(growPolygon(poly, padPx))
          entry.recurring++
        }
      }
    }
  }
  for (const f of frames) {
    const entry = out.get(f.id)
    entry.share = coveredShare(entry.polygons, f.natW, f.natH)
    entry.skipped = entry.share > MAX_TEXT_SHARE
  }
  return out
}

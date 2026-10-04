// Batch consistency for anonymous fiducial detection.
//
// A flight's scans come off the same camera, so a given slot's mark sits at
// essentially the same place in every frame. Anything else near that slot does
// not: the TMA data strip (clock faces, annotation blocks) moves image to image,
// and a mark-shaped blob in it can out-score the real mark on a single scan —
// measured at 60 px off, accepted with a healthy-looking ZNCC score. No per-image
// gate can see that, exactly as no per-pixel cost gate can see vegetation in dense
// MVS: the evidence is cross-image disagreement, not a weak local score.
//
// So this runs once over the whole batch, after every image is detected, and
// demotes disagreeing marks to the review queue rather than dropping them — the
// batch is the second opinion, not the authority.
//
// Two invariants:
//  1. Evidence comes from the UNFILTERED set. Every slot's consensus position is
//     computed before anything is demoted, so image i is never judged against a
//     set that image i−1's rejection already thinned (that would make the result
//     depend on image order, the trap `filterDepthMapsGeometric` documents).
//  2. ONE normalisation basis for the whole batch. Frame-relative coordinates are
//     immune to a scan sitting a few hundred px off on the platen, but a batch
//     where only some rows have a usable film frame must not mix the two bases —
//     the comparison would be meaningless. All-or-nothing, decided up front.

import { FIDUCIAL_DETECTION_TUNING } from './fiducialDetection.js'

export const FIDUCIAL_CONSENSUS_TUNING = {
  // Below this the median is not evidence, it is a coin flip. A 3-image batch
  // with one bad mark has a 1-in-3 chance of the bad mark BEING the median.
  minImages: 4,
  // Reject beyond this multiple of the batch's own spread, so a consistently
  // noisy set (grainy film, coarse scans) widens its own tolerance.
  madScale: 5,
  // Floor, as a fraction of the frame width: a perfectly consistent batch must
  // not start rejecting sub-pixel jitter. 1% of ~10k px scan ≈ 100 px.
  minTolFrac: 0.01,
  // A frame the detector itself would not trust is no basis either: marks found
  // only by the template retry on such a scan would be normalised against a bogus
  // rectangle and falsely demoted. Same floor as the detector's.
  minFrameConfidence: FIDUCIAL_DETECTION_TUNING.minFrameConfidence,
  // Per-image shape gate (fiducialShapeCheck): pair centres may disagree by this
  // fraction of the mark extent (~25 px on a 10k scan), never less than shapeMinTolPx.
  shapeTolFrac: 0.002,
  shapeMinTolPx: 4,
}

const median = (v) => {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** A usable film frame: present, confident, non-degenerate, a plausible share of the scan. */
function frameBasis(row, minFrameConfidence) {
  const f = row.frame
  if (!f) return null
  if (Number.isFinite(f.confidence) && f.confidence < minFrameConfidence) return null
  const w = f.right - f.left, h = f.bottom - f.top
  if (!(w > 0) || !(h > 0)) return null
  if (row.natW > 0 && w < row.natW * 0.2) return null
  if (row.natH > 0 && h < row.natH * 0.2) return null
  return { x0: f.left, y0: f.top, scale: w }
}

/** Fallback basis when the batch has no usable frames: the raster itself. */
function rasterBasis(row) {
  return row.natW > 0 ? { x0: 0, y0: 0, scale: row.natW } : null
}

/**
 * Cross-image agreement over one sensor's detected marks.
 *
 * @param {Array<{ id:string, name?:string, accepted:Array<{slot:string,px:number,py:number}>,
 *                 frame?:{left:number,right:number,top:number,bottom:number}|null,
 *                 natW?:number, natH?:number }>} rows
 * @param {object} [cfg] overrides for FIDUCIAL_CONSENSUS_TUNING
 * @returns {{ basis:'frame'|'raster'|'none',
 *             perSlot:Array<{slot:string,n:number,spreadFrac:number,tolFrac:number,checked:boolean}>,
 *             outliers:Array<{imageId:string,imageName?:string,slot:string,distFrac:number,
 *                             distPx:number,tolPx:number}> }}
 */
export function fiducialBatchConsensus(rows = [], cfg = {}) {
  const { minImages, madScale, minTolFrac, minFrameConfidence } = { ...FIDUCIAL_CONSENSUS_TUNING, ...cfg }
  const withMarks = rows.filter((r) => r.accepted?.length)
  if (withMarks.length < minImages) return { basis: 'none', perSlot: [], outliers: [] }

  // Invariant 2: one basis for everyone, or none.
  const frames = withMarks.map((row) => frameBasis(row, minFrameConfidence))
  const useFrame = frames.every(Boolean)
  const bases = new Map()
  for (const [i, row] of withMarks.entries()) {
    const b = useFrame ? frames[i] : rasterBasis(row)
    if (b) bases.set(row.id, b)
  }
  if (bases.size < minImages) return { basis: 'none', perSlot: [], outliers: [] }

  // Invariant 1: gather every mark first; nothing is judged during this pass.
  const bySlot = new Map()
  for (const row of withMarks) {
    const b = bases.get(row.id)
    if (!b) continue
    for (const d of row.accepted) {
      if (!Number.isFinite(d.px) || !Number.isFinite(d.py)) continue
      if (!bySlot.has(d.slot)) bySlot.set(d.slot, [])
      bySlot.get(d.slot).push({
        row, slot: d.slot, u: (d.px - b.x0) / b.scale, v: (d.py - b.y0) / b.scale, scale: b.scale,
      })
    }
  }

  const perSlot = [], outliers = []
  for (const [slot, pts] of bySlot) {
    if (pts.length < minImages) {
      perSlot.push({ slot, n: pts.length, spreadFrac: NaN, tolFrac: NaN, checked: false })
      continue
    }
    const cu = median(pts.map((p) => p.u)), cv = median(pts.map((p) => p.v))
    const res = pts.map((p) => Math.hypot(p.u - cu, p.v - cv))
    const spreadFrac = median(res)
    const tolFrac = Math.max(minTolFrac, madScale * spreadFrac)
    perSlot.push({ slot, n: pts.length, spreadFrac, tolFrac, checked: true })
    for (const [i, p] of pts.entries()) {
      if (res[i] <= tolFrac) continue
      outliers.push({
        imageId: p.row.id, imageName: p.row.name, slot,
        distFrac: res[i], distPx: res[i] * p.scale, tolPx: tolFrac * p.scale,
      })
    }
  }
  return { basis: useFrame ? 'frame' : 'raster', perSlot, outliers }
}

// Opposite slots: a film camera's fiducials are centrally symmetric about the
// fiducial centre, and an affine map (any scanner scale/shear/rotation) keeps
// midpoints, so every available pair's midpoint lands on the same point.
const OPPOSITE_PAIRS = [
  ['corner-tl', 'corner-br'], ['corner-tr', 'corner-bl'],
  ['side-top', 'side-bottom'], ['side-left', 'side-right'],
]

/**
 * Per-image geometric gate, no calibration needed: the midpoints of opposite
 * marks must coincide. This is the check consensus cannot make on a batch too
 * small to vote (< minImages) — and on a large batch it is a second, independent
 * opinion on the same image. Demotes, never deletes:
 *  - ≥3 pair midpoints: the pairs off the median centre are the outliers;
 *  - exactly 2 disagreeing: nothing says which pair is wrong, so both go to review.
 *
 * @param {Array<{slot:string,px:number,py:number}>} accepted
 * @returns {{ checked:boolean, centreSpreadPx:number, tolPx:number,
 *             outliers:Array<{slot:string,distPx:number,tolPx:number}> }}
 */
export function fiducialShapeCheck(accepted = [], cfg = {}) {
  const { shapeTolFrac, shapeMinTolPx } = { ...FIDUCIAL_CONSENSUS_TUNING, ...cfg }
  const bySlot = new Map(accepted.filter((d) => Number.isFinite(d.px) && Number.isFinite(d.py)).map((d) => [d.slot, d]))
  const pairs = OPPOSITE_PAIRS.filter(([a, b]) => bySlot.has(a) && bySlot.has(b)).map(([a, b]) => {
    const p = bySlot.get(a), q = bySlot.get(b)
    return { slots: [a, b], x: (p.px + q.px) / 2, y: (p.py + q.py) / 2 }
  })
  if (pairs.length < 2) return { checked: false, centreSpreadPx: NaN, tolPx: NaN, outliers: [] }
  const pts = [...bySlot.values()]
  let extent = 0
  for (let i = 0; i < pts.length; i++) for (let j = 0; j < i; j++)
    extent = Math.max(extent, Math.hypot(pts[i].px - pts[j].px, pts[i].py - pts[j].py))
  const tolPx = Math.max(shapeMinTolPx, shapeTolFrac * extent)
  const cx = median(pairs.map((p) => p.x)), cy = median(pairs.map((p) => p.y))
  const dist = pairs.map((p) => Math.hypot(p.x - cx, p.y - cy))
  const centreSpreadPx = Math.max(...dist) // a handful of pairs, not pixel data
  const outliers = []
  if (pairs.length === 2) {
    // The median of two is their mean: each sits half the disagreement away.
    const gap = 2 * dist[0]
    if (gap > tolPx) for (const p of pairs) for (const slot of p.slots) outliers.push({ slot, distPx: gap, tolPx })
  } else {
    pairs.forEach((p, i) => {
      if (dist[i] > tolPx) for (const slot of p.slots) outliers.push({ slot, distPx: dist[i], tolPx })
    })
  }
  return { checked: true, centreSpreadPx, tolPx, outliers }
}

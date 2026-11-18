// Pairs checked against the finished sparse model (TODO ▸ 5). Pure: no Vue, Pinia,
// OPFS or DOM.
//
// A false pair that every matching gate passed (a repeated façade, a symmetric
// building) can win: its matches place a photo, and from then on the model agrees with
// the false pair and disagrees with the photo's true pairs. So "conflicts with the
// model" alone points at the innocent pairs. Two steps:
//
//   scorePairAgreement  per pair whose two photos are both in the model, how its
//                       matches sit in it: on one 3D point (`inModel`), on two different
//                       points (`split`), and their Sampson error under the solved
//                       relative pose. → agrees | conflicts | unscored.
//   findSuspectPairs    per photo, how much of its scored matches conflicts. A photo
//                       mostly in conflict is misplaced, and the pairs that hold it
//                       there are its agreeing pairs to photos that are not: those are
//                       the suspects ('holds'). A conflicting pair between two photos
//                       that both sit well is a false pair the model overruled
//                       ('contradicts'; harmless to this model, still wrong).
//
// The epipolar error alone misses a match shifted along its epipolar line (windows
// repeated along the flight line); the split count catches that one, when both
// keypoints made it into the model.

import { kpX, kpY } from './keypointSet.js'
import { asPairList } from './matchCodec.js'

export const PAIR_UNSCORED = 0
export const PAIR_AGREES = 1
export const PAIR_CONFLICTS = 2

// F with x_bᵀ·F·x_a = 0, from world→camera poses { R, t, K } (geometry.js
// conventions): X_b = R_rel·X_a + t_rel, E = [t_rel]ₓ·R_rel, F = K_b⁻ᵀ·E·K_a⁻¹.
// null when the two centres coincide (no baseline: no epipolar geometry).
export function fundamentalFromPoses(camA, camB) {
  const Ra = camA.R,
    Rb = camB.R
  // R_rel = R_b·R_aᵀ
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => Rb[i][0] * Ra[j][0] + Rb[i][1] * Ra[j][1] + Rb[i][2] * Ra[j][2]))
  const t = [0, 1, 2].map((i) => camB.t[i] - (R[i][0] * camA.t[0] + R[i][1] * camA.t[1] + R[i][2] * camA.t[2]))
  const tn = Math.hypot(t[0], t[1], t[2])
  const scale = Math.hypot(...camA.t) + Math.hypot(...camB.t) + 1
  if (!(tn > 1e-12 * scale)) return null
  // [t]ₓ·R, row by row
  const col = (j) => [R[0][j], R[1][j], R[2][j]]
  const E = [
    [0, 1, 2].map((j) => t[1] * col(j)[2] - t[2] * col(j)[1]),
    [0, 1, 2].map((j) => t[2] * col(j)[0] - t[0] * col(j)[2]),
    [0, 1, 2].map((j) => t[0] * col(j)[1] - t[1] * col(j)[0]),
  ]
  const inv = ({ fx, fy, cx, cy }) => [
    [1 / fx, 0, -cx / fx],
    [0, 1 / fy, -cy / fy],
    [0, 0, 1],
  ]
  const Ka = inv(camA.K),
    Kb = inv(camB.K)
  const mul = (A, B) =>
    [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]))
  const KbT = [0, 1, 2].map((i) => [0, 1, 2].map((j) => Kb[j][i]))
  return mul(mul(KbT, E), Ka)
}

/**
 * Each pair whose two photos are both in the model, scored against it.
 *
 * @param {object} o
 * @param {Array<{idA: string, idB: string, matches: any}>} o.pairs  matches index the
 *   photos' keypoints as the model's views do (a in idA, b in idB)
 * @param {(uuid: string) => ({R, t, K} | null)} o.cameraOf  the solved camera, null when
 *   the photo is not in the model. A rolling-shutter camera is taken as global: the
 *   error is then approximate, which is enough to flag a pair.
 * @param {(uuid: string) => object} o.keypointsOf  the photo's keypoint set in the frame
 *   K applies to (undistorted, keypointSet.js)
 * @param {(uuid: string, kp: number) => number} o.pointOf  the model point keypoint `kp`
 *   observes, or −1
 * @param {number} o.epiTolPx  Sampson error (px, native) within which a match agrees
 * @param {number} o.agreeFrac  share of matches that must agree
 * @param {number} o.minSplit  split matches that, outnumbering inModel, make a conflict
 * @param {number} o.minMatches  fewer matches leave the pair unscored
 * @returns {Array<{idA, idB, n, inModel, split, epiMedianPx, epiAgreeFrac, status}>}
 *   one per input pair, in input order
 */
export function scorePairAgreement({
  pairs,
  cameraOf,
  keypointsOf,
  pointOf,
  epiTolPx,
  agreeFrac,
  minSplit,
  minMatches,
}) {
  let scratch = new Float64Array(1024)
  return pairs.map((pair) => {
    const out = {
      idA: pair.idA,
      idB: pair.idB,
      n: 0,
      inModel: 0,
      split: 0,
      epiMedianPx: null,
      epiAgreeFrac: null,
      status: PAIR_UNSCORED,
    }
    const camA = cameraOf(pair.idA),
      camB = cameraOf(pair.idB)
    if (!camA || !camB) return out
    const setA = keypointsOf(pair.idA),
      setB = keypointsOf(pair.idB)
    const m = asPairList(pair.matches ?? [])
    const F = fundamentalFromPoses(camA, camB)
    if (scratch.length < m.length) scratch = new Float64Array(m.length)
    let n = 0,
      within = 0
    for (let i = 0; i < m.length; i++) {
      const ka = m.a(i),
        kb = m.b(i)
      const xa = kpX(setA, ka),
        ya = kpY(setA, ka),
        xb = kpX(setB, kb),
        yb = kpY(setB, kb)
      // A keypoint dropped at ingest (NaN) is not a match the model could hold.
      if (!(Number.isFinite(xa) && Number.isFinite(ya) && Number.isFinite(xb) && Number.isFinite(yb))) continue
      const pa = pointOf(pair.idA, ka),
        pb = pointOf(pair.idB, kb)
      if (pa >= 0 && pb >= 0) {
        if (pa === pb) out.inModel++
        else out.split++
      }
      if (F) {
        const d = sampson(F, xa, ya, xb, yb)
        scratch[n] = d
        if (d <= epiTolPx) within++
      }
      n++
    }
    out.n = n
    if (n < minMatches) return out
    if (F) {
      const ds = scratch.subarray(0, n).sort()
      out.epiMedianPx = n % 2 ? ds[n >> 1] : (ds[n / 2 - 1] + ds[n / 2]) / 2
      out.epiAgreeFrac = within / n
    }
    const splitConflict = out.split >= minSplit && out.split > out.inModel
    if (F) out.status = out.epiAgreeFrac < agreeFrac || splitConflict ? PAIR_CONFLICTS : PAIR_AGREES
    else if (out.inModel + out.split >= minSplit) out.status = splitConflict ? PAIR_CONFLICTS : PAIR_AGREES
    return out
  })
}

// Sampson distance (px) of x_b·F·x_a = 0 (fundamental.js sampsonDistPx, without the
// point objects: this runs once per match of the whole project).
function sampson(F, xa, ya, xb, yb) {
  const l0 = F[0][0] * xa + F[0][1] * ya + F[0][2]
  const l1 = F[1][0] * xa + F[1][1] * ya + F[1][2]
  const l2 = F[2][0] * xa + F[2][1] * ya + F[2][2]
  const r0 = F[0][0] * xb + F[1][0] * yb + F[2][0]
  const r1 = F[0][1] * xb + F[1][1] * yb + F[2][1]
  const denom = l0 * l0 + l1 * l1 + r0 * r0 + r1 * r1
  if (!(denom > 1e-20)) return Infinity
  return Math.abs(xb * l0 + yb * l1 + l2) / Math.sqrt(denom)
}

/**
 * The suspects among scored pairs (see the top of the file).
 *
 * @param {ReturnType<typeof scorePairAgreement>} scores
 * @param {{ contestedFrac: number, minPairs: number }} o
 * @returns {{ photos: Map<string, {agree: number, conflict: number, pairs: number, contested: boolean}>,
 *   suspects: Array<{index: number, idA: string, idB: string, reason: 'holds' | 'contradicts', photo: string | null, conflictShare: number, weight: number}>}}
 *   `index` into `scores`; `photo` the misplaced photo a 'holds' pair holds and
 *   `conflictShare` that photo's share of conflicting matches; suspects sorted most
 *   telling first: 'holds' before 'contradicts', the most contested photo first, then
 *   by matches
 */
export function findSuspectPairs(scores, { contestedFrac, minPairs }) {
  const photos = new Map()
  const tally = (uuid, s) => {
    let p = photos.get(uuid)
    if (!p) photos.set(uuid, (p = { agree: 0, conflict: 0, pairs: 0, conflictShare: 0, contested: false }))
    p.pairs++
    if (s.status === PAIR_AGREES) p.agree += s.n
    else p.conflict += s.n
  }
  for (const s of scores) {
    if (s.status === PAIR_UNSCORED) continue
    tally(s.idA, s)
    tally(s.idB, s)
  }
  for (const p of photos.values()) {
    const total = p.agree + p.conflict
    p.conflictShare = total > 0 ? p.conflict / total : 0
    p.contested = p.pairs >= minPairs && total > 0 && p.conflictShare >= contestedFrac
  }
  const suspects = []
  scores.forEach((s, index) => {
    if (s.status === PAIR_UNSCORED) return
    const pa = photos.get(s.idA),
      pb = photos.get(s.idB)
    if (s.status === PAIR_AGREES && pa.contested !== pb.contested) {
      const held = pa.contested ? s.idA : s.idB
      suspects.push({
        index,
        idA: s.idA,
        idB: s.idB,
        reason: 'holds',
        photo: held,
        conflictShare: photos.get(held).conflictShare,
        weight: s.n,
      })
    } else if (s.status === PAIR_CONFLICTS && !pa.contested && !pb.contested) {
      suspects.push({
        index,
        idA: s.idA,
        idB: s.idB,
        reason: 'contradicts',
        photo: null,
        conflictShare: 0,
        weight: s.n,
      })
    }
  })
  suspects.sort((x, y) =>
    x.reason !== y.reason ? (x.reason === 'holds' ? -1 : 1) : y.conflictShare - x.conflictShare || y.weight - x.weight,
  )
  return { photos, suspects }
}

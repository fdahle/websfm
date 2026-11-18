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
 * @param {(uuid: string) => ((kp: number) => number)} o.pointsOf  the photo's lookup:
 *   the model point its keypoint `kp` observes, or −1 (asked once per pair, so the
 *   photo is found once, not per match)
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
  pointsOf,
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
    if (!setA || !setB) return out
    const m = asPairList(pair.matches ?? [])
    const F = fundamentalFromPoses(camA, camB)
    const pointA = pointsOf(pair.idA),
      pointB = pointsOf(pair.idB)
    const xyA = setA.xy,
      xyB = setB.xy
    if (scratch.length < m.length) scratch = new Float64Array(m.length)
    let n = 0,
      within = 0
    for (let i = 0; i < m.length; i++) {
      const ka = m.a(i),
        kb = m.b(i)
      const xa = xyA[2 * ka],
        ya = xyA[2 * ka + 1],
        xb = xyB[2 * kb],
        yb = xyB[2 * kb + 1]
      // A keypoint dropped at ingest (NaN) is not a match the model could hold.
      if (!(Number.isFinite(xa) && Number.isFinite(ya) && Number.isFinite(xb) && Number.isFinite(yb))) continue
      const pa = pointA(ka),
        pb = pointB(kb)
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
      out.epiMedianPx = median(scratch, n)
      out.epiAgreeFrac = within / n
    }
    const splitConflict = out.split >= minSplit && out.split > out.inModel
    if (F) out.status = out.epiAgreeFrac < agreeFrac || splitConflict ? PAIR_CONFLICTS : PAIR_AGREES
    else if (out.inModel + out.split >= minSplit) out.status = splitConflict ? PAIR_CONFLICTS : PAIR_AGREES
    return out
  })
}

// The median of a[0 … n−1], reordering them (quickselect: linear, where a sort per pair
// was a tenth of the whole check on a 900-photo block).
export function median(a, n) {
  const k = n >> 1
  let lo = 0,
    hi = n - 1
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]
    let i = lo,
      j = hi
    while (i <= j) {
      while (a[i] < pivot) i++
      while (a[j] > pivot) j--
      if (i <= j) {
        const t = a[i]
        a[i] = a[j]
        a[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
  if (n % 2) return a[k]
  // Even: the lower middle is the largest of the values before a[k].
  let below = -Infinity
  for (let i = 0; i < k; i++) if (a[i] > below) below = a[i]
  return (below + a[k]) / 2
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

// The scores of a model merged into the primary join the primary's; a pair both scored
// keeps the primary's (its frame is the one the merged model keeps).
export function mergePairScores(primary = [], added = []) {
  const key = (s) => (s.idA < s.idB ? `${s.idA}--${s.idB}` : `${s.idB}--${s.idA}`)
  const seen = new Set(primary.map(key))
  return [...primary, ...added.filter((s) => !seen.has(key(s)))]
}

export const SUSPECT_NONE = 0
export const SUSPECT_HOLDS = 1
export const SUSPECT_CONTRADICTS = 2

/**
 * The scored pairs as columns, for the main thread and the saved model, with their
 * suspects found: the record a sparse model keeps (`pairCheck`).
 *
 *   uuids          the photos the pairs name; a, b index it (a pair's own order)
 *   matches, inModel, split   Uint32Array per pair
 *   epiMedianPx, epiAgreeFrac Float32Array per pair, NaN without a baseline
 *   status         Uint8Array: PAIR_AGREES | PAIR_CONFLICTS (unscored pairs are left out)
 *   suspect        Uint8Array: SUSPECT_NONE | SUSPECT_HOLDS | SUSPECT_CONTRADICTS
 *   held           Int32Array: for a 'holds' pair the photo (index into uuids) it holds, else −1
 *
 * → { pairCheck, counts: { scored, agrees, conflicts, contested, holds, contradicts },
 *     suspects } (`suspects` as findSuspectPairs ranks them)
 */
export function packPairCheck(scores, { contestedFrac, minPairs, epiTolPx }) {
  const { photos, suspects } = findSuspectPairs(scores, { contestedFrac, minPairs })
  const n = scores.length
  const uuids = []
  const at = new Map()
  const indexOf = (u) => {
    let i = at.get(u)
    if (i == null) {
      at.set(u, (i = uuids.length))
      uuids.push(u)
    }
    return i
  }
  const pc = {
    version: 1,
    epiTolPx,
    uuids,
    a: new Uint32Array(n),
    b: new Uint32Array(n),
    matches: new Uint32Array(n),
    inModel: new Uint32Array(n),
    split: new Uint32Array(n),
    epiMedianPx: new Float32Array(n),
    epiAgreeFrac: new Float32Array(n),
    status: new Uint8Array(n),
    suspect: new Uint8Array(n),
    held: new Int32Array(n).fill(-1),
  }
  let agrees = 0
  scores.forEach((s, i) => {
    pc.a[i] = indexOf(s.idA)
    pc.b[i] = indexOf(s.idB)
    pc.matches[i] = s.n
    pc.inModel[i] = s.inModel
    pc.split[i] = s.split
    pc.epiMedianPx[i] = s.epiMedianPx ?? NaN
    pc.epiAgreeFrac[i] = s.epiAgreeFrac ?? NaN
    pc.status[i] = s.status
    if (s.status === PAIR_AGREES) agrees++
  })
  let holds = 0
  for (const s of suspects) {
    if (s.reason === 'holds') {
      holds++
      pc.suspect[s.index] = SUSPECT_HOLDS
      pc.held[s.index] = indexOf(s.photo)
    } else pc.suspect[s.index] = SUSPECT_CONTRADICTS
  }
  let contested = 0
  for (const p of photos.values()) if (p.contested) contested++
  const counts = { scored: n, agrees, conflicts: n - agrees, contested, holds, contradicts: suspects.length - holds }
  return { pairCheck: pc, counts, suspects }
}

const fmt = (n) => n.toLocaleString('en')
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`

/**
 * The log lines of a finished pair check, as [message, level] (source Sparse): the
 * counts at info, the strongest 'holds' suspects at warn with what to do, the
 * overruled pairs counted at info and each suspect at debug.
 */
export function describePairCheck(counts, suspects, nameOf, { warnMax = 3 } = {}) {
  const lines = []
  if (!counts.scored) return lines
  lines.push([
    `Pair check: ${plural(counts.scored, 'pair')} checked against the model, ${fmt(counts.agrees)} agree, ` +
      `${fmt(counts.conflicts)} disagree` +
      (counts.contested
        ? `; ${plural(counts.contested, 'photo sits', 'photos sit')} where most of ${counts.contested === 1 ? 'its' : 'their'} matches disagree`
        : ''),
    'info',
  ])
  const holds = suspects.filter((s) => s.reason === 'holds')
  for (const s of holds.slice(0, warnMax)) {
    lines.push([
      `${nameOf(s.idA)} ↔ ${nameOf(s.idB)} (${plural(s.weight, 'match', 'matches')}) may be a false match: it holds ` +
        `${nameOf(s.photo)} where ${Math.round(100 * s.conflictShare)}% of that photo's matches disagree with the model. ` +
        'Exclude the pair in View ▸ Inspect ▸ Matches and run Sparse Model again.',
      'warn',
    ])
  }
  if (holds.length > warnMax)
    lines.push([
      `Pair check: ${plural(holds.length - warnMax, 'more pair')} may hold a photo in the wrong place (View ▸ Inspect ▸ Matches)`,
      'warn',
    ])
  if (counts.contradicts)
    lines.push([
      `Pair check: ${plural(counts.contradicts, 'pair disagrees', 'pairs disagree')} with the model without moving it ` +
        (counts.contradicts === 1 ? '(a false match the model overruled)' : '(false matches the model overruled)'),
      'info',
    ])
  for (const s of suspects)
    lines.push([
      `Pair check: ${nameOf(s.idA)} ↔ ${nameOf(s.idB)}, ${plural(s.weight, 'match', 'matches')}, ` +
        (s.reason === 'holds'
          ? `holds ${nameOf(s.photo)} (${Math.round(100 * s.conflictShare)}% of its matches disagree)`
          : 'overruled by the model'),
      'debug',
    ])
  return lines
}

// A pair check as saved with its sparse cloud: a small JSON header and one binary file
// (cloudSerde.js). The 4-byte columns first, then the bytes, so every view is aligned.
const PC_U32 = ['a', 'b', 'matches', 'inModel', 'split']
const PC_I32 = ['held']
const PC_F32 = ['epiMedianPx', 'epiAgreeFrac']
const PC_U8 = ['status', 'suspect']

export function pairCheckToBuffer(pc) {
  const n = pc.status.length
  const quads = PC_U32.length + PC_I32.length + PC_F32.length
  const buffer = new ArrayBuffer(4 * quads * n + PC_U8.length * n)
  let off = 0
  const put = (Type, key) => {
    new Type(buffer, off, n).set(pc[key])
    off += Type.BYTES_PER_ELEMENT * n
  }
  for (const k of PC_U32) put(Uint32Array, k)
  for (const k of PC_I32) put(Int32Array, k)
  for (const k of PC_F32) put(Float32Array, k)
  for (const k of PC_U8) put(Uint8Array, k)
  return { meta: { version: pc.version, epiTolPx: pc.epiTolPx, uuids: [...pc.uuids], count: n }, buffer }
}

/** The pair check back from its header and file; null when they do not fit together. */
export function pairCheckFromBuffer(meta, buffer) {
  const n = meta?.count
  const quads = PC_U32.length + PC_I32.length + PC_F32.length
  if (meta?.version !== 1 || !Number.isInteger(n) || !buffer || buffer.byteLength !== 4 * quads * n + PC_U8.length * n)
    return null
  const pc = { version: 1, epiTolPx: meta.epiTolPx, uuids: meta.uuids ?? [] }
  let off = 0
  const take = (Type, key) => {
    pc[key] = new Type(buffer, off, n)
    off += Type.BYTES_PER_ELEMENT * n
  }
  for (const k of PC_U32) take(Uint32Array, k)
  for (const k of PC_I32) take(Int32Array, k)
  for (const k of PC_F32) take(Float32Array, k)
  for (const k of PC_U8) take(Uint8Array, k)
  return pc
}

// What the match list shows for a pair, most telling first (its sort order).
export const VERDICT_RANK = { holds: 4, disagrees: 3, overruled: 2, agrees: 1 }

/**
 * Each checked pair's verdict, keyed as the matches store keys a pair (the two uuids
 * sorted, joined by `--`):
 *   holds      agrees, and holds a photo where most of its matches disagree: may be false
 *   overruled  disagrees between two photos that sit well: a false pair the model overruled
 *   disagrees  disagrees, with a photo that sits where most of its matches disagree
 *   agrees
 * → Map pid → { verdict, held (uuid | null), matches, inModel, split, epiAgreeFrac
 *   (null without a baseline), epiMedianPx, heldShare (the held photo's disagreeing
 *   share of matches, holds only) }
 */
export function pairCheckVerdicts(pc) {
  const out = new Map()
  if (!pc?.status) return out
  const n = pc.status.length
  // The held photo's share of disagreeing matches, from the columns themselves.
  const agree = new Map(),
    total = new Map()
  const add = (m, u, v) => m.set(u, (m.get(u) ?? 0) + v)
  for (let i = 0; i < n; i++) {
    for (const u of [pc.a[i], pc.b[i]]) {
      add(total, u, pc.matches[i])
      if (pc.status[i] === PAIR_AGREES) add(agree, u, pc.matches[i])
    }
  }
  for (let i = 0; i < n; i++) {
    const ua = pc.uuids[pc.a[i]],
      ub = pc.uuids[pc.b[i]]
    const pid = ua < ub ? `${ua}--${ub}` : `${ub}--${ua}`
    const verdict =
      pc.suspect[i] === SUSPECT_HOLDS
        ? 'holds'
        : pc.suspect[i] === SUSPECT_CONTRADICTS
          ? 'overruled'
          : pc.status[i] === PAIR_CONFLICTS
            ? 'disagrees'
            : 'agrees'
    const h = pc.held[i]
    const finite = (v) => (Number.isFinite(v) ? v : null)
    out.set(pid, {
      verdict,
      held: h >= 0 ? pc.uuids[h] : null,
      heldShare: h >= 0 ? 1 - (agree.get(h) ?? 0) / total.get(h) : null,
      matches: pc.matches[i],
      inModel: pc.inModel[i],
      split: pc.split[i],
      epiAgreeFrac: finite(pc.epiAgreeFrac[i]),
      epiMedianPx: finite(pc.epiMedianPx[i]),
    })
  }
  return out
}

// Turn search: which photos of a match graph's pieces are turned against its main block
// (pure; stores/matching/matchAll.js runs it).
//
// Learned features match only photos turned within about ±15° of each other
// (core/features/turn.js). Flights in opposite directions turn their photos ~180°:
// Rachel's 58 TMA scans (flights at 115° and 290°) matched with SuperPoint + LightGlue
// as two pieces of 32 and 26 photos, bridge repair joined none, and every vertical
// pair between them that overlaps 75–84 % went unmatched; SIFT, which turns with the
// photo, found 196 pairs between the two. So when a learned run leaves pieces, a small
// SIFT look (1,536 px) at each photo of a piece is matched against the main block's,
// each match's homography says how the two are turned, and a piece photo takes the
// quarter turn most of its inliers vote for. Its features are then detected again
// turned and its pairs matched again.
//
// A piece photo with no convincing probe (it overlaps no main photo) takes the turn its
// piece decided, so the piece stays matched within itself.

import { nearestTurn } from './turn.js'
import { graphPieces } from './bridgeRepair.js'

/**
 * The groups of photos the turn search looks at: the pieces apart from the main block,
 * and the parts of it held together only by pairs of fewer than `weakInliers` — however
 * many such pairs there are. Bridge repair counts a part as hanging by a thread only when
 * all its weak pairs together hold under weakCut inliers; a turned flight can be tied on
 * by a dozen chance pairs (Rachel, SuperPoint at 2,400 px: twelve pairs of 15–28 inliers,
 * about 220 in all), which joins the graph without anything sparse can place.
 * → string[][] (image ids per piece)
 */
export function turnSearchPieces({ imageIds, entries, minComponent = 2, weakInliers = 30 }) {
  return graphPieces({ imageIds, entries, opts: { minComponent, weakInliers, weakCut: Infinity } }).pieces.map(
    (p) => p.ids,
  )
}

/**
 * The (main photo, piece photo) pairs to probe: per piece photo its main photos with the
 * most overlap evidence (`scoreUnmatched`, footprints or positions) when there is any,
 * else an even spread of the main block, at most `maxPerImage` each.
 * @param {{ pieces: string[][], main: string[], scoreUnmatched?: ((a: string, b: string) => number) | null,
 *   maxPerImage?: number }} args
 * @returns {Array<{ idMain: string, idPiece: string }>}
 */
export function planTurnProbes({ pieces, main, scoreUnmatched = null, maxPerImage = 40 }) {
  const out = []
  for (const piece of pieces)
    for (const idPiece of piece) {
      let partners
      if (scoreUnmatched) {
        partners = main
          .map((idMain) => ({ idMain, s: scoreUnmatched(idMain, idPiece) ?? 0 }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, maxPerImage)
          .map((x) => x.idMain)
      }
      if (!partners?.length) {
        const step = Math.max(1, main.length / maxPerImage)
        partners = []
        for (let i = 0; i < main.length && partners.length < maxPerImage; i += step) partners.push(main[Math.floor(i)])
      }
      for (const idMain of partners) out.push({ idMain, idPiece })
    }
  return out
}

/**
 * The quarter turn each piece photo should be detected at.
 *   probes  [{ idMain, idPiece, inliers, rotationDeg }] — rotationDeg: how the piece
 *           photo's content is turned against the main photo's (clockwise)
 *   turnOf  (id) → the turn a photo's features were detected at now
 * A probe counts with at least `minInliers`; a photo's (or a piece's) turn is the one
 * holding at least `minShare` of its inliers.
 * @returns {{ turns: Map<string, number>, pieces: Array<{ size: number, turn: number | null,
 *   voters: number, turned: number }> }} turns lists only photos whose turn changes
 */
export function decideTurns({ probes, pieces, turnOf = () => 0, minInliers = 20, minShare = 0.6 }) {
  const votes = new Map() // piece photo → Map(turn → inliers)
  for (const p of probes) {
    if (!(p.inliers >= minInliers) || !Number.isFinite(p.rotationDeg)) continue
    const t = nearestTurn(turnOf(p.idMain) - p.rotationDeg)
    const v = votes.get(p.idPiece) ?? votes.set(p.idPiece, new Map()).get(p.idPiece)
    v.set(t, (v.get(t) ?? 0) + p.inliers)
  }
  const winner = (tally) => {
    let total = 0,
      best = null
    for (const [t, w] of tally) {
      total += w
      if (!best || w > best[1]) best = [t, w]
    }
    return best && best[1] >= minShare * total ? best : null
  }
  const turns = new Map()
  const summary = []
  for (const ids of pieces) {
    const own = new Map()
    const pieceTally = new Map()
    for (const id of ids) {
      const w = votes.get(id) && winner(votes.get(id))
      if (!w) continue
      own.set(id, w[0])
      pieceTally.set(w[0], (pieceTally.get(w[0]) ?? 0) + w[1])
    }
    const pieceTurn = winner(pieceTally)?.[0] ?? null
    let turned = 0
    for (const id of ids) {
      const t = own.get(id) ?? pieceTurn
      if (t == null || t === (turnOf(id) || 0)) continue
      turns.set(id, t)
      turned++
    }
    summary.push({ size: ids.length, turn: pieceTurn, voters: own.size, turned })
  }
  return { turns, pieces: summary }
}

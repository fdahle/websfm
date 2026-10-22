// Repair of a split match graph: which pairs to match again, harder, so that groups
// of images connected among themselves but not to the main block join it. Pure.
//
// Images seen from very different directions (the vertical and oblique cameras of an
// aerial mapping flight, a facade and its roof) match poorly across those directions,
// and one matching pass can leave a block in pieces that SfM can only reconstruct
// apart. A pair joining two pieces is usually there in the match list already, just
// short of the gates; or preselection never tried it. The plan takes, for each piece
// of at least `minComponent` images, the most promising pairs between it and the
// largest piece:
//
//   1. pairs matched and rejected with at least `retryMinRaw` putative matches, most
//      putatives first: they nearly made it;
//   2. pairs never matched whose footprints overlap (or cameras are close), most
//      overlap first, from `scoreUnmatched`;
//   3. the remaining rejected pairs, most putatives first.
//
// At most `perComponent` pairs per piece and `maxPairs` in all, the larger pieces
// served first. A pair the user excluded is never proposed, nor one in `tried` (pair
// keys from bridgeKey: matched again by an earlier round already).

import { graphHealth } from '../eval/matchGraph.js'

const key = (a, b) => (a < b ? `${a}\0${b}` : `${b}\0${a}`)
export const bridgeKey = key

/**
 * @param {object} args
 * @param {string[]} args.imageIds the images that took part in matching
 * @param {Array<{ idA, idB, status, inlierCount, rawCount?, weak?, disabled? }>} args.entries
 * @param {(idA: string, idB: string) => number | null} [args.scoreUnmatched] overlap
 *   evidence (0–1) for a pair never matched; null or 0 = none
 * @param {Set<string>} [args.tried] bridgeKey()s of pairs not to propose again
 * @param {{ minComponent?: number, maxPairs?: number, perComponent?: number, retryMinRaw?: number }} [args.opts]
 * @returns {{ components: number, mainSize: number, detached: number,
 *   pieces: number, pairs: Array<{ idA: string, idB: string, source: 'retry' | 'new', score: number }> }}
 */
export function planBridgeRepair({ imageIds, entries, scoreUnmatched = null, tried = null, opts = {} }) {
  const { minComponent = 2, maxPairs = 48, perComponent = 12, retryMinRaw = 8 } = opts
  const accepted = entries.filter((e) => e.status === 'done' && e.inlierCount > 0 && !e.weak && !e.disabled)
  const { components } = graphHealth(
    accepted.map((e) => ({ idA: e.idA, idB: e.idB, inlierCount: e.inlierCount })),
    imageIds,
  )
  const main = components[0] ?? []
  const out = {
    components: components.length,
    mainSize: main.length,
    detached: imageIds.length - main.length,
    pieces: 0,
    pairs: [],
  }
  const pieces = components.slice(1).filter((c) => c.length >= minComponent)
  out.pieces = pieces.length
  if (!pieces.length) return out

  const inMain = new Set(main)
  const pieceOf = new Map()
  pieces.forEach((c, i) => c.forEach((id) => pieceOf.set(id, i)))
  const known = new Map(entries.map((e) => [key(e.idA, e.idB), e]))

  // Per piece: [near misses, never matched, other rejected].
  const tiers = pieces.map(() => [[], [], []])
  for (const e of entries) {
    if (e.disabled || e.status !== 'done' || (e.inlierCount > 0 && !e.weak)) continue
    if (tried?.has(key(e.idA, e.idB))) continue
    const piece = inMain.has(e.idA) ? pieceOf.get(e.idB) : inMain.has(e.idB) ? pieceOf.get(e.idA) : undefined
    if (piece == null) continue
    const raw = e.rawCount ?? 0
    tiers[piece][raw >= retryMinRaw ? 0 : 2].push({ idA: e.idA, idB: e.idB, source: 'retry', score: raw })
  }
  if (scoreUnmatched)
    pieces.forEach((c, piece) => {
      for (const a of main)
        for (const b of c) {
          if (known.has(key(a, b))) continue
          const s = scoreUnmatched(a, b)
          if (s > 0) tiers[piece][1].push({ idA: a, idB: b, source: 'new', score: s })
        }
    })

  const queues = tiers.map((t) => t.flatMap((list) => list.sort((p, q) => q.score - p.score)).slice(0, perComponent))
  // Round robin over the pieces (largest first), so one big piece cannot take every slot.
  for (let round = 0; out.pairs.length < maxPairs; round++) {
    let any = false
    for (const q of queues) {
      if (round < q.length && out.pairs.length < maxPairs) {
        out.pairs.push(q[round])
        any = true
      }
    }
    if (!any) break
  }
  return out
}

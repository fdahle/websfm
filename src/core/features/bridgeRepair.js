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
//
// A piece can also hang on the main block by a thread: one or two pairs of a few dozen
// inliers join the graph, but too few of its points reach the main block's for SfM to
// register its images (a TMA flight line beside the others: Starbuck's CA2137 and
// CA2153, 46 photos joined by 3 pairs of 16–21 inliers, posed by neither WebSfM nor
// Metashape). With `weakInliers` set, the pairs of fewer inliers are left out of the
// graph, and a piece that then stands apart is repaired the same way when all its
// pairs to the main block hold fewer than `weakCut` inliers in total. On the logs of
// three glaciers, 30 and 100 flag 43 of Starbuck's 46 unposed photos and none that SfM
// posed on Starbuck, Jorum or Melville (Jorum's unposed photos are cut off outright).

import { graphHealth } from '../eval/matchGraph.js'

const key = (a, b) => (a < b ? `${a}\0${b}` : `${b}\0${a}`)
export const bridgeKey = key

/**
 * The pieces a repair is for: the pieces of at least `minComponent` images apart from
 * the main block, then (with `weakInliers`) those hanging on it by a thread, each with
 * what it is matched against (`target`: the main block, or for a piece hanging by a
 * thread, the part of it that holds together without the weak pairs).
 * @returns {{ components: number, mainSize: number, detached: number,
 *   pieces: Array<{ ids: string[], target: Set<string>, weak: boolean }> }}
 */
export function graphPieces({ imageIds, entries, opts = {} }) {
  const { minComponent = 2, weakInliers = 0, weakCut = 0 } = opts
  const accepted = entries.filter((e) => e.status === 'done' && e.inlierCount > 0 && !e.weak && !e.disabled)
  const componentsOf = (list) =>
    graphHealth(
      list.map((e) => ({ idA: e.idA, idB: e.idB, inlierCount: e.inlierCount })),
      imageIds,
    ).components
  const components = componentsOf(accepted)
  const main = components[0] ?? []
  const inMain = new Set(main)
  const pieces = components
    .slice(1)
    .filter((c) => c.length >= minComponent)
    .map((ids) => ({ ids, target: inMain, weak: false }))
  // Pieces inside the main block that hang on it by a thread: apart without the pairs of
  // fewer than weakInliers inliers, and joined to the rest by fewer than weakCut in all.
  if (weakInliers > 0 && main.length) {
    const strong = componentsOf(accepted.filter((e) => e.inlierCount >= weakInliers))
    const core = new Set(strong[0])
    for (const c of strong.slice(1)) {
      if (c.length < minComponent || !inMain.has(c[0])) continue
      const set = new Set(c)
      let cut = 0
      for (const e of accepted)
        if ((set.has(e.idA) && core.has(e.idB)) || (set.has(e.idB) && core.has(e.idA))) cut += e.inlierCount
      if (cut < weakCut) pieces.push({ ids: c, target: core, weak: true })
    }
  }
  return { components: components.length, mainSize: main.length, detached: imageIds.length - main.length, pieces }
}

/**
 * @param {object} args
 * @param {string[]} args.imageIds the images that took part in matching
 * @param {Array<{ idA, idB, status, inlierCount, rawCount?, weak?, disabled? }>} args.entries
 * @param {(idA: string, idB: string) => number | null} [args.scoreUnmatched] overlap
 *   evidence (0–1) for a pair never matched; null or 0 = none
 * @param {Set<string>} [args.tried] bridgeKey()s of pairs not to propose again
 * @param {{ minComponent?: number, maxPairs?: number, perComponent?: number, retryMinRaw?: number,
 *   weakInliers?: number, weakCut?: number }} [args.opts] weakInliers 0 = split pieces only
 * @returns {{ components: number, mainSize: number, detached: number, pieces: number,
 *   weakPieces: number, weakImages: number,
 *   pairs: Array<{ idA: string, idB: string, source: 'retry' | 'new', score: number }> }}
 *   pieces counts the split pieces repaired, weakPieces/weakImages those hanging by a thread
 */
export function planBridgeRepair({ imageIds, entries, scoreUnmatched = null, tried = null, opts = {} }) {
  const { maxPairs = 48, perComponent = 12, retryMinRaw = 8 } = opts
  const graph = graphPieces({ imageIds, entries, opts })
  const out = {
    components: graph.components,
    mainSize: graph.mainSize,
    detached: graph.detached,
    pieces: graph.pieces.filter((p) => !p.weak).length,
    weakPieces: graph.pieces.filter((p) => p.weak).length,
    weakImages: graph.pieces.reduce((n, p) => n + (p.weak ? p.ids.length : 0), 0),
    pairs: [],
  }
  const pieces = graph.pieces.map((p) => p.ids),
    targets = graph.pieces.map((p) => p.target)
  if (!pieces.length) return out

  const pieceOf = new Map()
  pieces.forEach((c, i) => c.forEach((id) => pieceOf.set(id, i)))
  const known = new Map(entries.map((e) => [key(e.idA, e.idB), e]))

  // Per piece: [near misses, never matched, other rejected].
  const tiers = pieces.map(() => [[], [], []])
  for (const e of entries) {
    if (e.disabled || e.status !== 'done' || (e.inlierCount > 0 && !e.weak)) continue
    if (tried?.has(key(e.idA, e.idB))) continue
    const pa = pieceOf.get(e.idA),
      pb = pieceOf.get(e.idB)
    const piece = pb != null && targets[pb].has(e.idA) ? pb : pa != null && targets[pa].has(e.idB) ? pa : undefined
    if (piece == null) continue
    const raw = e.rawCount ?? 0
    tiers[piece][raw >= retryMinRaw ? 0 : 2].push({ idA: e.idA, idB: e.idB, source: 'retry', score: raw })
  }
  if (scoreUnmatched)
    pieces.forEach((c, piece) => {
      for (const a of targets[piece])
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

// Focal length from the verified pair geometry, for images whose metadata gives none
// (pure).
//
// Without a focal in EXIF or the sensor table, resolveK falls back to fx = max(w, h)
// (a ~53° field of view). ETH3D's undistorted DSLR frames carry no EXIF at all and are
// ~84° wide (fx ≈ 3,430 px on 6,215 px): registration then built every scene on a focal
// 1.8× too long, self-calibration walked it down in capped steps while the model was
// already distorted, and playground / terrace came out broken (2026-10-16).
//
// For the right focal the essential matrix E = Kᵀ F K has two equal singular values
// (Mendonça–Cipolla). With the principal point at the image centre, a 1-D search per
// strong pair for the focal that maximises σ2/σ1 recovers it; the median of the pairs
// that agree with each other is robust. Measured: ETH3D playground 3,444 px and terrace 3,405 px
// (truth ≈ 3,430); South Building 2,638 px (COLMAP 2,560, EXIF 2,485 — EXIF is kept).
//
// The search assumes both images of a pair share the field of view (one scale factor
// s = f / max(w, h)), so it runs per sensor group where a group has enough pairs, else
// over all guessed images together.

import { essentialSingularValues } from './rotations.js'
import { hasFundamental } from './ingest.js'

export const FOCAL_FROM_PAIRS_DEFAULTS = {
  maxPairs: 40,       // strongest pairs used per group
  minPairs: 5,        // fewer usable pairs ⇒ keep the default guess
  minRatio: 0.9,      // a pair counts only if its best σ2/σ1 reaches this
  agree: 0.1,         // pairs within ±10 % of the median agree …
  minAgreement: 0.4,  // … and at least this share of the pairs must (a consensus, not a spread
                      // gate: on low-texture ETH3D pipes a third of the weak pairs scatter
                      // 1,500–8,700 px while 53 % agree on ≈ 3,400 — the truth is ≈ 3,430)
  sMin: 0.25, sMax: 3, sStep: 1.01, // search range of s = f / max(w, h), multiplicative step
}

// σ2/σ1 of Kbᵀ·F·Ka for focal fa / fb (pixels) and principal points pa / pb.
export function essentialRatio(F, fa, fb, pa, pb) {
  // E = Kbᵀ F Ka with K = [[f,0,cx],[0,f,cy],[0,0,1]], expanded.
  const FKa = F.map((r) => [r[0] * fa, r[1] * fa, r[0] * pa.cx + r[1] * pa.cy + r[2]])
  const E = [
    FKa[0].map((v) => fb * v),
    FKa[1].map((v) => fb * v),
    [0, 1, 2].map((j) => pb.cx * FKa[0][j] + pb.cy * FKa[1][j] + FKa[2][j]),
  ]
  const { s1, s2 } = essentialSingularValues(Float32Array.from(E.flat()))
  return s1 > 0 ? s2 / s1 : 0
}

// Best scale s (f = s · max(w, h), shared by both images) for one pair; { s, ratio }.
export function pairFocalScale(F, dimsA, dimsB, pa, pb, cfg = FOCAL_FROM_PAIRS_DEFAULTS) {
  const wa = Math.max(dimsA.width, dimsA.height), wb = Math.max(dimsB.width, dimsB.height)
  let best = { s: null, ratio: 0 }
  for (let s = cfg.sMin; s <= cfg.sMax; s *= cfg.sStep) {
    const r = essentialRatio(F, s * wa, s * wb, pa, pb)
    if (r > best.ratio) best = { s, ratio: r }
  }
  return best
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]

// Estimate the scale for a set of pairs; null when too few agree.
function estimateScale(pairs, dims, Kmap, c) {
  const scales = []
  for (const e of pairs.slice(0, c.maxPairs)) {
    const Ka = Kmap.get(e.idA), Kb = Kmap.get(e.idB)
    const best = pairFocalScale(e.F, dims(e.idA), dims(e.idB), Ka, Kb, c)
    if (best.s != null && best.ratio >= c.minRatio) scales.push(best.s)
  }
  if (scales.length < c.minPairs) return null
  scales.sort((a, b) => a - b)
  const median = quantile(scales, 0.5)
  const agreeing = scales.filter((v) => Math.abs(v / median - 1) <= c.agree)
  const agreement = agreeing.length / scales.length
  if (agreeing.length < c.minPairs || agreement < c.minAgreement) return null
  return { s: quantile(agreeing, 0.5), n: agreeing.length, of: scales.length, agreement }
}

// For every image `isGuess(uuid)` marks (no focal in its metadata), replace Kmap's fx/fy
// with the pair estimate. `groupOf(uuid)` keys images that share a lens (a sensor id).
// Mutates Kmap; returns [{ group, s, n, of, agreement, images, own }] for the groups it set.
export function estimateFocalsFromPairs({ imgs, Kmap, pairs, isGuess, groupOf, dims, cfg = {} }) {
  const c = { ...FOCAL_FROM_PAIRS_DEFAULTS, ...cfg }
  const guessed = imgs.filter((im) => isGuess(im.uuid)).map((im) => im.uuid)
  if (!guessed.length) return []
  const guessedSet = new Set(guessed)
  const usable = pairs
    .filter((e) => hasFundamental(e) && !e.weak && guessedSet.has(e.idA) && guessedSet.has(e.idB))
    .sort((a, b) => b.inlierCount - a.inlierCount)
  const global = estimateScale(usable, dims, Kmap, c)
  const byGroup = new Map()
  for (const u of guessed) {
    const g = groupOf(u)
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(u)
  }
  const out = []
  for (const [g, members] of byGroup) {
    const mine = new Set(members)
    const own = estimateScale(usable.filter((e) => mine.has(e.idA) && mine.has(e.idB)), dims, Kmap, c)
    const est = own ?? global
    if (!est) continue
    for (const u of members) {
      const K = Kmap.get(u), d = dims(u)
      const f = est.s * Math.max(d.width, d.height)
      Kmap.set(u, { ...K, fx: f, fy: f, source: `${K.source}, refined from ${est.n} pair(s) to ${f.toFixed(0)}px` })
    }
    out.push({ group: g, s: est.s, n: est.n, of: est.of, agreement: est.agreement, images: members.length, own: !!own })
  }
  return out
}

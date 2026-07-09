// Coarse-to-fine guided tiling — the pure geometry behind full-density LightGlue
// matching. LightGlue attention is O(N²) in keypoints, so a pair is normally
// capped to the strongest ~2048 (lgMaxKeypoints), throwing away most of what tiled
// detection produced. Instead: match a capped subset first, fit a homography H
// (A→B) on the verified coarse matches, tile image A, map each tile through H (+ a
// parallax margin) into image B, and match tile-vs-region at full local density.
// Every tile-pair stays under the attention budget, so the pair is matched at full
// resolution in bounded memory.
//
// This module owns only the *math* (H estimation, tile planning, rect membership,
// dedupe) — DOM/Vue/ORT-free so it unit-tests in Node. The orchestration (running
// LightGlue per tile) lives next to the session machinery in lightglue.js.
//
// The existing H-RANSAC lives inside the wasm crate `verify_matches_hf` and only
// returns a count, not H — this small JS DLT is enough here since it only *guides*
// tiling; the real geometric gate is still F-RANSAC downstream.
//
// Point convention: correspondences are arrays of [x,y] in original image px.
// Homographies are flat length-9 row-major arrays (h[0..8], h[8] = h33).

import { planTiles } from './tiling.js'

// Deterministic PRNG (mulberry32) so RANSAC — and therefore the tests — are
// reproducible. Seeded per call from the point count so identical inputs give
// identical output.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Apply a flat-9 homography to a point → [x', y'] (perspective divide).
export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8]
  const iw = w !== 0 ? 1 / w : 0
  return [(H[0] * x + H[1] * y + H[2]) * iw, (H[3] * x + H[4] * y + H[5]) * iw]
}

// Hartley normalization: translate centroid to origin, scale so mean distance from
// origin is √2. Returns the normalized points + the 3×3 transform T (orig → norm)
// as a flat-9 array. Well-conditioned homography DLT needs this on pixel coords.
function normalizePoints(pts) {
  const n = pts.length
  let cx = 0, cy = 0
  for (const [x, y] of pts) { cx += x; cy += y }
  cx /= n; cy /= n
  let meanDist = 0
  for (const [x, y] of pts) meanDist += Math.hypot(x - cx, y - cy)
  meanDist /= n
  const s = meanDist > 1e-12 ? Math.SQRT2 / meanDist : 1
  const norm = pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s])
  const T = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1]
  return { norm, T }
}

// 3×3 flat-9 matrix multiply (A·B).
function matMul3(A, B) {
  const C = new Array(9).fill(0)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c]
  return C
}

// Inverse of a 3×3 flat-9 matrix, or null if singular.
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return null
  const id = 1 / det
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ]
}

// Solve an n×n linear system M·x = v by Gaussian elimination with partial pivoting.
// Returns x, or null if (near-)singular. M is row-major flat, mutated in place.
function solveLinear(M, v, n) {
  const a = M.slice()
  const b = v.slice()
  for (let col = 0; col < n; col++) {
    // partial pivot
    let piv = col, best = Math.abs(a[col * n + col])
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(a[r * n + col])
      if (val > best) { best = val; piv = r }
    }
    if (best < 1e-12) return null
    if (piv !== col) {
      for (let k = 0; k < n; k++) { const t = a[col * n + k]; a[col * n + k] = a[piv * n + k]; a[piv * n + k] = t }
      const t = b[col]; b[col] = b[piv]; b[piv] = t
    }
    const inv = 1 / a[col * n + col]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = a[r * n + col] * inv
      if (factor === 0) continue
      for (let k = col; k < n; k++) a[r * n + k] -= factor * a[col * n + k]
      b[r] -= factor * b[col]
    }
  }
  const x = new Array(n)
  for (let i = 0; i < n; i++) x[i] = b[i] / a[i * n + i]
  return x
}

// Homography from ≥4 correspondences via DLT with the h33=1 gauge (an 8-unknown
// least-squares system, solved through the normal equations). Points are assumed
// already normalized; the caller denormalizes. Returns a flat-9 H or null if the
// system is degenerate (e.g. collinear points). The h33=1 gauge fails only when the
// true h33≈0 (an extreme viewpoint), which doesn't arise for image-to-image warps.
function homographyDLT(ptsA, ptsB) {
  const n = ptsA.length
  if (n < 4) return null
  // Normal equations: (Σ rᵀr) h = Σ rᵀ rhs, for the two rows r per correspondence.
  const M = new Array(64).fill(0)
  const rhs = new Array(8).fill(0)
  const acc = (row, val) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) M[i * 8 + j] += row[i] * row[j]
      rhs[i] += row[i] * val
    }
  }
  for (let k = 0; k < n; k++) {
    const [x, y] = ptsA[k]
    const [u, v] = ptsB[k]
    acc([x, y, 1, 0, 0, 0, -u * x, -u * y], u)
    acc([0, 0, 0, x, y, 1, -v * x, -v * y], v)
  }
  const h = solveLinear(M, rhs, 8)
  if (!h) return null
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
}

// Estimate H (A→B) from putative correspondences with RANSAC + a final refit on the
// consensus set. ptsA/ptsB are arrays of [x,y] (original px), index-aligned.
//
// @returns {{ H:number[], inlierMask:Uint8Array, inlierCount:number, p95ErrPx:number } | null}
//          null if < 4 points or no non-degenerate model found.
export function estimateHomographyRansac(ptsA, ptsB, { threshPx = 3, iters = 500 } = {}) {
  const n = ptsA.length
  if (n < 4 || ptsB.length !== n) return null

  // Normalize once; fit in normalized space, denormalize the result. Errors are
  // measured back in pixel space so threshPx stays meaningful.
  const { norm: nA, T: TA } = normalizePoints(ptsA)
  const { norm: nB, T: TB } = normalizePoints(ptsB)
  const TBinv = inv3(TB)
  if (!TBinv) return null

  const rng = mulberry32(n * 2654435761)
  const t2 = threshPx * threshPx

  const denorm = (Hn) => matMul3(TBinv, matMul3(Hn, TA))
  const countInliers = (H) => {
    const mask = new Uint8Array(n)
    let cnt = 0
    for (let i = 0; i < n; i++) {
      const [px, py] = applyHomography(H, ptsA[i][0], ptsA[i][1])
      const dx = px - ptsB[i][0], dy = py - ptsB[i][1]
      if (dx * dx + dy * dy <= t2) { mask[i] = 1; cnt++ }
    }
    return { mask, cnt }
  }

  let bestCnt = 0
  let bestMask = null
  const idx = new Array(4)
  for (let it = 0; it < iters; it++) {
    // 4 distinct random indices
    for (let s = 0; s < 4; s++) {
      let r
      do { r = Math.floor(rng() * n) } while (idx.slice(0, s).includes(r))
      idx[s] = r
    }
    const Hn = homographyDLT(idx.map((i) => nA[i]), idx.map((i) => nB[i]))
    if (!Hn) continue
    const H = denorm(Hn)
    const { mask, cnt } = countInliers(H)
    if (cnt > bestCnt) { bestCnt = cnt; bestMask = mask }
  }
  if (!bestMask || bestCnt < 4) return null

  // Refit on the full consensus set (in normalized space), then re-classify.
  const inA = [], inB = []
  for (let i = 0; i < n; i++) if (bestMask[i]) { inA.push(nA[i]); inB.push(nB[i]) }
  const HnRefit = homographyDLT(inA, inB)
  const H = HnRefit ? denorm(HnRefit) : denorm(homographyDLT(idx.map((i) => nA[i]), idx.map((i) => nB[i])))
  if (!H) return null
  const { mask, cnt } = countInliers(H)
  if (cnt < 4) return null

  // p95 forward-reprojection error over the inliers.
  const errs = []
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const [px, py] = applyHomography(H, ptsA[i][0], ptsA[i][1])
    errs.push(Math.hypot(px - ptsB[i][0], py - ptsB[i][1]))
  }
  errs.sort((a, b) => a - b)
  const p95ErrPx = errs.length ? errs[Math.min(errs.length - 1, Math.floor(0.95 * (errs.length - 1)))] : 0

  return { H, inlierMask: mask, inlierCount: cnt, p95ErrPx }
}

// Derive the parallax margin (px) added around each mapped tile region from how
// well H actually fits: a looser fit (larger p95) needs a wider search band. Never
// below `min` (H can't model relief / small stereo parallax exactly).
export function marginFromResiduals(p95ErrPx, { min = 32, k = 3 } = {}) {
  return Math.max(min, Math.ceil((p95ErrPx || 0) * k))
}

// Clamp a rect to [0,w]×[0,h]; returns null if it has no area after clamping.
function clampRect(x0, y0, x1, y1, w, h) {
  const cx0 = Math.max(0, Math.floor(Math.min(x0, x1)))
  const cy0 = Math.max(0, Math.floor(Math.min(y0, y1)))
  const cx1 = Math.min(w, Math.ceil(Math.max(x0, x1)))
  const cy1 = Math.min(h, Math.ceil(Math.max(y0, y1)))
  if (cx1 <= cx0 || cy1 <= cy0) return null
  return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 }
}

// Plan tile-vs-region pairs: tile image A, map each tile through H into image B,
// bbox + margin + clamp. Tiles whose region falls entirely outside B (no overlap)
// are dropped. A small tile overlap keeps seam keypoints inside at least one tile.
//
// @returns {{ tileA:{x,y,w,h}, regionB:{x,y,w,h} }[]}
export function planGuidedTiles({ wA, hA, wB, hB, H, tileSize, marginPx, overlap = 32 }) {
  const tiles = planTiles(wA, hA, tileSize, overlap)
  const out = []
  for (const t of tiles) {
    const corners = [
      [t.x, t.y], [t.x + t.w, t.y], [t.x, t.y + t.h], [t.x + t.w, t.y + t.h],
    ]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [cx, cy] of corners) {
      const [px, py] = applyHomography(H, cx, cy)
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
    const regionB = clampRect(minX - marginPx, minY - marginPx, maxX + marginPx, maxY + marginPx, wB, hB)
    if (!regionB) continue // tile maps outside B — nothing to match
    out.push({ tileA: { x: t.x, y: t.y, w: t.w, h: t.h }, regionB })
  }
  return out
}

// Indices of keypoints falling inside `rect` (half-open on the far edges),
// preserving the input order — keypoints arrive score-sorted, so a later per-tile
// cap still keeps the strongest.
export function kptIndicesInRect(kps, rect) {
  const { x, y, w, h } = rect
  const x1 = x + w, y1 = y + h
  const out = []
  for (let i = 0; i < kps.length; i++) {
    const kx = kps[i].x, ky = kps[i].y
    if (kx >= x && kx < x1 && ky >= y && ky < y1) out.push(i)
  }
  return out
}

// Enforce LightGlue's one-to-one convention over the merged (overlapping-tile)
// match set: keep the highest-score match per ia, then the highest-score per ib.
// Tiles overlap, so the same (ia,ib) can appear twice and one ia can match
// different ib in different tiles — this collapses both. Preserving one-to-one is
// what lets SfM chain tracks on keypoint identity, so it must not be skipped.
export function dedupeGuidedMatches(matches) {
  const bestByIa = new Map()
  for (const m of matches) {
    const prev = bestByIa.get(m.ia)
    if (!prev || m.score > prev.score) bestByIa.set(m.ia, m)
  }
  const bestByIb = new Map()
  for (const m of bestByIa.values()) {
    const prev = bestByIb.get(m.ib)
    if (!prev || m.score > prev.score) bestByIb.set(m.ib, m)
  }
  return Array.from(bestByIb.values())
}

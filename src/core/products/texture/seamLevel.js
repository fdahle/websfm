// Global seam levelling (plan-texture T4; Waechter, Moehrle & Goesele 2014, §5). Pure.
//
// Per-image gains match photos on average, but each seam still shows a colour step:
// lighting that differs across the surface, vignetting, a wall that one photo sees
// in shade, misaligned detail. This adds a smooth colour offset to every chart so
// that the two sides of every seam meet, fading into the chart interior.
//
// Unknowns: an RGB offset g(v, l) per mesh vertex v and per photo l used by a face at
// v (most vertices have one; a seam vertex has one per side). Per channel, minimise
//   Σ_seams w (f(v,l1) + g(v,l1) − f(v,l2) − g(v,l2))²      — the sides meet
// + λ Σ_edges (g(v1,l) − g(v2,l))²                          — smooth inside a chart
// + ε Σ g²                                                   — the overall level stays
// where f(v,l) is the colour the atlas shows at v from photo l, averaged along the
// seam edges at v so one texel of detail does not decide it. A seam whose sides
// differ a lot is more likely misaligned detail or a silhouette than a colour shift;
// Cauchy weights w = 1 / (1 + (d/δ)²), δ scaled to the model's median seam, keep it
// from recolouring a whole chart. A sparse SPD system
// (graph Laplacian + diagonal), solved by Jacobi-preconditioned CG per channel.
//
// The offsets are interpolated over each face (barycentric, in atlas space) and
// carried into the padding by dilation, so mipmaps stay consistent.

import { toScaledPx } from '../../sfm/geometry.js'
import { sampleRgbaBilinear } from '../undistort.js'
import { TEXTURE_TUNING } from '../../tuning.js'
import { faceAdjacency } from './meshGraph.js'

// labels, idx: per face; cut: chartPieces output; px: cornerPixels; layout + pages:
// the baked atlas (modified in place). → { seamVertices, unknowns, iterations, maxOffset }
export function levelSeams(labels, idx, nVerts, cut, px, layout, pages, opts = {}) {
  const {
    smoothWeight = TEXTURE_TUNING.seamSmoothWeight,
    delta = TEXTURE_TUNING.seamDelta,
    chromaWeight = TEXTURE_TUNING.seamChromaWeight,
    maxOffset = TEXTURE_TUNING.seamMaxOffset,
    padding = TEXTURE_TUNING.padding,
  } = opts
  const { pieces, faces } = cut
  const { pageSize: P, pageHeights, scale: s, place } = layout
  const F = labels.length

  // Unknown index of (vertex, label): the first label seen at a vertex is stored
  // densely, any further ones in a map.
  const firstLabel = new Int32Array(nVerts).fill(-1),
    firstIdx = new Int32Array(nVerts)
  const extra = new Map()
  let n = 0
  const unknown = (v, l, create) => {
    if (firstLabel[v] === l) return firstIdx[v]
    if (firstLabel[v] < 0) {
      if (!create) return -1
      firstLabel[v] = l
      firstIdx[v] = n
      return n++
    }
    const key = v * 65536 + l
    let u = extra.get(key)
    if (u === undefined) {
      if (!create) return -1
      u = n++
      extra.set(key, u)
    }
    return u
  }
  for (let f = 0; f < F; f++) if (labels[f] >= 0) for (let k = 0; k < 3; k++) unknown(idx[3 * f + k], labels[f], true)
  if (!extra.size) return { seamVertices: 0, unknowns: n, iterations: 0, maxOffset: 0 }

  // Atlas position of corner k of face f (in its own piece).
  const pieceOf = new Int32Array(F).fill(-1)
  for (let p = 0; p < pieces.count; p++) for (let x = pieces.start[p]; x < pieces.end[p]; x++) pieceOf[faces[x]] = p
  const atlas = (f, k, out) => {
    const p = pieceOf[f]
    out[0] = toScaledPx(px[6 * f + 2 * k], s) - pieces.x0[p] + place.x[p]
    out[1] = toScaledPx(px[6 * f + 2 * k + 1], s) - pieces.y0[p] + place.y[p]
    return place.page[p]
  }

  // f(v, l): atlas colour along the seam edges at v, per unknown (sum + count).
  const fSum = new Float64Array(3 * n),
    fCnt = new Float32Array(n)
  const isSeamVertex = new Uint8Array(nVerts)
  for (const key of extra.keys()) isSeamVertex[Math.floor(key / 65536)] = 1
  const a = [0, 0],
    b = [0, 0],
    rgb = new Float32Array(4)
  for (let f = 0; f < F; f++) {
    const l = labels[f]
    if (l < 0 || pieceOf[f] < 0) continue
    for (let k = 0; k < 3; k++) {
      const v0 = idx[3 * f + k],
        v1 = idx[3 * f + ((k + 1) % 3)]
      if (!isSeamVertex[v0] || !isSeamVertex[v1]) continue
      // Sample this face's side of edge v0–v1 at 0, ¼, ½ of the way from each end, on
      // the edge itself: both sides must sample the same surface points (moving even
      // 1.5 texels inwards made a perfectly exposed synthetic scene's sides differ by
      // 9 levels). Where the seam is a silhouette in a photo, bilinear takes in the
      // other surface there; those seams are outliers the weights below handle.
      const page = atlas(f, k, a)
      atlas(f, (k + 1) % 3, b)
      const u0 = unknown(v0, l, false),
        u1 = unknown(v1, l, false)
      for (const [t, u] of [
        [0, u0],
        [0.25, u0],
        [0.5, u0],
        [1, u1],
        [0.75, u1],
        [0.5, u1],
      ]) {
        sampleRgbaBilinear(
          pages[page],
          P,
          pageHeights[page],
          a[0] + t * (b[0] - a[0]),
          a[1] + t * (b[1] - a[1]),
          rgb,
          0,
        )
        fSum[3 * u] += rgb[0]
        fSum[3 * u + 1] += rgb[1]
        fSum[3 * u + 2] += rgb[2]
        fCnt[u]++
      }
    }
  }

  // System: smoothness edges within a label + seam pairs between labels at a vertex.
  const ea = [],
    eb = [],
    ew = []
  const sm = smoothingEdges(labels, idx, opts.adj ?? faceAdjacency(idx, nVerts).adj)
  for (let e = 0; e < sm.length; e += 3) {
    ea.push(unknown(sm[e], sm[e + 2], false))
    eb.push(unknown(sm[e + 1], sm[e + 2], false))
    ew.push(smoothWeight)
  }
  const nSmooth = ea.length
  // Seam pairs: every two unknowns of one vertex.
  const byVertex = new Map()
  for (const [key, u] of extra) {
    const v = Math.floor(key / 65536)
    if (!byVertex.has(v)) byVertex.set(v, [firstIdx[v]])
    byVertex.get(v).push(u)
  }
  const pd = [] // per seam pair: target difference f(j) − f(i), per channel
  for (const us of byVertex.values()) {
    for (let x = 0; x < us.length; x++) {
      for (let y = x + 1; y < us.length; y++) {
        const i = us[x],
          j = us[y]
        if (!fCnt[i] || !fCnt[j]) continue
        const d = [0, 1, 2].map((c) => fSum[3 * j + c] / fCnt[j] - fSum[3 * i + c] / fCnt[i])
        ea.push(i)
        eb.push(j)
        ew.push(0)
        pd.push(d)
      }
    }
  }
  // Cauchy weights on each seam's difference, at a scale set by the model's own
  // typical seam: δ = `delta` × the median difference (≥ 1 level). On a clean model
  // the median is a fraction of a level and a silhouette seam 100 levels off has no
  // say; on a leafy one the scale widens with the noise.
  const mags = pd.map((d) => Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])))
  const sorted = Float64Array.from(mags).sort()
  const scale = Math.max(1, delta * (sorted.length ? sorted[sorted.length >> 1] : 0))
  for (let e = nSmooth; e < ea.length; e++) ew[e] = 1 / (1 + (mags[e - nSmooth] / scale) ** 2)
  const E = ea.length
  const A = Int32Array.from(ea),
    B = Int32Array.from(eb)
  // Solved in brightness and two colour differences rather than R, G, B: independent
  // channel offsets turned a vine chart purple on South Building, its seams pulling it
  // towards the brick around it. Brightness takes the full seam pull; the colour terms
  // pull at `chromaWeight` of it (default 0: brightness only, which kept the vine green
  // and still cut the seam step 37 → 27 levels). (Y, cr, cb) = (mean, R − mean, B − mean).
  const toYc = (d) => {
    const y = (d[0] + d[1] + d[2]) / 3
    return [y, d[0] - y, d[2] - y]
  }
  const pdY = pd.map(toYc)
  const g = [0, 1, 2].map(() => new Float64Array(n)) // Y, cr, cb
  let iterations = 0
  for (let c = 0; c < (chromaWeight > 0 ? 3 : 1); c++) {
    const scale = c === 0 ? 1 : chromaWeight
    const Wt = Float64Array.from(ew, (w, e) => (e < nSmooth ? w : w * scale))
    const diag = new Float64Array(n).fill(TEXTURE_TUNING.seamEpsilon)
    for (let e = 0; e < E; e++) {
      diag[A[e]] += Wt[e]
      diag[B[e]] += Wt[e]
    }
    // With d = f_j − f_i, the term w(f_i + g_i − f_j − g_j)² gives rhs_i = w·d, rhs_j = −w·d.
    const rhs = new Float64Array(n)
    for (let e = nSmooth; e < E; e++) {
      const d = pdY[e - nSmooth][c]
      rhs[A[e]] += Wt[e] * d
      rhs[B[e]] -= Wt[e] * d
    }
    iterations = Math.max(iterations, cg(diag, A, B, Wt, rhs, g[c]))
    // A bound: a seam that needs more than this is not a colour shift.
    const lim = c === 0 ? maxOffset : maxOffset / 2
    for (let i = 0; i < n; i++) g[c][i] = Math.max(-lim, Math.min(lim, g[c][i]))
  }
  // Back to R, G, B.
  for (let i = 0; i < n; i++) {
    const y = g[0][i],
      cr = g[1][i],
      cb = g[2][i]
    g[0][i] = y + cr
    g[1][i] = y - cr - cb
    g[2][i] = y + cb
  }

  // Apply: per piece, interpolate over its faces, dilate into the padding, add.
  let largest = 0
  for (let p = 0; p < pieces.count; p++) {
    const w = pieces.w[p],
      h = pieces.h[p],
      ox = place.x[p],
      oy = place.y[p],
      page = pages[place.page[p]]
    const off = new Float32Array(3 * w * h),
      have = new Uint8Array(w * h)
    for (let x = pieces.start[p]; x < pieces.end[p]; x++) {
      const f = faces[x],
        l = labels[f]
      const us = [0, 1, 2].map((k) => unknown(idx[3 * f + k], l, false))
      const cs = [0, 1, 2].map((k) => {
        const q = [0, 0]
        atlas(f, k, q)
        return [q[0] - ox, q[1] - oy]
      })
      rasterTriangle(cs, w, h, (i, b0, b1, b2) => {
        for (let ch = 0; ch < 3; ch++) off[3 * i + ch] = b0 * g[ch][us[0]] + b1 * g[ch][us[1]] + b2 * g[ch][us[2]]
        have[i] = 1
      })
    }
    dilate(off, have, w, h, padding + 2)
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const t = j * w + i
        if (!have[t]) continue
        const o = ((oy + j) * P + ox + i) * 4
        for (let ch = 0; ch < 3; ch++) {
          const d = off[3 * t + ch]
          if (Math.abs(d) > largest) largest = Math.abs(d)
          page[o + ch] = page[o + ch] + d // Uint8ClampedArray clamps and rounds
        }
      }
    }
  }
  return { seamVertices: byVertex.size, unknowns: n, iterations, maxOffset: largest }
}

// The smoothness edges: every mesh edge once per label on it, as [v0, v1, label]
// triples. An edge inside a chart is one edge; a seam edge is one per side (each side
// smooths its own offsets along the seam); a boundary edge counts too. Taking only the
// edges walked low → high vertex instead lost every boundary edge walked the other way
// and one side of every seam.
export function smoothingEdges(labels, idx, adj) {
  const out = []
  for (let f = 0; f < labels.length; f++) {
    const l = labels[f]
    if (l < 0) continue
    for (let k = 0; k < 3; k++) {
      const g = adj[3 * f + k]
      if (g >= 0 && labels[g] === l && g < f) continue // the neighbour has it
      out.push(idx[3 * f + k], idx[3 * f + ((k + 1) % 3)], l)
    }
  }
  return out
}

// Jacobi-preconditioned CG on A = diag + Σ_e w_e (e_a − e_b)(e_a − e_b)ᵀ (the edge
// weights already sit in diag). Solves into x; returns the iterations used.
function cg(diag, ea, eb, ew, rhs, x) {
  const n = diag.length,
    E = ea.length
  const mul = (v, out) => {
    for (let i = 0; i < n; i++) out[i] = diag[i] * v[i]
    for (let e = 0; e < E; e++) {
      const a = ea[e],
        b = eb[e],
        w = ew[e]
      out[a] -= w * v[b]
      out[b] -= w * v[a]
    }
  }
  const r = Float64Array.from(rhs),
    z = new Float64Array(n),
    p = new Float64Array(n),
    q = new Float64Array(n)
  let bn = 0
  for (let i = 0; i < n; i++) {
    z[i] = r[i] / diag[i]
    p[i] = z[i]
    bn += rhs[i] * rhs[i]
  }
  if (!(bn > 0)) return 0
  let rz = 0
  for (let i = 0; i < n; i++) rz += r[i] * z[i]
  let it = 0
  for (; it < TEXTURE_TUNING.seamMaxIterations; it++) {
    let rr = 0
    for (let i = 0; i < n; i++) rr += r[i] * r[i]
    if (rr <= 1e-8 * bn) break // residual 1e-4 of the right side: hundredths of a level
    mul(p, q)
    let pq = 0
    for (let i = 0; i < n; i++) pq += p[i] * q[i]
    if (!(pq > 0)) break
    const alpha = rz / pq
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i]
      r[i] -= alpha * q[i]
      z[i] = r[i] / diag[i]
    }
    let rzNew = 0
    for (let i = 0; i < n; i++) rzNew += r[i] * z[i]
    const beta = rzNew / rz
    rz = rzNew
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i]
  }
  return it
}

// Texel centres (i, j) inside triangle cs (piece coordinates), with barycentrics.
// A small negative tolerance closes cracks between neighbouring faces.
function rasterTriangle(cs, w, h, visit) {
  const [[x0, y0], [x1, y1], [x2, y2]] = cs
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  if (!(Math.abs(area) > 1e-12)) return
  const inv = 1 / area,
    EPS = -1e-3
  const i0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))),
    i1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)))
  const j0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))),
    j1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)))
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const b0 = ((x1 - i) * (y2 - j) - (x2 - i) * (y1 - j)) * inv
      const b1 = ((x2 - i) * (y0 - j) - (x0 - i) * (y2 - j)) * inv
      const b2 = 1 - b0 - b1
      if (b0 < EPS || b1 < EPS || b2 < EPS) continue
      visit(j * w + i, b0, b1, b2)
    }
  }
}

// Spread values into uncovered texels from covered 4-neighbours, ring by ring, up to
// `passes` texels out (the padding; texels farther out are never sampled). A
// frontier walk: only texels next to covered ones are visited.
function dilate(off, have, w, h, passes) {
  let front = []
  const near = (t) => {
    const i = t % w,
      j = (t - i) / w
    return (i > 0 && have[t - 1]) || (i < w - 1 && have[t + 1]) || (j > 0 && have[t - w]) || (j < h - 1 && have[t + w])
  }
  for (let t = 0; t < w * h; t++) if (!have[t] && near(t)) front.push(t)
  const queued = new Uint8Array(w * h)
  for (let pass = 0; pass < passes && front.length; pass++) {
    const vals = new Float32Array(3 * front.length)
    front.forEach((t, k) => {
      const i = t % w
      let c = 0,
        r = 0,
        g = 0,
        b = 0
      for (const u of [i > 0 ? t - 1 : -1, i < w - 1 ? t + 1 : -1, t - w, t + w]) {
        if (u < 0 || u >= w * h || !have[u]) continue
        r += off[3 * u]
        g += off[3 * u + 1]
        b += off[3 * u + 2]
        c++
      }
      vals[3 * k] = r / c
      vals[3 * k + 1] = g / c
      vals[3 * k + 2] = b / c
    })
    const next = []
    front.forEach((t, k) => {
      off[3 * t] = vals[3 * k]
      off[3 * t + 1] = vals[3 * k + 1]
      off[3 * t + 2] = vals[3 * k + 2]
      have[t] = 1
    })
    for (const t of front) {
      const i = t % w
      for (const u of [i > 0 ? t - 1 : -1, i < w - 1 ? t + 1 : -1, t - w, t + w]) {
        if (u < 0 || u >= w * h || have[u] || queued[u]) continue
        queued[u] = 1
        next.push(u)
      }
    }
    front = next
  }
}

import { describe, it, expect } from 'vitest'
import { faceAdjacency } from './meshGraph.js'
import { packAtlas } from './packing.js'
import { meshGeometry, projectVertices, rasterizeDepth, viewGrid, localCamera, faceCandidates } from './visibility.js'
import { selectViews, mergeSmallCharts } from './labeling.js'
import { buildCharts } from './charts.js'
import { textureMesh } from './texture.js'
import { makeSampleMap } from '../../sfm/displayFrame.js'
import { undistortPixel } from '../../sfm/distortion.js'

// ── Synthetic scene ──────────────────────────────────────────────────────────
// Ground z = 0 over [−L, L]², a box [−B, B]² × [0, BH] standing on it, a smooth
// colourful texture T(x, y, z) painted on both, cameras looking down obliquely.

const L = 4, B = 1, BH = 1.5

function texel(x, y, z) {
  return [
    128 + 90 * Math.sin(2.1 * x + 0.7 * z),
    128 + 90 * Math.sin(1.7 * y - 0.9 * z),
    128 + 90 * Math.sin(1.3 * (x + y) + 1.1 * z),
  ]
}

function lookAt(C, target) {
  const f = norm(sub(target, C))
  const right = norm(cross(f, [0, 0, 1]))
  const down = cross(f, right)
  const R = [right, down, f]
  const t = R.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]))
  return { R, t }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n] }

// Nearest hit of a ray with the box (slabs) or the ground plane.
function trace(C, d) {
  let best = Infinity
  // Box.
  let t0 = -Infinity, t1 = Infinity
  const lo = [-B, -B, 0], hi = [B, B, BH]
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (C[a] < lo[a] || C[a] > hi[a]) { t0 = Infinity; break } continue }
    let ta = (lo[a] - C[a]) / d[a], tb = (hi[a] - C[a]) / d[a]
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb)
  }
  if (t0 <= t1 && t0 > 0) best = t0
  if (d[2] < 0) { const tg = -C[2] / d[2]; if (tg > 0 && tg < best) best = tg }
  return best
}

// A photo of the scene. `dist` (a distortion bag) makes the photo record a real lens:
// each recorded pixel is undistorted to the pinhole ray it saw. `gain` scales exposure.
function renderPhoto(cam, K, W, H, { dist = null, gain = [1, 1, 1] } = {}) {
  const data = new Uint8ClampedArray(W * H * 4)
  const { R } = cam
  const C = [0, 1, 2].map((j) => -(R[0][j] * cam.t[0] + R[1][j] * cam.t[1] + R[2][j] * cam.t[2]))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = dist ? undistortPixel(x, y, K, dist) : { x, y }
      const xn = (p.x - K.cx) / K.fx, yn = (p.y - K.cy) / K.fy
      const d = norm([0, 1, 2].map((j) => R[0][j] * xn + R[1][j] * yn + R[2][j]))
      const tHit = trace(C, d)
      const o = 4 * (y * W + x)
      if (!isFinite(tHit)) { data[o] = data[o + 1] = data[o + 2] = 0; data[o + 3] = 255; continue }
      const c = texel(C[0] + tHit * d[0], C[1] + tHit * d[1], C[2] + tHit * d[2])
      for (let k = 0; k < 3; k++) data[o + k] = c[k] * gain[k]
      data[o + 3] = 255
    }
  }
  return { data, width: W, height: H }
}

// Ground grid (cells under the box left out) plus the box's top and four sides.
function sceneMesh(step = 0.2) {
  const pos = [], idx = [], at = new Map()
  const vert = (p) => { // welded: neighbouring quads share corners
    const k = p.map((x) => x.toFixed(6)).join(',')
    if (!at.has(k)) { at.set(k, pos.length / 3); pos.push(...p) }
    return at.get(k)
  }
  const quad = (a, b, c, d) => { // counter-clockwise seen from outside
    const [i, j, k, l] = [a, b, c, d].map(vert)
    idx.push(i, j, k, i, k, l)
  }
  const n = Math.round((2 * L) / step)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -L + i * step, y0 = -L + j * step, x1 = x0 + step, y1 = y0 + step
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
      if (Math.abs(cx) < B && Math.abs(cy) < B) continue
      quad([x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0])
    }
  }
  const m = Math.round((2 * B) / step), k = Math.round(BH / step)
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const x0 = -B + i * step, y0 = -B + j * step
      quad([x0, y0, BH], [x0 + step, y0, BH], [x0 + step, y0 + step, BH], [x0, y0 + step, BH])
    }
  }
  for (let j = 0; j < k; j++) {
    const z0 = j * BH / k, z1 = (j + 1) * BH / k
    for (let i = 0; i < m; i++) {
      const a = -B + i * step, b = a + step
      quad([a, -B, z0], [b, -B, z0], [b, -B, z1], [a, -B, z1])   // −y side, normal −y
      quad([b, B, z0], [a, B, z0], [a, B, z1], [b, B, z1])       // +y side
      quad([-B, b, z0], [-B, a, z0], [-B, a, z1], [-B, b, z1])   // −x side
      quad([B, a, z0], [B, b, z0], [B, b, z1], [B, a, z1])       // +x side
    }
  }
  return { pos: Float64Array.from(pos), idx: Uint32Array.from(idx) }
}

const W = 320, H = 240
const K0 = { fx: 260, fy: 260, cx: 159.5, cy: 119.5 }

function sceneViews(n = 8, opts = {}) {
  const views = [], photos = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    const C = [7 * Math.cos(a), 7 * Math.sin(a), 6]
    const cam = lookAt(C, [0, 0, 0.3])
    const dist = opts.dist ?? null
    const gain = opts.gains?.[i] ?? [1, 1, 1]
    views.push({ ...cam, K: K0, width: W, height: H })
    photos.push({ photo: renderPhoto(cam, K0, W, H, { dist, gain }), dist })
  }
  return { views, photos }
}

// loadPhoto as the worker builds it: the native photo plus the texel-grid → photo map.
const photoLoader = (photos) => async (vi, scale) => {
  const { photo, dist } = photos[vi]
  const map = makeSampleMap({ K: K0, dist, outScale: scale })
  return { ...photo, map }
}

// Sample the atlas at random points of every textured output face and compare with T.
function atlasError(out, samplesPerFace = 3) {
  const pageOf = new Int32Array(out.count)
  for (const g of out.groups) pageOf.fill(g.page, g.start, g.start + g.count)
  let sum = 0, n = 0, worst = 0, over10 = 0
  const rgb = [0, 0, 0]
  for (let f = 0; f < out.count; f++) {
    const [a, b, c] = [out.idx[3 * f], out.idx[3 * f + 1], out.idx[3 * f + 2]]
    if (out.uv[2 * a] === out.uv[2 * b] && out.uv[2 * a] === out.uv[2 * c]
      && out.uv[2 * a + 1] === out.uv[2 * b + 1] && out.uv[2 * a + 1] === out.uv[2 * c + 1]) continue // flat cell
    const page = out.pages[pageOf[f]]
    for (let s = 0; s < samplesPerFace; s++) {
      let l1 = ((f * 7 + s * 13) % 17) / 17 * 0.8 + 0.1, l2 = ((f * 11 + s * 5) % 19) / 19 * 0.8 + 0.1
      if (l1 + l2 > 1) { l1 = 1 - l1; l2 = 1 - l2 }
      const l0 = 1 - l1 - l2
      const P = [0, 1, 2].map((k) => l0 * out.pos[3 * a + k] + l1 * out.pos[3 * b + k] + l2 * out.pos[3 * c + k])
      const u = l0 * out.uv[2 * a] + l1 * out.uv[2 * b] + l2 * out.uv[2 * c]
      const v = l0 * out.uv[2 * a + 1] + l1 * out.uv[2 * b + 1] + l2 * out.uv[2 * c + 1]
      bilinear(page, u * page.width - 0.5, v * page.height - 0.5, rgb)
      const want = texel(...P)
      const e = (Math.abs(rgb[0] - want[0]) + Math.abs(rgb[1] - want[1]) + Math.abs(rgb[2] - want[2])) / 3
      sum += e; n++
      if (e > 10) over10++
      if (e > worst) worst = e
    }
  }
  return { mean: sum / n, worst, n, over10: over10 / n }
}
function bilinear(page, x, y, out) {
  const { data, width: w, height: h } = page
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0
  for (let c = 0; c < 3; c++) {
    const t = data[4 * (y0 * w + x0) + c] * (1 - fx) + data[4 * (y0 * w + x1) + c] * fx
    const b = data[4 * (y1 * w + x0) + c] * (1 - fx) + data[4 * (y1 * w + x1) + c] * fx
    out[c] = t * (1 - fy) + b * fy
  }
}

// ── Units ─────────────────────────────────────────────────────────────────────

describe('faceAdjacency', () => {
  it('links the faces across shared edges, reciprocally', () => {
    // Two triangles sharing edge 1–2, and a third sharing 2–3 with the second.
    const idx = Uint32Array.of(0, 1, 2, 2, 1, 3, 3, 4, 2)
    const { adj, rev } = faceAdjacency(idx, 5)
    expect(adj[0 * 3 + 1]).toBe(1) // face 0 edge 1–2
    expect(adj[1 * 3 + 0]).toBe(0) // face 1 edge 2–1
    expect(adj[1 * 3 + 2]).toBe(2) // face 1 edge 3–2 = face 2 edge 2–3
    expect(adj[0 * 3 + 0]).toBe(-1) // edge 0–1 is a boundary
    for (let s = 0; s < 9; s++) if (adj[s] >= 0) expect(adj[3 * adj[s] + rev[s]]).toBe(Math.floor(s / 3))
  })
})

describe('packAtlas (skyline)', () => {
  it('places every rectangle inside a page without overlap', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const n = 600, P = 256
    const w = Int32Array.from({ length: n }, () => 2 + Math.floor(rnd() * 40))
    const h = Int32Array.from({ length: n }, () => 2 + Math.floor(rnd() * 40))
    const pk = packAtlas(w, h, P)
    const occ = pk.pageHeights.map((ph) => new Uint8Array(P * ph))
    let area = 0, outside = 0, overlap = 0
    for (let i = 0; i < n; i++) {
      const ph = pk.pageHeights[pk.page[i]]
      if (pk.x[i] + w[i] > P || pk.y[i] + h[i] > ph) { outside++; continue }
      for (let y = 0; y < h[i]; y++) for (let x = 0; x < w[i]; x++) {
        const o = (pk.y[i] + y) * P + pk.x[i] + x
        if (occ[pk.page[i]][o]) overlap++
        occ[pk.page[i]][o] = 1
      }
      area += w[i] * h[i]
    }
    expect(outside).toBe(0)
    expect(overlap).toBe(0)
    const total = pk.pageHeights.reduce((a, ph) => a + ph * P, 0)
    expect(area / total).toBeGreaterThan(0.85)
  })
})

describe('rasterizeDepth', () => {
  it('matches the analytic depth of a plane and leaves no holes', () => {
    const { pos, idx } = sceneMesh(0.2)
    const geom = meshGeometry(pos, idx)
    const view = { ...lookAt([0, -6, 8], [0, 0, 0]), K: K0, width: W, height: H }
    const cam = localCamera(view, geom.origin)
    const grid = viewGrid(view, 1e9)
    const proj = projectVertices(geom.P, cam, grid)
    const depth = rasterizeDepth(proj, idx, grid.width, grid.height)
    // Compare with ray tracing at a lattice of pixels.
    const C = [0, -6, 8]
    let checked = 0
    for (let y = 5; y < H; y += 23) {
      for (let x = 5; x < W; x += 29) {
        const xn = (x - K0.cx) / K0.fx, yn = (y - K0.cy) / K0.fy
        const d = [0, 1, 2].map((j) => view.R[0][j] * xn + view.R[1][j] * yn + view.R[2][j])
        const tHit = trace(C, d) // d has unit z in the camera frame, so t is the depth
        if (!isFinite(tHit) || Math.max(Math.abs(C[0] + tHit * d[0]), Math.abs(C[1] + tHit * d[1])) > L - 0.01) continue
        expect(Math.abs(depth[y * W + x] - tHit) / tHit).toBeLessThan(2e-3)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40)
  })
})

describe('faceCandidates', () => {
  it('drops faces the box hides and settles the winding', async () => {
    const { pos, idx } = sceneMesh(0.2)
    const geom = meshGeometry(pos, idx)
    const view = { ...lookAt([0, -6, 3], [0, 0, 0]), K: K0, width: W, height: H }
    const cand = await faceCandidates(geom, idx, [view], { bufferSide: 320, occludedFallback: false })
    expect(cand.orientation).toBe(1)
    // Ground just behind the box (seen from −y) is hidden; ground in front is seen.
    let hidden = 0, hiddenSeen = 0, front = 0, frontSeen = 0
    for (let f = 0; f < geom.nFaces; f++) {
      const cx = geom.centroid[3 * f] + geom.origin[0], cy = geom.centroid[3 * f + 1] + geom.origin[1]
      const cz = geom.centroid[3 * f + 2] + geom.origin[2]
      if (cz > 0.01 || Math.abs(cx) > 0.6) continue
      if (cy > 1.3 && cy < 2.5) { hidden++; if (cand.count[f]) hiddenSeen++ }
      if (cy < -1.3 && cy > -2.5) { front++; if (cand.count[f]) frontSeen++ }
    }
    expect(hidden).toBeGreaterThan(10)
    expect(hiddenSeen).toBe(0)
    expect(frontSeen).toBe(front)
    // The box's far side (+y) faces away and is never a candidate.
    for (let f = 0; f < geom.nFaces; f++) {
      if (geom.normal[3 * f + 1] > 0.9) expect(cand.count[f]).toBe(0)
    }
    // With the fallback, the hidden ground gets the view that hides least of it; the
    // far side, facing away, still gets nothing.
    const fb = await faceCandidates(geom, idx, [view], { bufferSide: 320 })
    expect(fb.fallbackFaces).toBeGreaterThanOrEqual(hidden)
    for (let f = 0; f < geom.nFaces; f++) if (geom.normal[3 * f + 1] > 0.9) expect(fb.count[f]).toBe(0)
  })

  it('treats an unoriented mesh with |cos|', async () => {
    const { pos, idx } = sceneMesh(0.4)
    // Flip every other face.
    for (let f = 0; f < idx.length / 3; f += 2) { const t = idx[3 * f + 1]; idx[3 * f + 1] = idx[3 * f + 2]; idx[3 * f + 2] = t }
    const geom = meshGeometry(pos, idx)
    const { views } = sceneViews(4)
    const cand = await faceCandidates(geom, idx, views, { bufferSide: 320 })
    expect(cand.orientation).toBe(0)
  })
})

describe('selectViews', () => {
  it('takes the best view without smoothing and removes speckle with it', () => {
    // A strip of 6 faces; all see views 0 and 1, view 0 is better except on face 2.
    const F = 6, K = 2
    const adj = new Int32Array(3 * F).fill(-1), rev = new Int8Array(3 * F).fill(-1)
    for (let f = 0; f < F - 1; f++) { adj[3 * f] = f + 1; rev[3 * f] = 1; adj[3 * (f + 1) + 1] = f; rev[3 * (f + 1) + 1] = 0 }
    const count = new Uint8Array(F).fill(2)
    const view = new Uint16Array(F * K), score = new Float32Array(F * K)
    for (let f = 0; f < F; f++) {
      const best = f === 2 ? 1 : 0
      view[f * K] = best; score[f * K] = 1
      view[f * K + 1] = 1 - best; score[f * K + 1] = 0.9
    }
    const cand = { K, count, view, score }
    expect(Array.from(selectViews(cand, adj, rev, { smoothness: 0 }))).toEqual([0, 0, 1, 0, 0, 0])
    expect(Array.from(selectViews(cand, adj, rev, { smoothness: 0.5 }))).toEqual([0, 0, 0, 0, 0, 0])
  })
})

describe('mergeSmallCharts', () => {
  it('moves a small chart to its neighbours\' photo only when every face has it', () => {
    // A strip of 8 faces: 0–5 on view 0, 6 on view 1 (a 1-face chart), 7 on view 0.
    const F = 8, K = 2
    const adj = new Int32Array(3 * F).fill(-1)
    for (let f = 0; f < F - 1; f++) { adj[3 * f] = f + 1; adj[3 * (f + 1) + 1] = f }
    const count = new Uint8Array(F).fill(2), view = new Uint16Array(F * K), score = new Float32Array(F * K).fill(1)
    for (let f = 0; f < F; f++) { view[f * K] = 0; view[f * K + 1] = 1 }
    const labels = Int32Array.of(0, 0, 0, 0, 0, 0, 1, 0)
    expect(mergeSmallCharts(labels, adj, { K, count, view, score }, { minFaces: 3 })).toBe(1)
    expect(labels[6]).toBe(0)
    // Without view 0 among face 6's candidates it stays.
    const l2 = Int32Array.of(0, 0, 0, 0, 0, 0, 1, 0)
    view[6 * K] = 1; count[6] = 1
    count[7] = 1 // face 7 (itself a 1-face chart) can only take view 0
    expect(mergeSmallCharts(l2, adj, { K, count, view, score }, { minFaces: 3 })).toBe(0)
  })
})

describe('buildCharts', () => {
  it('groups connected faces with the same label', () => {
    const adj = Int32Array.of(1, -1, -1, 0, 2, -1, 1, 3, -1, 2, -1, -1)
    const ch = buildCharts(Int32Array.of(4, 4, 7, 7), adj)
    expect(ch.nCharts).toBe(2)
    expect(Array.from(ch.chartView)).toEqual([4, 7])
  })
})

// ── End to end ──────────────────────────────────────────────────────────────

describe('textureMesh', () => {
  it('reproduces the scene texture from the photos', async () => {
    const mesh = sceneMesh(0.2)
    const { views, photos } = sceneViews(8)
    const logs = []
    const out = await textureMesh(mesh, views, { pageSize: 1024, maxPages: 4 },
      { loadPhoto: photoLoader(photos), onLog: (m) => logs.push(m) })
    expect(logs.some((m) => /faces seen/.test(m))).toBe(true)
    expect(out.count).toBe(mesh.idx.length / 3)
    expect(out.summary.seenFaces).toBeGreaterThan(0.9 * out.summary.faces)
    expect(out.groups.reduce((a, g) => a + g.count, 0)).toBe(out.count)
    for (let i = 0; i < out.uv.length; i++) { expect(out.uv[i]).toBeGreaterThan(0); expect(out.uv[i]).toBeLessThan(1) }
    const err = atlasError(out)
    expect(err.n).toBeGreaterThan(1000)
    expect(err.mean).toBeLessThan(1)
    // Large errors only where a face meets its view's silhouette (bilinear takes in the
    // background across it): a handful of samples on the box's vertical edges.
    expect(err.over10).toBeLessThan(0.005)
  })

  it('samples a distorted lens through the sample map', async () => {
    const mesh = sceneMesh(0.2)
    const dist = { k1: -0.15, k2: 0.03, k3: 0, p1: 0.001, p2: -0.001 }
    const { views, photos } = sceneViews(8, { dist })
    const out = await textureMesh(mesh, views, { pageSize: 1024, maxPages: 4 }, { loadPhoto: photoLoader(photos) })
    expect(atlasError(out).mean).toBeLessThan(5)
  })

  it('levels the exposure of photos that disagree', async () => {
    const mesh = sceneMesh(0.2)
    const gains = [[1.25, 1.25, 1.25], [0.8, 0.85, 0.8], [1, 1, 1], [1.2, 1.1, 1], [0.85, 0.85, 0.9], [1, 1, 1], [1.15, 1.15, 1.15], [0.9, 0.9, 0.9]]
    const { views, photos } = sceneViews(8, { gains })
    const run = (levelColours) => textureMesh(mesh, views, { pageSize: 1024, maxPages: 4, levelColours }, { loadPhoto: photoLoader(photos) })
    const off = await run(false), on = await run(true)
    // Seams: the colour step across edges between faces of different pieces.
    expect(seamStep(on)).toBeLessThan(0.7 * seamStep(off))
    // The run's own figure agrees, and seam levelling is part of it.
    expect(on.summary.seams.step).toBeLessThan(0.7 * off.summary.seams.step)
    expect(on.summary.seamLevel.seamVertices).toBeGreaterThan(0)
    const gainsOnly = await textureMesh(mesh, views, { pageSize: 1024, maxPages: 4, seamLevelling: false }, { loadPhoto: photoLoader(photos) })
    expect(on.summary.seams.step).toBeLessThan(gainsOnly.summary.seams.step)
  })

  it('leaves faces no photo sees out when asked', async () => {
    const mesh = sceneMesh(0.2)
    const { views, photos } = sceneViews(2) // two views leave much of the scene unseen
    const keep = await textureMesh(mesh, views, { pageSize: 1024, maxPages: 4 }, { loadPhoto: photoLoader(photos) })
    const drop = await textureMesh(mesh, views, { pageSize: 1024, maxPages: 4, unseen: 'remove' }, { loadPhoto: photoLoader(photos) })
    expect(keep.summary.unseenFaces).toBeGreaterThan(0)
    expect(keep.count).toBe(mesh.idx.length / 3)
    expect(drop.count).toBe(keep.count - keep.summary.unseenFaces)
    expect(drop.idx.length).toBe(3 * drop.count)
    expect(atlasError(drop).mean).toBeLessThan(1)
  })

  it('welds an unwelded mesh first, so charts still form', async () => {
    const { pos, idx } = sceneMesh(0.4)
    // Every face its own three corners, as in an STL.
    const soup = new Float64Array(idx.length * 3), soupIdx = new Uint32Array(idx.length)
    for (let i = 0; i < idx.length; i++) { soup.set(pos.subarray(3 * idx[i], 3 * idx[i] + 3), 3 * i); soupIdx[i] = i }
    const { views, photos } = sceneViews(8)
    const logs = []
    const out = await textureMesh({ pos: soup, idx: soupIdx }, views, { pageSize: 1024, maxPages: 4 },
      { loadPhoto: photoLoader(photos), onLog: (m) => logs.push(m) })
    expect(logs.some((m) => /welded first/.test(m))).toBe(true)
    expect(out.summary.charts).toBeLessThan(out.summary.faces / 10)
  })

  it('lowers the texel scale until the atlas fits the page cap', async () => {
    const mesh = sceneMesh(0.2)
    const { views, photos } = sceneViews(8)
    const out = await textureMesh(mesh, views, { pageSize: 256, maxPages: 1 }, { loadPhoto: photoLoader(photos) })
    expect(out.summary.pages).toBe(1)
    expect(out.summary.scale).toBeLessThan(1)
  })
})

// Mean colour difference across output edges whose two sides sit in different pieces
// (a seam), sampled at the edge midpoint on each side.
function seamStep(out) {
  const pageOf = new Int32Array(out.count)
  for (const g of out.groups) pageOf.fill(g.page, g.start, g.start + g.count)
  // Edges by their end positions (vertices are split between pieces).
  const key = (v) => [0, 1, 2].map((k) => out.pos[3 * v + k].toFixed(6)).join(',')
  const edges = new Map()
  for (let f = 0; f < out.count; f++) {
    for (let k = 0; k < 3; k++) {
      const a = out.idx[3 * f + k], b = out.idx[3 * f + (k + 1) % 3]
      const ka = key(a), kb = key(b), e = ka < kb ? ka + '|' + kb : kb + '|' + ka
      if (!edges.has(e)) edges.set(e, [])
      edges.get(e).push([f, a, b])
    }
  }
  let sum = 0, n = 0
  const ca = [0, 0, 0], cb = [0, 0, 0]
  for (const list of edges.values()) {
    if (list.length !== 2) continue
    const [[f1, a1, b1], [f2, a2, b2]] = list
    if (a1 === b2 || a1 === a2) continue // shared vertices: same piece
    const mid = (p, a, b) => [(out.uv[2 * a] + out.uv[2 * b]) / 2 * p.width - 0.5, (out.uv[2 * a + 1] + out.uv[2 * b + 1]) / 2 * p.height - 0.5]
    const p1 = out.pages[pageOf[f1]], p2 = out.pages[pageOf[f2]]
    bilinear(p1, ...mid(p1, a1, b1), ca)
    bilinear(p2, ...mid(p2, a2, b2), cb)
    sum += (Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2])) / 3
    n++
  }
  return sum / n
}

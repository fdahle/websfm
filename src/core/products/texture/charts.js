// Texture charts (plan-texture ▸ Pipeline 3). Pure.
//
// A chart is a connected group of faces that took the same view. Its UVs are where its
// corners project in that view, so no unwrapping is needed: the chart's pixels are a
// rectangle of the photo. A chart is cut into *pieces* when its rectangle is larger than
// a page, or mostly empty (a thin diagonal strip wastes atlas). Cutting inside one view
// leaves no visible seam: both halves sample the same photo, and the padding of each
// holds the other's neighbouring pixels.

import { localCamera } from './visibility.js'
import { TEXTURE_TUNING } from '../../tuning.js'

// Union-find over same-label neighbours. → { nCharts, chartView, start, faces }: the
// faces of chart c are faces[start[c] .. start[c+1]). Faces with label −1 are in no chart.
export function buildCharts(labels, adj) {
  const F = labels.length
  const parent = new Int32Array(F)
  for (let f = 0; f < F; f++) parent[f] = f
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  for (let f = 0; f < F; f++) {
    if (labels[f] < 0) continue
    for (let k = 0; k < 3; k++) {
      const g = adj[3 * f + k]
      if (g > f && labels[g] === labels[f]) {
        const a = find(f),
          b = find(g)
        if (a !== b) parent[a < b ? b : a] = a < b ? a : b
      }
    }
  }
  const chartOf = new Int32Array(F).fill(-1)
  const chartView = []
  for (let f = 0; f < F; f++) {
    if (labels[f] < 0) continue
    const r = find(f)
    if (chartOf[r] < 0) {
      chartOf[r] = chartView.length
      chartView.push(labels[f])
    }
    chartOf[f] = chartOf[r]
  }
  const n = chartView.length
  const start = new Int32Array(n + 1)
  for (let f = 0; f < F; f++) if (chartOf[f] >= 0) start[chartOf[f] + 1]++
  for (let c = 0; c < n; c++) start[c + 1] += start[c]
  const fill = start.slice(0, n),
    faces = new Int32Array(start[n])
  for (let f = 0; f < F; f++) if (chartOf[f] >= 0) faces[fill[chartOf[f]]++] = f
  return { nCharts: n, chartView: Int32Array.from(chartView), start, faces }
}

// Each labelled face's corners in its view's full-resolution pinhole pixels:
// Float64Array(6F), [u0, v0, u1, v1, u2, v2] per face (NaN for unlabelled faces).
export function cornerPixels(geom, idx, labels, views) {
  const F = labels.length,
    P = geom.P
  const out = new Float64Array(6 * F).fill(NaN)
  const cams = new Array(views.length)
  for (let f = 0; f < F; f++) {
    const vi = labels[f]
    if (vi < 0) continue
    const cam = cams[vi] ?? (cams[vi] = localCamera(views[vi], geom.origin))
    const { r, t, K } = cam
    for (let k = 0; k < 3; k++) {
      const p = 3 * idx[3 * f + k]
      const X = P[p],
        Y = P[p + 1],
        Z = P[p + 2]
      const z = r[6] * X + r[7] * Y + r[8] * Z + t[2]
      out[6 * f + 2 * k] = K.fx * ((r[0] * X + r[1] * Y + r[2] * Z + t[0]) / z) + K.cx
      out[6 * f + 2 * k + 1] = K.fy * ((r[3] * X + r[4] * Y + r[5] * Z + t[1]) / z) + K.cy
    }
  }
  return out
}

// Cut the charts into pieces at texel scale s (texels per full-resolution pixel).
// A texel (i, j) of a piece is centred on the scaled-grid pixel (x0 + i, y0 + j), i.e.
// the pinhole pixel fromScaledPx(x0 + i, s) (geometry.js). → { pieces, faces, tooBig }:
// pieces = { view, start, end, x0, y0, w, h } arrays (the faces of piece p are
// faces[start[p] .. end[p])); `tooBig` when one face alone does not fit a page, which
// the caller answers with a smaller s.
export function chartPieces(charts, px, s, opts = {}) {
  const {
    pageSize,
    padding = TEXTURE_TUNING.padding,
    minFill = TEXTURE_TUNING.minFill,
    minSplitTexels = TEXTURE_TUNING.minSplitTexels,
  } = opts
  const faces = charts.faces.slice()
  const out = { view: [], start: [], end: [], x0: [], y0: [], w: [], h: [] }
  const g = (u) => (u + 0.5) * s - 0.5
  let tooBig = false
  // Bounds and triangle area of faces[a..b) on the scaled grid.
  const measure = (a, b) => {
    let minx = Infinity,
      miny = Infinity,
      maxx = -Infinity,
      maxy = -Infinity,
      area = 0
    for (let x = a; x < b; x++) {
      const o = 6 * faces[x]
      const ux = g(px[o]),
        uy = g(px[o + 1]),
        vx = g(px[o + 2]),
        vy = g(px[o + 3]),
        wx = g(px[o + 4]),
        wy = g(px[o + 5])
      minx = Math.min(minx, ux, vx, wx)
      maxx = Math.max(maxx, ux, vx, wx)
      miny = Math.min(miny, uy, vy, wy)
      maxy = Math.max(maxy, uy, vy, wy)
      area += 0.5 * Math.abs((vx - ux) * (wy - uy) - (wx - ux) * (vy - uy))
    }
    return { minx, miny, maxx, maxy, area }
  }
  const keys = new Float64Array(faces.length)
  const stack = []
  for (let c = 0; c < charts.nCharts; c++) {
    const view = charts.chartView[c]
    stack.push(charts.start[c], charts.start[c + 1])
    while (stack.length) {
      const b = stack.pop(),
        a = stack.pop()
      const m = measure(a, b)
      const x0 = Math.floor(m.minx) - padding,
        y0 = Math.floor(m.miny) - padding
      const w = Math.ceil(m.maxx) + padding - x0 + 1,
        h = Math.ceil(m.maxy) + padding - y0 + 1
      const inner = (w - 2 * padding) * (h - 2 * padding)
      const oversize = w > pageSize || h > pageSize
      const sparse = inner > minSplitTexels && m.area < minFill * inner
      if ((oversize || sparse) && b - a > 1) {
        // Bisect at the median centroid along the longer side.
        const alongX = m.maxx - m.minx >= m.maxy - m.miny
        const off = alongX ? 0 : 1
        for (let x = a; x < b; x++) {
          const o = 6 * faces[x]
          keys[x] = px[o + off] + px[o + 2 + off] + px[o + 4 + off]
        }
        sortRangeByKey(faces, keys, a, b)
        const mid = (a + b) >> 1
        stack.push(a, mid, mid, b)
        continue
      }
      if (oversize) tooBig = true
      out.view.push(view)
      out.start.push(a)
      out.end.push(b)
      out.x0.push(x0)
      out.y0.push(y0)
      out.w.push(w)
      out.h.push(h)
    }
  }
  const pieces = {
    count: out.view.length,
    view: Int32Array.from(out.view),
    start: Int32Array.from(out.start),
    end: Int32Array.from(out.end),
    x0: Int32Array.from(out.x0),
    y0: Int32Array.from(out.y0),
    w: Int32Array.from(out.w),
    h: Int32Array.from(out.h),
  }
  return { pieces, faces, tooBig }
}

// Sort faces[a..b) (and keys alongside) by key.
function sortRangeByKey(faces, keys, a, b) {
  const n = b - a
  const ord = new Int32Array(n)
  for (let i = 0; i < n; i++) ord[i] = a + i
  ord.sort((x, y) => keys[x] - keys[y])
  const f2 = new Int32Array(n),
    k2 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    f2[i] = faces[ord[i]]
    k2[i] = keys[ord[i]]
  }
  faces.set(f2, a)
  keys.set(k2, a)
}

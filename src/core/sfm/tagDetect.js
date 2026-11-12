// AprilTag tag36h11 or ArUco targets in a grey image (Tools ▸ Images ▸ Detect targets, plan-after-
// 0.7 ▸ TGT): each tag's id and centre, without knowing where to look. Pure: grey in,
// detections out (the worker reads the photo, core/sfm/tags/tag36h11.js holds the codes).
//
// 1. Adaptive threshold: a pixel is dark below its neighbourhood's mean (integral image).
// 2. Dark connected components the size of a tag; each one's convex hull; the hull's
//    quadrilateral (the farthest pair of points, then the farthest point on either side).
// 3. Each side refined to sub-pixel: the strongest brightness step across it, sampled
//    along it, fitted with a line; the corners are where neighbouring lines meet.
// 4. A homography from the tag's 8-cell box to the corners; the 6 × 6 data cells read
//    against the black ring and the white one around it, in each of the four rotations,
//    and matched to the family's codes (a few bits may be wrong: h11 corrects 5).
//
//   gray   { data: Float32Array (0–255), width, height }, pixel centres at integers
// detectTags → [{ id, hamming, score, center: { x, y }, corners: [{ x, y } ×4, the tag's
//   top-left, top-right, bottom-right, bottom-left], contrast }]

import * as TAG36H11 from './tags/tag36h11.js'
import { hamming } from './tags/familyDistance.js'

// The family a search reads unless told otherwise. A family is { NAME, WIDTH_AT_BORDER
// (the black box, in cells), NBITS, MIN_HAMMING, BIT_X, BIT_Y, CODES, DARK_MAX? }:
// tags/tag36h11.js, or an ArUco dictionary (tags/aruco.js arucoFamily).
export const DEFAULT_FAMILY = TAG36H11

// Integral image (sums over [0, x) × [0, y)), (w + 1) × (h + 1).
function integral({ data, width, height }) {
  const W = width + 1
  const s = new Float64Array(W * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += data[y * width + x]
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row
    }
  }
  return s
}

// 1 where a pixel is darker than its (2r + 1)² neighbourhood's mean by more than `c`.
export function adaptiveThreshold(gray, r, c = 7) {
  const { data, width, height } = gray
  const s = integral(gray)
  const W = width + 1
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r),
      y1 = Math.min(height, y + r + 1)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r),
        x1 = Math.min(width, x + r + 1)
      const sum = s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0]
      const mean = sum / ((x1 - x0) * (y1 - y0))
      out[y * width + x] = data[y * width + x] < mean - c ? 1 : 0
    }
  }
  return out
}

// 4-connected components of the 1-pixels: Int32Array of labels (0 = none) and, per label,
// { n, x0, y0, x1, y1, rows: Map y → [xmin, xmax] }.
function components(mask, width, height) {
  const label = new Int32Array(width * height)
  const parent = [0]
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]]
    return a
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!mask[i]) continue
      const up = y ? label[i - width] : 0,
        left = x ? label[i - 1] : 0
      if (!up && !left) {
        parent.push(parent.length)
        label[i] = parent.length - 1
      } else if (up && left) {
        const a = find(up),
          b = find(left)
        label[i] = Math.min(a, b)
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
      } else label[i] = up || left
    }
  const comps = new Map()
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!label[i]) continue
      const l = (label[i] = find(label[i]))
      let c = comps.get(l)
      if (!c) comps.set(l, (c = { n: 0, x0: x, y0: y, x1: x, y1: y, rows: new Map() }))
      c.n++
      if (x < c.x0) c.x0 = x
      if (x > c.x1) c.x1 = x
      if (y > c.y1) c.y1 = y
      const r = c.rows.get(y)
      if (!r) c.rows.set(y, [x, x])
      else if (x > r[1]) r[1] = x
    }
  return comps
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

// Convex hull (monotone chain) of points sorted by x then y.
function hull(points) {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const lower = [],
    upper = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop()
    lower.push(q)
  }
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

const polyArea = (q) =>
  q.reduce((s, a, i) => s + (a.x * q[(i + 1) % q.length].y - q[(i + 1) % q.length].x * a.y), 0) / 2

// The quadrilateral of a convex hull: its longest diagonal, and the farthest point from
// it on either side. Clockwise on screen (y down); null when it is not square-ish.
function hullQuad(h) {
  let best = -1,
    a = 0,
    b = 0
  for (let i = 0; i < h.length; i++)
    for (let j = i + 1; j < h.length; j++) {
      const d = (h[i].x - h[j].x) ** 2 + (h[i].y - h[j].y) ** 2
      if (d > best) [best, a, b] = [d, i, j]
    }
  let c = null,
    d = null,
    cMax = 0,
    dMin = 0
  for (const q of h) {
    const s = cross(h[a], h[b], q)
    if (s > cMax) [cMax, c] = [s, q]
    if (s < dMin) [dMin, d] = [s, q]
  }
  if (!c || !d) return null
  let quad = [h[a], c, h[b], d]
  if (polyArea(quad) < 0) quad = [h[a], d, h[b], c]
  const hullArea = Math.abs(polyArea(h))
  const area = polyArea(quad)
  if (!(area > 0.85 * hullArea)) return null
  const sides = quad.map((p, i) => Math.hypot(quad[(i + 1) % 4].x - p.x, quad[(i + 1) % 4].y - p.y))
  if (Math.max(...sides) > 3 * Math.min(...sides)) return null
  return quad
}

function sample({ data, width, height }, x, y) {
  if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return NaN
  const x0 = Math.min(width - 2, Math.floor(x)),
    y0 = Math.min(height - 2, Math.floor(y))
  const tx = x - x0,
    ty = y - y0,
    i = y0 * width + x0
  return (
    (1 - ty) * ((1 - tx) * data[i] + tx * data[i + 1]) + ty * ((1 - tx) * data[i + width] + tx * data[i + width + 1])
  )
}

// One side from p to q refined: along it, the strongest step across it within ±reach,
// to sub-pixel; a total-least-squares line through those points → { n: [nx, ny], d }
// with n·x = d, or null.
function refineSide(gray, p, q, reach) {
  const L = Math.hypot(q.x - p.x, q.y - p.y)
  const tx = (q.x - p.x) / L,
    ty = (q.y - p.y) / L
  const nx = -ty,
    ny = tx
  let pts = []
  const N = Math.max(8, Math.min(40, Math.round(L / 2)))
  for (let k = 1; k < N; k++) {
    const f = 0.15 + (0.7 * k) / N
    const cx = p.x + f * (q.x - p.x),
      cy = p.y + f * (q.y - p.y)
    const step = 0.25
    const g = []
    for (let s = -reach; s <= reach + 1e-9; s += step) g.push(sample(gray, cx + nx * s, cy + ny * s))
    // The step across the side: the central difference, its peak to sub-sample by a
    // parabola through the same measure either side.
    const G = (i) => (i >= 1 && i < g.length - 1 ? Math.abs(g[i + 1] - g[i - 1]) / (2 * step) : 0)
    let bestG = 0,
      bestI = -1
    for (let i = 1; i < g.length - 1; i++) {
      const d = G(i)
      if (d > bestG) [bestG, bestI] = [d, i]
    }
    let bestS = null
    if (bestI > 0) {
      const gm = G(bestI - 1),
        gp = G(bestI + 1),
        den = gm - 2 * bestG + gp
      const off = den < 0 ? (0.5 * (gm - gp)) / den : 0
      bestS = -reach + (bestI + Math.max(-0.5, Math.min(0.5, off))) * step
    }
    if (bestS != null && bestG > 20) pts.push([cx + nx * bestS, cy + ny * bestS])
  }
  // Fit, drop the points that caught another edge (a data cell's, near a corner the
  // neighbouring side), fit again.
  let line = fitLine(pts)
  for (let it = 0; it < 2 && line; it++) {
    const res = pts.map(([x, y]) => Math.abs(line.n[0] * x + line.n[1] * y - line.d))
    const sorted = [...res].sort((a, b) => a - b)
    const cut = Math.max(0.3, 3 * sorted[Math.floor(sorted.length / 2)])
    const kept = pts.filter((_, i) => res[i] <= cut)
    if (kept.length < 4 || kept.length === pts.length) break
    pts = kept
    line = fitLine(pts)
  }
  return line
}

// Total least squares: { n (unit normal), d } with n·x = d, or null for < 4 points.
function fitLine(pts) {
  if (pts.length < 4) return null
  const mx = pts.reduce((s, v) => s + v[0], 0) / pts.length,
    my = pts.reduce((s, v) => s + v[1], 0) / pts.length
  let sxx = 0,
    sxy = 0,
    syy = 0
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2
    sxy += (x - mx) * (y - my)
    syy += (y - my) ** 2
  }
  // The normal is the eigenvector of the smaller eigenvalue.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const n = [-Math.sin(theta), Math.cos(theta)]
  return { n, d: n[0] * mx + n[1] * my }
}

function meet(a, b) {
  const det = a.n[0] * b.n[1] - a.n[1] * b.n[0]
  if (Math.abs(det) < 1e-9) return null
  return { x: (a.d * b.n[1] - a.n[1] * b.d) / det, y: (a.n[0] * b.d - a.d * b.n[0]) / det }
}

// The homography taking the unit square's corners (0,0),(1,0),(1,1),(0,1) to `q`.
function squareToQuad(q) {
  const [p0, p1, p2, p3] = q
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y
  const sx = p0.x - p1.x + p2.x - p3.x,
    sy = p0.y - p1.y + p2.y - p3.y
  const den = dx1 * dy2 - dx2 * dy1
  const g = (sx * dy2 - dx2 * sy) / den,
    h = (dx1 * sy - sx * dy1) / den
  const a = p1.x - p0.x + g * p1.x,
    b = p3.x - p0.x + h * p3.x,
    c = p0.x
  const d = p1.y - p0.y + g * p1.y,
    e = p3.y - p0.y + h * p3.y,
    f = p0.y
  return (u, v) => {
    const w = g * u + h * v + 1
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w }
  }
}

// The closest code to `code` in the family: { id, hamming }.
function closest(code, TAG) {
  let id = -1,
    best = 99
  for (let i = 0; i < TAG.CODES.length; i++) {
    const d = hamming(code, TAG.CODES[i])
    if (d < best) [best, id] = [d, i]
    if (!d) break
  }
  return { id, hamming: best }
}

// Read and decode the tag in `corners` (clockwise from any corner).
function decode(gray, corners, maxHamming, TAG) {
  const W = TAG.WIDTH_AT_BORDER
  const H = squareToQuad(corners)
  const at = (cx, cy) => {
    // A cell's value: 3 × 3 samples over its middle half.
    let s = 0,
      n = 0
    for (const dy of [-0.25, 0, 0.25])
      for (const dx of [-0.25, 0, 0.25]) {
        const p = H((cx + 0.5 + dx) / W, (cy + 0.5 + dy) / W)
        const v = sample(gray, p.x, p.y)
        if (Number.isFinite(v)) {
          s += v
          n++
        }
      }
    return n ? s / n : NaN
  }
  // The black ring (cells 0 and 7) and the white one outside it (cells −1 and 8).
  let black = 0,
    white = 0,
    nb = 0,
    nw = 0
  for (let k = 0; k < W; k++)
    for (const [bx, by, wx, wy] of [
      [k, 0, k, -1],
      [k, W - 1, k, W],
      [0, k, -1, k],
      [W - 1, k, W, k],
    ]) {
      const b = at(bx, by),
        w = at(wx, wy)
      if (Number.isFinite(b)) [black, nb] = [black + b, nb + 1]
      if (Number.isFinite(w)) [white, nw] = [white + w, nw + 1]
    }
  if (!nb || !nw) return null
  black /= nb
  white /= nw
  const contrast = (white - black) / 255
  if (!(contrast > 0.15)) return null
  const thr = (black + white) / 2
  const grid = []
  for (let y = 0; y < W; y++) {
    grid.push([])
    for (let x = 0; x < W; x++) grid[y].push(at(x, y) > thr ? 1 : 0)
  }
  // The black ring must be black.
  let ringBad = 0
  for (let k = 0; k < W; k++) ringBad += grid[0][k] + grid[W - 1][k] + grid[k][0] + grid[k][W - 1]
  if (ringBad > 3) return null
  let best = null
  for (let r = 0; r < 4; r++) {
    // Rotation r: the cell the tag calls (x, y) is grid cell rot^r(x, y).
    const cell = (x, y) => {
      for (let k = 0; k < r; k++) [x, y] = [W - 1 - y, x]
      return grid[y][x]
    }
    let code = 0
    for (let i = 0; i < TAG.NBITS; i++) code = code * 2 + cell(TAG.BIT_X[i], TAG.BIT_Y[i])
    const m = closest(code, TAG)
    if (!best || m.hamming < best.hamming) best = { ...m, r }
  }
  if (best.hamming > maxHamming) return null
  // Corners in the tag's own order: rotating the reading by r moves its top-left.
  const order = [0, 1, 2, 3].map((k) => corners[(k + 4 - best.r) % 4])
  const center = H(0.5, 0.5)
  return { id: best.id, hamming: best.hamming, score: tagScore(best.hamming, TAG), center, corners: order, contrast }
}

// `family`: the tags to read (DEFAULT_FAMILY, tag36h11). `maxHamming` is capped below half
// the family's distance, so a misread can never become another code.
export function detectTags(
  gray,
  { minSide = 16, maxSide = Infinity, maxHamming = 2, window = null, family = DEFAULT_FAMILY } = {},
) {
  const TAG = family
  maxHamming = Math.min(maxHamming, Math.floor((TAG.MIN_HAMMING - 1) / 2))
  // A 16-bit code (ArUco 4×4) reads exactly: with one bit corrected, one random pattern
  // in 20 inside a dark ring decodes to some id of 4x4_50 (1 in 4 for 4x4_250); read
  // exactly, one in 330 (1 in 66).
  if (TAG.NBITS <= 16) maxHamming = 0
  const darkMax = TAG.DARK_MAX ?? 0.85
  const { width, height } = gray
  const r = window ?? Math.max(7, Math.round(minSide / 2))
  const mask = adaptiveThreshold(gray, r)
  const out = new Map()
  for (const c of components(mask, width, height).values()) {
    const w = c.x1 - c.x0 + 1,
      h = c.y1 - c.y0 + 1
    if (w < minSide || h < minSide || w > maxSide || h > maxSide) continue
    if (c.x0 <= 1 || c.y0 <= 1 || c.x1 >= width - 2 || c.y1 >= height - 2) continue
    // A ring: much less than the whole box is dark.
    if (c.n > darkMax * w * h || c.n < 0.2 * w * h) continue
    const edge = []
    for (const [y, [x0, x1]] of c.rows) edge.push({ x: x0, y }, { x: x1, y })
    const quad = hullQuad(hull(edge))
    if (!quad) continue
    // How far across a side to look for its edge: well inside one cell (the black ring's
    // inner edge is one cell in, the white ring's outer one cell out); the dark pixels'
    // centres lie half a pixel inside the edge.
    const side = Math.min(...quad.map((p, i) => Math.hypot(quad[(i + 1) % 4].x - p.x, quad[(i + 1) % 4].y - p.y)))
    const reach = Math.max(1.5, Math.min(6, (0.55 * side) / TAG.WIDTH_AT_BORDER))
    const sides = quad.map((p, i) => refineSide(gray, p, quad[(i + 1) % 4], reach))
    if (sides.some((s) => !s)) continue
    const corners = sides.map((s, i) => meet(sides[(i + 3) % 4], s))
    if (corners.some((p) => !p || !Number.isFinite(p.x))) continue
    // Each refined corner close to its rough one: a wrong line would throw it off.
    if (corners.some((p, i) => Math.hypot(p.x - quad[i].x, p.y - quad[i].y) > Math.max(3, reach * 2))) continue
    const tag = decode(gray, corners, maxHamming, TAG)
    if (!tag) continue
    const prev = out.get(tag.id)
    if (!prev || tag.hamming < prev.hamming) out.set(tag.id, tag)
  }
  return [...out.values()]
}

// A tag's score, 0–1: the share of the margin to the nearest other code still left after
// its wrong bits (1 read cleanly, 0.64 with 2 of tag36h11's 11 used up).
export function tagScore(hamming, family = DEFAULT_FAMILY) {
  const d = family?.MIN_HAMMING ?? DEFAULT_FAMILY.MIN_HAMMING
  return Math.round((100 * (d - 2 * hamming)) / d) / 100
}

// The native tiles a photo is searched in: [{ x0, y0, w, h, core: { x0, y0, x1, y1 } }].
// A tag counts in the tile whose core (the tile less half the overlap on each inner side)
// holds its centre, so each is found once.
export function tagTiles(width, height, { tile, overlap }) {
  const starts = (n) => {
    if (n <= tile) return [0]
    const k = Math.ceil((n - overlap) / (tile - overlap))
    return Array.from({ length: k }, (_, i) => Math.round((i * (n - tile)) / (k - 1)))
  }
  const xs = starts(width),
    ys = starts(height)
  const core = (s, i, list, n, size) => [
    i === 0 ? 0 : (s + list[i - 1] + size) / 2,
    i === list.length - 1 ? n : (list[i + 1] + s + size) / 2,
  ]
  const out = []
  for (const [j, y0] of ys.entries())
    for (const [i, x0] of xs.entries()) {
      const w = Math.min(tile, width),
        h = Math.min(tile, height)
      const [cx0, cx1] = core(x0, i, xs, width, w)
      const [cy0, cy1] = core(y0, j, ys, height, h)
      out.push({ x0, y0, w, h, core: { x0: cx0, y0: cy0, x1: cx1, y1: cy1 } })
    }
  return out
}

// One detection per tag id: the fewest wrong bits, then the clearest.
export function mergeTags(tags) {
  const best = new Map()
  for (const t of tags) {
    const p = best.get(t.id)
    if (!p || t.hamming < p.hamming || (t.hamming === p.hamming && t.contrast > p.contrast)) best.set(t.id, t)
  }
  return [...best.values()].sort((a, b) => a.id - b.id)
}

// The tag a GCP stands for: the one number in its name ("7", "Tag 7", "GCP-07"), or null
// when it has none or several.
export function tagNumber(name) {
  const m = String(name ?? '').match(/\d+/g)
  return m?.length === 1 ? Number(m[0]) : null
}

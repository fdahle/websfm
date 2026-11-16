// Rotated-rectangle geometry for text boxes: the convex hull of a pixel set, its
// minimum-area rectangle (rotating calipers, as OpenCV's minAreaRect), the corner order
// PaddleOCR uses, and growing a rectangle outward. Pure; points are [x, y] pairs.

/** Convex hull (Andrew's monotone chain), counter-clockwise in image axes, no repeats. */
export function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/**
 * Minimum-area enclosing rectangle of a point set: `{ cx, cy, w, h, ux, uy }`, with
 * (ux, uy) the unit direction of the `w` side. A single point or a line gives a
 * rectangle of zero width or height, as OpenCV's minAreaRect does.
 */
export function minAreaRect(points) {
  const hull = convexHull(points)
  if (hull.length === 0) return null
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, ux: 1, uy: 0 }
  let best = null
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i],
      b = hull[(i + 1) % hull.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (!(len > 0)) continue
    const ux = (b[0] - a[0]) / len,
      uy = (b[1] - a[1]) / len
    let minU = Infinity,
      maxU = -Infinity,
      minV = Infinity,
      maxV = -Infinity
    for (const q of hull) {
      const u = q[0] * ux + q[1] * uy,
        v = -q[0] * uy + q[1] * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area - 1e-9) {
      const cu = (minU + maxU) / 2,
        cv = (minV + maxV) / 2
      best = { area, cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w: maxU - minU, h: maxV - minV, ux, uy }
    }
  }
  const { cx, cy, w, h, ux, uy } = best
  return { cx, cy, w, h, ux, uy }
}

/** The four corners of a rectangle from minAreaRect. */
export function rectCorners({ cx, cy, w, h, ux, uy }) {
  const ax = (ux * w) / 2,
    ay = (uy * w) / 2,
    bx = (-uy * h) / 2,
    by = (ux * h) / 2
  return [
    [cx - ax - bx, cy - ay - by],
    [cx + ax - bx, cy + ay - by],
    [cx + ax + bx, cy + ay + by],
    [cx - ax + bx, cy - ay + by],
  ]
}

/**
 * Corners ordered as PaddleOCR's get_mini_boxes orders them: top-left, top-right,
 * bottom-right, bottom-left, by sorting on x and splitting each half on y.
 */
export function orderQuad(corners) {
  const s = [...corners].sort((a, b) => a[0] - b[0])
  const [l0, l1] = s[1][1] > s[0][1] ? [s[0], s[1]] : [s[1], s[0]]
  const [r0, r1] = s[3][1] > s[2][1] ? [s[2], s[3]] : [s[3], s[2]]
  return [l0, r0, r1, l1]
}

/** A rectangle grown by `d` on every side. */
export function growRect(rect, d) {
  return { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d }
}

/**
 * DB's unclip distance: the detector shrinks each text region while training, so a
 * found region is grown back by area · ratio / perimeter (Liao et al., DBNet). For a
 * rectangle, the round-joined offset polygon PaddleOCR builds has the rectangle grown
 * by that distance as its minimum-area rectangle, so that is used directly.
 */
export function unclipRect(rect, ratio) {
  const area = rect.w * rect.h,
    perimeter = 2 * (rect.w + rect.h)
  return perimeter > 0 ? growRect(rect, (area * ratio) / perimeter) : rect
}

/** Axis-aligned bounds of a polygon: [x0, y0, x1, y1]. */
export function polyBounds(poly) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/** Whether (x, y) lies inside a convex polygon (either winding), edges included. */
export function insideConvex(poly, x, y) {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length]
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
    if (c === 0) continue
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/**
 * A convex polygon grown outward by `d` (each corner moved out along the bisector of
 * its edges' normals so the edges move out by d). For a rectangle this is exact.
 */
export function growPolygon(poly, d) {
  if (!(d > 0)) return poly.map((p) => [...p])
  const n = poly.length
  let area2 = 0
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n]
    area2 += a[0] * b[1] - b[0] * a[1]
  }
  const turn = area2 >= 0 ? 1 : -1
  const normal = (a, b) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    return [(turn * dy) / len, (-turn * dx) / len]
  }
  return poly.map((p, i) => {
    const prev = poly[(i - 1 + n) % n],
      next = poly[(i + 1) % n]
    const n1 = normal(prev, p),
      n2 = normal(p, next)
    let mx = n1[0] + n2[0],
      my = n1[1] + n2[1]
    const ml = Math.hypot(mx, my)
    if (!(ml > 1e-9)) return [p[0] + n1[0] * d, p[1] + n1[1] * d]
    mx /= ml
    my /= ml
    const cos = mx * n1[0] + my * n1[1]
    const k = d / Math.max(cos, 0.2)
    return [p[0] + mx * k, p[1] + my * k]
  })
}

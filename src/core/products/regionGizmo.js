// Drag handles for the region box (Tools ▸ Model ▾ ▸ Region) in the 3D view. Pure:
// the geometry of the handles and of a drag, no three.js or DOM; Viewer3D supplies
// the pointer ray and the projection.
//
// Seven handles: one on the centre of each face, which moves that face along its axis
// (the opposite face stays), and one at the box centre, which moves the whole box in
// the plane facing the camera. A face drag follows the pointer along the axis line:
// the face goes to the point of the axis closest to the pointer ray, offset by where
// on the handle the drag started, so the face does not jump to the pointer.

export const AXES = ['x', 'y', 'z']

/** The handles of a box { min, max }: [{ id: 'x-' … 'z+' | 'move', axis: 0–2 | null, side: -1 | 1 | 0, pos }]. */
export function regionHandles(box) {
  const c = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2)
  const out = []
  for (let k = 0; k < 3; k++) {
    for (const side of [-1, 1]) {
      const pos = c.slice()
      pos[k] = side < 0 ? box.min[k] : box.max[k]
      out.push({ id: `${AXES[k]}${side < 0 ? '-' : '+'}`, axis: k, side, pos })
    }
  }
  out.push({ id: 'move', axis: null, side: 0, pos: c })
  return out
}

/**
 * The handle under the pointer: the one whose projection is nearest (x, y), within
 * `tol` (same units as `project`'s output). `project(pos)` → [x, y] or null (behind
 * the camera). The centre handle loses ties to a face, which sits on top of it in a
 * view straight down an axis.
 */
export function pickHandle(handles, project, x, y, tol) {
  let best = null,
    bestD = tol
  for (const h of handles) {
    const p = project(h.pos)
    if (!p) continue
    const d = Math.hypot(p[0] - x, p[1] - y) + (h.axis === null ? 1e-9 : 0)
    if (d <= bestD) {
      bestD = d
      best = h
    }
  }
  return best
}

/**
 * Along the line through `point` in the direction of `axis`: the parameter t of the
 * point closest to the ray { origin, dir }. null when the ray runs (nearly) along the
 * axis, where the pointer says nothing about the position on it.
 */
export function axisParam(ray, point, axis) {
  const d = ray.dir
  const e = [0, 0, 0]
  e[axis] = 1
  const w = [point[0] - ray.origin[0], point[1] - ray.origin[1], point[2] - ray.origin[2]]
  // Closest points of the lines point + t·e and origin + s·d (|e| = 1).
  const b = d[axis],
    c = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const den = c - b * b
  if (!(den > 1e-6 * c)) return null
  const dw = d[0] * w[0] + d[1] * w[1] + d[2] * w[2],
    ew = w[axis]
  return (b * dw - c * ew) / den
}

/** Where the ray meets the plane through `point` with normal `normal`; null if parallel or behind. */
export function planeHit(ray, point, normal) {
  const d = ray.dir
  const den = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]
  if (Math.abs(den) < 1e-12) return null
  const s =
    ((point[0] - ray.origin[0]) * normal[0] +
      (point[1] - ray.origin[1]) * normal[1] +
      (point[2] - ray.origin[2]) * normal[2]) /
    den
  if (s < 0) return null
  return [ray.origin[0] + s * d[0], ray.origin[1] + s * d[1], ray.origin[2] + s * d[2]]
}

/**
 * The box after a drag of `handle` from `start`: a face handle by `delta` (a number,
 * along its axis), the centre handle by `delta` ([dx, dy, dz]). A face stops short of
 * the opposite one (1e-6 of the box's largest side), so the box never turns inside out.
 */
export function dragRegion(start, handle, delta) {
  const min = start.min.slice(),
    max = start.max.slice()
  if (handle.axis === null) {
    for (let k = 0; k < 3; k++) {
      min[k] += delta[k]
      max[k] += delta[k]
    }
    return { min, max }
  }
  const k = handle.axis
  const gap = 1e-6 * Math.max(...[0, 1, 2].map((a) => start.max[a] - start.min[a]), 1e-12)
  if (handle.side < 0) min[k] = Math.min(start.min[k] + delta, max[k] - gap)
  else max[k] = Math.max(start.max[k] + delta, min[k] + gap)
  return { min, max }
}

/**
 * One drag, start to finish. `begin(ray)` at pointer-down, `move(ray)` → the new box
 * (or null when this ray gives no position, e.g. along the axis), from the box and
 * handle given at creation. `viewDir` is the camera's forward direction, the normal of
 * the plane the centre handle moves in.
 */
export function createRegionDrag(start, handle, viewDir) {
  let t0 = null,
    p0 = null
  const anchor = handle.pos
  return {
    begin(ray) {
      if (handle.axis === null) p0 = planeHit(ray, anchor, viewDir)
      else t0 = axisParam(ray, anchor, handle.axis)
    },
    move(ray) {
      if (handle.axis === null) {
        const p = planeHit(ray, anchor, viewDir)
        if (!p || !p0) return null
        return dragRegion(start, handle, [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]])
      }
      const t = axisParam(ray, anchor, handle.axis)
      if (t === null || t0 === null) return null
      return dragRegion(start, handle, t - t0)
    },
  }
}

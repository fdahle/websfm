// Screen-space point PICKING for the 3D viewer: "which drawn point is under the
// cursor". The primitive behind point-pair alignment and orienting the model on
// picked ground points. Pure, same contract as screenSelect.js:
//   - `matrix` is the 16-element COLUMN-MAJOR clip-from-buffer transform (three.js
//     `Matrix4.elements` of projection · view · model) for positions exactly as they
//     sit in `pos` — the Float32 render buffer, so the pick is what was drawn;
//   - the cursor is in NDC (x right, y up); `tolX/tolY` is the pick radius in NDC
//     per axis (the caller converts its pixel radius once);
//   - only points inside the clip volume count (w > 0, |z| ≤ w), and `indices`
//     restricts candidates to what a class-hiding style actually drew.
// Among the points within the radius it returns the one NEAREST THE CAMERA (smallest
// NDC depth): a click on a surface means its front, not a point showing through.
// One linear pass, no allocation — fine for tens of millions of points per click.

/**
 * @returns {{ index:number, depth:number, dx:number, dy:number } | null}
 */
export function pickNearestPoint(pos, count, { matrix, x, y, tolX, tolY, indices = null }) {
  const m = matrix
  const n = indices ? indices.length : count
  let best = -1, bestDepth = Infinity, bestDx = 0, bestDy = 0
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k] : k
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2]
    const w = m[3] * px + m[7] * py + m[11] * pz + m[15]
    if (!(w > 0)) continue
    const cz = m[2] * px + m[6] * py + m[10] * pz + m[14]
    if (cz > w || cz < -w) continue
    const nx = (m[0] * px + m[4] * py + m[8] * pz + m[12]) / w
    const dx = nx - x
    if (dx > tolX || dx < -tolX) continue
    const ny = (m[1] * px + m[5] * py + m[9] * pz + m[13]) / w
    const dy = ny - y
    if (dy > tolY || dy < -tolY) continue
    // Inside the elliptical radius (circular on screen).
    if ((dx / tolX) ** 2 + (dy / tolY) ** 2 > 1) continue
    const depth = cz / w
    if (depth < bestDepth) { best = i; bestDepth = depth; bestDx = dx; bestDy = dy }
  }
  return best < 0 ? null : { index: best, depth: bestDepth, dx: bestDx, dy: bestDy }
}

/**
 * Plane through three picked points, as { normal (unit), point, area } — null when
 * they are (nearly) collinear. `up` (optional) chooses the normal's side: it is
 * flipped to agree with it.
 */
export function planeFromThreePoints(a, b, c, up = null) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0]
  const len = Math.hypot(nx, ny, nz)
  const scale = Math.max(Math.hypot(...u), Math.hypot(...v)) ** 2
  if (!(len > 1e-9 * scale)) return null
  nx /= len; ny /= len; nz /= len
  if (up && nx * up[0] + ny * up[1] + nz * up[2] < 0) { nx = -nx; ny = -ny; nz = -nz }
  return { normal: [nx, ny, nz], point: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], area: len / 2 }
}

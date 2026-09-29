// Orthophoto by true image reprojection — pure, no Vue/Pinia/OPFS/DOM.
//
// Given a DEM (a height per ground cell) we know each cell's full 3D position, so
// an orthophoto is: for every DEM cell, take its ground point, look at which
// source images actually SEE it (not occluded), and sample their colour. This is
// real orthorectification (relief displacement removed via the DEM), unlike a
// simple nadir paste.
//
// The clever reuse: the dense pipeline already produced, per image, a depth map
// (working-res depth + cost + RGB planes; see core/dense/mvs.js / the depthMaps cache).
// Those depth planes ARE per-image z-buffers, so occlusion is a cheap lookup —
// no re-rendering. A cell is visible in image m iff it reprojects to a pixel
// whose stored depth equals the cell's own depth-from-camera (within tolerance);
// a nearer stored depth means something occludes it.
//
// Each map: { uuid, width, height, K:{fx,fy,cx,cy}, R, t,
//             depth:Float32Array, cost:Float32Array, rgb:Uint8Array(w*h*3) }.
// Conventions match geometry.js (x_cam = R·x_world + t; K working-res).

// Project a world point into a map, requiring it in front of the camera.
// Returns { u, v, depth } (u,v continuous px) or null.
function projectInto(m, P) {
  const { R, t, K } = m
  const zc = R[2][0] * P[0] + R[2][1] * P[1] + R[2][2] * P[2] + t[2]
  if (!(zc > 1e-9)) return null
  const xc = R[0][0] * P[0] + R[0][1] * P[1] + R[0][2] * P[2] + t[0]
  const yc = R[1][0] * P[0] + R[1][1] * P[1] + R[1][2] * P[2] + t[1]
  return { u: K.fx * (xc / zc) + K.cx, v: K.fy * (yc / zc) + K.cy, depth: zc }
}

// Sample the colour for one ground point P (SfM world coords) by reprojecting it
// into every map, testing occlusion against each map's depth plane, and combining
// the visible views.
//   opts: { depthTolRel=0.02, blend='best'|'average', maxCost=Infinity }
// Returns [r,g,b] (0..255) or null when no view sees the point.
export function sampleOrtho(P, maps, opts = {}) {
  const { depthTolRel = 0.02, blend = 'best', maxCost = Infinity } = opts
  let best = null           // { score, rgb }
  let wsum = 0, r = 0, g = 0, b = 0  // for 'average'

  for (const m of maps) {
    const p = projectInto(m, P)
    if (!p) continue
    const u = Math.round(p.u), v = Math.round(p.v)
    if (u < 0 || v < 0 || u >= m.width || v >= m.height) continue
    const idx = v * m.width + u
    const stored = m.depth[idx]
    if (!(stored > 0)) continue                              // no surface here
    // Occlusion: the cell's distance to this camera must match the map's own
    // surface distance. A stored depth closer than p.depth ⇒ something in front.
    if (Math.abs(stored - p.depth) > depthTolRel * p.depth) continue
    const cost = m.cost ? m.cost[idx] : 0
    if (cost > maxCost) continue

    const o = idx * 3
    const rgb = [m.rgb[o], m.rgb[o + 1], m.rgb[o + 2]]
    // Quality: lower matching cost is better; nearer view (smaller depth) breaks
    // ties (finer ground resolution). Combine into a single "smaller = better".
    const score = cost + 1e-6 * p.depth

    if (blend === 'average') {
      const w = 1 / (cost + 1e-3)
      wsum += w; r += w * rgb[0]; g += w * rgb[1]; b += w * rgb[2]
    } else if (!best || score < best.score) {
      best = { score, rgb }
    }
  }

  if (blend === 'average') {
    if (wsum <= 0) return null
    return [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)]
  }
  return best ? best.rgb : null
}

// Fill small transparent holes that lie INSIDE the selected surface. Reads only
// original sampled pixels, so interpolation cannot propagate across a large gap
// one radius at a time or grow beyond the DEM/mesh footprint.
export function fillOrthoGaps(rgba, surfaceMask, width, height, radius, method = 'idw') {
  const r = Math.max(0, Math.floor(radius))
  if (!r || method === 'none') return 0
  const sampled = new Uint8Array(width * height)
  for (let i = 0; i < sampled.length; i++) sampled[i] = rgba[i * 4 + 3] > 0 ? 1 : 0

  let filled = 0
  const r2 = r * r
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col
      if (!surfaceMask[i] || sampled[i]) continue
      let nearest = -1, nearestD2 = Infinity, wsum = 0, rs = 0, gs = 0, bs = 0
      for (let dr = -r; dr <= r; dr++) {
        const rr = row + dr
        if (rr < 0 || rr >= height) continue
        for (let dc = -r; dc <= r; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= width) continue
          const d2 = dr * dr + dc * dc
          if (!d2 || d2 > r2) continue
          const ni = rr * width + cc
          if (!sampled[ni]) continue
          if (d2 < nearestD2) { nearestD2 = d2; nearest = ni }
          const w = 1 / d2, o = ni * 4
          wsum += w; rs += w * rgba[o]; gs += w * rgba[o + 1]; bs += w * rgba[o + 2]
        }
      }
      if (nearest < 0) continue
      const o = i * 4
      if (method === 'nearest') {
        const no = nearest * 4
        rgba[o] = rgba[no]; rgba[o + 1] = rgba[no + 1]; rgba[o + 2] = rgba[no + 2]
      } else {
        rgba[o] = Math.round(rs / wsum); rgba[o + 1] = Math.round(gs / wsum); rgba[o + 2] = Math.round(bs / wsum)
      }
      rgba[o + 3] = 255
      filled++
    }
  }
  return filled
}

// Orthorectify a whole DEM grid into an RGBA raster aligned to it. `toSfm` maps a
// frame coord [x,y,z] back to SfM world (frame.toSfm); `cellCenter(grid,col,row)`
// gives the ground XY. Cells with no height (mask 0) or no visible view become
// transparent.
//   grid: from dem.rasterizeDem ({ width, height, gsd, originX, originY, data, mask })
// Returns { width, height, rgba:Uint8ClampedArray(w*h*4), covered } where
// `covered` is the number of cells that received a colour.
export function orthorectify(grid, maps, toSfm, opts = {}, onProgress = () => {}) {
  const { width, height, gsd, originX, originY, data, mask } = grid
  const rgba = new Uint8ClampedArray(width * height * 4)
  let covered = 0
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col
      const o = idx * 4
      if (!mask[idx]) continue
      const x = originX + (col + 0.5) * gsd
      const y = originY - (row + 0.5) * gsd
      const P = toSfm([x, y, data[idx]])
      const rgb = sampleOrtho(P, maps, opts)
      if (!rgb) continue
      rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = 255
      covered++
    }
    if (row % 32 === 0) onProgress(row, height)
  }
  const sampled = covered
  const filled = fillOrthoGaps(rgba, mask, width, height, opts.fillRadius ?? 2, opts.fillMethod ?? 'idw')
  covered += filled
  onProgress(height, height)
  return { width, height, rgba, covered, sampled, filled }
}

// Map-major counterpart: identical selection/weights, one decoded map resident.
export async function orthorectifyStreamed(grid, metas, loadMap, toSfm, opts = {}, onProgress = () => {}) {
  const { width, height, gsd, originX, originY, data, mask } = grid
  const n = width * height, rgba = new Uint8ClampedArray(n * 4)
  const average = opts.blend === 'average', scores = new Float64Array(n).fill(Infinity)
  const sums = average ? new Float64Array(n * 4) : null
  const { depthTolRel = 0.02, maxCost = Infinity } = opts
  for (let mi = 0; mi < metas.length; mi++) {
    const m = await loadMap(mi)
    for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
      const idx = row * width + col
      if (!mask[idx]) continue
      const P = toSfm([originX + (col + 0.5) * gsd, originY - (row + 0.5) * gsd, data[idx]])
      const p = projectInto(m, P)
      if (!p) continue
      const u = Math.round(p.u), v = Math.round(p.v)
      if (u < 0 || v < 0 || u >= m.width || v >= m.height) continue
      const i = v * m.width + u, stored = m.depth[i], cost = m.cost ? m.cost[i] : 0
      if (!(stored > 0) || Math.abs(stored - p.depth) > depthTolRel * p.depth || cost > maxCost) continue
      const score = cost + 1e-6 * p.depth, o = idx * 4, c = i * 3
      if (average) {
        const w = 1 / (cost + 1e-3)
        sums[o] += w * m.rgb[c]; sums[o + 1] += w * m.rgb[c + 1]; sums[o + 2] += w * m.rgb[c + 2]; sums[o + 3] += w
      } else if (score < scores[idx]) {
        scores[idx] = score
        rgba[o] = m.rgb[c]; rgba[o + 1] = m.rgb[c + 1]; rgba[o + 2] = m.rgb[c + 2]; rgba[o + 3] = 255
      }
    }
    onProgress(mi + 1, metas.length)
  }
  let sampled = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (average && sums[o + 3] > 0) {
      rgba[o] = Math.round(sums[o] / sums[o + 3]); rgba[o + 1] = Math.round(sums[o + 1] / sums[o + 3]); rgba[o + 2] = Math.round(sums[o + 2] / sums[o + 3]); rgba[o + 3] = 255
    }
    if (rgba[o + 3]) sampled++
  }
  const filled = fillOrthoGaps(rgba, mask, width, height, opts.fillRadius ?? 2, opts.fillMethod ?? 'idw')
  return { width, height, rgba, covered: sampled + filled, sampled, filled }
}

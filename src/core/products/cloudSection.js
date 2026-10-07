// Vertical section (cross-section) of a point cloud — pure, no
// Vue/Pinia/OPFS/DOM. Cuts a slab of `thickness` around a horizontal line a→b
// out of a flat cloud ({ count, pos:Float32Array|Float64Array(3N),
// col?:Uint8Array(3N) }, Z up) and expresses each kept point in profile
// coordinates:
//   station — horizontal distance along a→b from a (the projection onto the line)
//   offset  — signed perpendicular horizontal distance, positive LEFT of a→b
//   z       — unchanged height
// The slab is a rectangle: |offset| ≤ thickness/2 and 0 ≤ station ≤ |ab|; with
// `extend` the station bound is dropped (the infinite line, so station may be
// negative or past b). Output is sorted by station (ties by input order, so the
// result is deterministic) and the cloud and profile share that order.
// Coordinates are in the cloud's own frame — the caller decides what unit that is
// (Scale & units: never print a bare number).

import { writeDxf } from './dxf.js'

// sectionCloud(cloud, { a:[x,y], b:[x,y], thickness, extend = false }, onLog)
//   → { cloud: { count, pos:Float64Array(3M), col:Uint8Array(3M)|null },
//       profile: { station, z, offset: Float64Array(M) }, length }
export function sectionCloud(cloud, { a, b, thickness, extend = false } = {}, onLog) {
  if (!a || !b) throw new Error('Section needs two line points a and b')
  if (!(Number.isFinite(thickness) && thickness > 0)) throw new Error(`Section thickness must be a positive number (got ${thickness})`)
  const ax = a[0], ay = a[1]
  const dx = b[0] - ax, dy = b[1] - ay
  const length = Math.hypot(dx, dy)
  if (!(length > 0)) throw new Error('Section line has zero horizontal length (a and b coincide)')
  const ux = dx / length, uy = dy / length
  const nx = -uy, ny = ux // left normal of a→b
  const half = thickness / 2

  const pos = cloud?.pos
  const n = pos ? (cloud.count ?? pos.length / 3) : 0
  // Pass 1: select, recording station/offset of kept points.
  const keep = new Uint32Array(n)
  const st = new Float64Array(n)
  const of = new Float64Array(n)
  let m = 0
  for (let i = 0; i < n; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    const px = x - ax, py = y - ay
    const s = px * ux + py * uy
    if (!extend && (s < 0 || s > length)) continue
    const o = px * nx + py * ny
    if (Math.abs(o) > half) continue
    keep[m] = i; st[m] = s; of[m] = o; m++
  }

  // Sort kept slots by station (stable on input order).
  const order = new Uint32Array(m)
  for (let k = 0; k < m; k++) order[k] = k
  order.sort((p, q) => (st[p] - st[q]) || (p - q))

  const outPos = new Float64Array(3 * m)
  const outCol = cloud?.col ? new Uint8Array(3 * m) : null
  const station = new Float64Array(m), z = new Float64Array(m), offset = new Float64Array(m)
  for (let k = 0; k < m; k++) {
    const slot = order[k], i = keep[slot]
    outPos[3 * k] = pos[3 * i]; outPos[3 * k + 1] = pos[3 * i + 1]; outPos[3 * k + 2] = pos[3 * i + 2]
    if (outCol) { outCol[3 * k] = cloud.col[3 * i]; outCol[3 * k + 1] = cloud.col[3 * i + 1]; outCol[3 * k + 2] = cloud.col[3 * i + 2] }
    station[k] = st[slot]; z[k] = pos[3 * i + 2]; offset[k] = of[slot]
  }

  onLog?.(
    `Section: ${m} of ${n} points within ±${half} of ${extend ? 'the line through' : 'the segment'} ` +
    `(${ax}, ${ay}) → (${b[0]}, ${b[1]}), length ${length.toFixed(3)}`,
    m ? 'info' : 'warn', 'Products')
  return { cloud: { count: m, pos: outPos, col: outCol }, profile: { station, z, offset }, length }
}

// CSV: header `station,z,offset,x,y`, one row per point in station order.
export function sectionToCsv(section, { decimals = 3 } = {}) {
  const { station, z, offset } = section.profile
  const pos = section.cloud.pos
  const rows = ['station,z,offset,x,y']
  for (let k = 0; k < station.length; k++) {
    rows.push(`${station[k].toFixed(decimals)},${z[k].toFixed(decimals)},${offset[k].toFixed(decimals)},` +
      `${pos[3 * k].toFixed(decimals)},${pos[3 * k + 1].toFixed(decimals)}`)
  }
  return rows.join('\n') + '\n'
}

// DXF (R12) in 2D profile coordinates (x = station, y = z) on layer SECTION:
// POINT entities, or with `asPolyline` one polyline through the points in
// station order (falls back to points when fewer than two).
export function sectionToDxf(section, { asPolyline = false, precision } = {}) {
  const { station, z } = section.profile
  const layers = [{ name: 'SECTION', color: 7 }]
  const opts = precision != null ? { precision } : {}
  if (asPolyline && station.length >= 2) {
    const points = new Array(station.length)
    for (let k = 0; k < station.length; k++) points[k] = [station[k], z[k]]
    return writeDxf({ layers, polylines: [{ layer: 'SECTION', points, elevation: 0 }] }, opts)
  }
  const points = new Array(station.length)
  for (let k = 0; k < station.length; k++) points[k] = { layer: 'SECTION', x: station[k], y: z[k], z: 0 }
  return writeDxf({ layers, points }, opts)
}

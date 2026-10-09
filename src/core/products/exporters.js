// Pure exporters: turn reconstruction / product data into standard interchange
// formats (bytes or text). No DOM/Blob here — the UI layer wraps the return value
// in a Blob and triggers the download (see utils/download.js).

import { writeGeoTiff, writeCogDeflate, geoKeysForEpsg } from './geotiff.js'
import { applySimilarity } from './georef.js'
import { createVoxelAccumulator } from '../dense/mvs.js'

// ── Export preprocessing: georeference + voxel downsample ────────────────────
// Applies (in this order — the cell size is in target-CRS units) an optional
// similarity transform (the stored Horn georef fit) and an optional voxel
// downsample to a cloud, returning the flat shape every cloud writer accepts:
// { count, pos: Float64Array(3N), col?: Uint8Array(3N), attributes? }. Accepts the
// usual dual input (sparse point-objects or flat dense). Normals are DROPPED whenever
// a transform/downsample applies (rotating them is not worth the wire for export
// consumers; the writers only emit normals the input carries). With neither
// option active the input is returned untouched. Never materializes per-point
// objects (dense-scale invariant): the downsample streams into the same voxel
// accumulator fusion uses, shifted near the origin so the Float32 sums keep
// survey-coordinate precision.
//
// Per-point attributes survive both steps. A transform leaves them as they are (they
// are scalars, not coordinates: a `distance` is not rescaled into CRS units). A
// downsample with attributes keeps ONE REAL POINT per cell — position, colour and
// attributes all from that point — instead of averaging, the same rule as
// cloudEdit.js voxelDownsample: a mean class id, return number or GPS time is an
// observation nobody made.
export function prepareCloudForExport(points, { sim = null, cell = 0, onLog } = {}) {
  const down = cell > 0
  if (!sim && !down) return points
  const flat = points && points.pos ? points : null
  const n = flat ? (flat.count ?? flat.pos.length / 3) : points.length
  const getP = flat
    ? (i) => [flat.pos[i * 3], flat.pos[i * 3 + 1], flat.pos[i * 3 + 2]]
    : (i) => [points[i].x, points[i].y, points[i].z]
  const hasCol = flat ? !!flat.col : n > 0 && !!points[0]?.color
  const getC = flat
    ? (flat.col ? (i) => [flat.col[i * 3], flat.col[i * 3 + 1], flat.col[i * 3 + 2]] : () => null)
    : (i) => points[i].color
  const hadNormals = flat ? !!flat.nrm : n > 0 && !!points[0]?.normal
  if (hadNormals) onLog?.('Export: normals dropped (georeference/downsample applied)', 'info', 'Export')
  const attrs = flat && flat.attributes && Object.keys(flat.attributes).length ? flat.attributes : null

  // Pass 1: transformed coordinates + bbox. Held as one Float64Array (flat).
  const xyz = new Float64Array(n * 3)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const p = sim ? applySimilarity(sim, getP(i)) : getP(i)
    xyz[i * 3] = p[0]; xyz[i * 3 + 1] = p[1]; xyz[i * 3 + 2] = p[2]
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]
    if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2]
  }
  if (!down) {
    const col = hasCol ? new Uint8Array(n * 3) : null
    if (col) for (let i = 0; i < n; i++) { const c = getC(i) || [200, 200, 200]; col.set(c.map(byte), i * 3) }
    // Shared, not copied: nothing downstream writes into them.
    const attributes = attrs ? Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, v.subarray(0, n)])) : null
    return { count: n, pos: xyz, ...(col ? { col } : {}), ...(attributes ? { attributes } : {}) }
  }
  if (attrs) return firstPointPerCell({ n, xyz, hasCol, getC, attrs, cell, min: [minX, minY, minZ], onLog })

  // Pass 2: voxel downsample. Shift the frame to a cell-aligned origin near the
  // bbox so the accumulator's Float32 finalize keeps precision on CRS-sized
  // coordinates; the shift is added back into the Float64 output.
  const shift = [Math.floor(minX / cell) * cell, Math.floor(minY / cell) * cell, Math.floor(minZ / cell) * cell]
  const acc = createVoxelAccumulator(cell, {
    minX: minX - shift[0], minY: minY - shift[1], minZ: minZ - shift[2],
    maxX: maxX - shift[0], maxY: maxY - shift[1], maxZ: maxZ - shift[2],
  })
  for (let i = 0; i < n; i++) {
    const c = (hasCol && getC(i)) || [200, 200, 200]
    acc.add(xyz[i * 3] - shift[0], xyz[i * 3 + 1] - shift[1], xyz[i * 3 + 2] - shift[2], byte(c[0]), byte(c[1]), byte(c[2]))
  }
  const merged = acc.finalizeFlat() // [x,y,z,r,g,b] per cell
  const m = merged.length / 6
  const pos = new Float64Array(m * 3)
  const col = hasCol ? new Uint8Array(m * 3) : null
  for (let i = 0; i < m; i++) {
    const s = i * 6, d = i * 3
    pos[d] = merged[s] + shift[0]; pos[d + 1] = merged[s + 1] + shift[1]; pos[d + 2] = merged[s + 2] + shift[2]
    if (col) { col[d] = merged[s + 3]; col[d + 1] = merged[s + 4]; col[d + 2] = merged[s + 5] }
  }
  onLog?.(`Export: voxel downsample ${cell} → ${m.toLocaleString()} of ${n.toLocaleString()} points kept`, 'info', 'Export')
  return { count: m, pos, ...(col ? { col } : {}) }
}

// Voxel downsample that keeps the first point of each cell, whole: its (already
// transformed) position, colour and every attribute. Cell ids are packed into one
// number when the grid fits 2⁵³ cells (the usual case), else a string key — never a
// per-point object.
function firstPointPerCell({ n, xyz, hasCol, getC, attrs, cell, min, onLog }) {
  const dims = [0, 1, 2].map((a) => {
    let max = -Infinity
    for (let i = 0; i < n; i++) if (xyz[i * 3 + a] > max) max = xyz[i * 3 + a]
    return Math.floor((max - min[a]) / cell) + 1
  })
  const packed = dims[0] * dims[1] * dims[2] <= Number.MAX_SAFE_INTEGER
  const seen = new Set()
  const keep = new Uint32Array(n)
  let m = 0
  for (let i = 0; i < n; i++) {
    const ix = Math.floor((xyz[i * 3] - min[0]) / cell)
    const iy = Math.floor((xyz[i * 3 + 1] - min[1]) / cell)
    const iz = Math.floor((xyz[i * 3 + 2] - min[2]) / cell)
    const key = packed ? ix + dims[0] * (iy + dims[1] * iz) : `${ix},${iy},${iz}`
    if (seen.has(key)) continue
    seen.add(key)
    keep[m++] = i
  }
  const pos = new Float64Array(m * 3)
  const col = hasCol ? new Uint8Array(m * 3) : null
  const attributes = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, new v.constructor(m)]))
  const lists = Object.entries(attrs).map(([k, v]) => [v, attributes[k]])
  for (let j = 0; j < m; j++) {
    const i = keep[j]
    pos[j * 3] = xyz[i * 3]; pos[j * 3 + 1] = xyz[i * 3 + 1]; pos[j * 3 + 2] = xyz[i * 3 + 2]
    if (col) { const c = getC(i) || [200, 200, 200]; col[j * 3] = byte(c[0]); col[j * 3 + 1] = byte(c[1]); col[j * 3 + 2] = byte(c[2]) }
    for (const [src, dst] of lists) dst[j] = src[i]
  }
  onLog?.(`Export: voxel downsample ${cell} → ${m.toLocaleString()} of ${n.toLocaleString()} points kept `
    + `(one real point per cell, so its attributes ${Object.keys(attrs).join(', ')} stay observed values)`, 'info', 'Export')
  return { count: m, pos, ...(col ? { col } : {}), attributes }
}

// Apply the same optional target-frame similarity to an indexed mesh while
// preserving topology and colours. Unlike a cloud export there is no voxel
// stage: changing vertex count would invalidate the face indices. A fresh
// Float64 position plane keeps CRS-sized translations precise for text/binary
// writers; writers that require Float32 (GLB) quantize only at their format
// boundary.
export function prepareMeshForExport(mesh, { sim = null } = {}) {
  if (!sim) return mesh
  const n = mesh?.nVerts ?? Math.floor((mesh?.pos?.length ?? 0) / 3)
  const pos = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    const p = applySimilarity(sim, [mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]])
    pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]
  }
  return { ...mesh, nVerts: n, pos }
}

// ── Point cloud → PLY ────────────────────────────────────────────────────────
// points is either a sparse cloud's [{ x, y, z, color?: [r,g,b] (0–255),
// normal?: [nx,ny,nz] }] or a dense cloud's flat descriptor { count,
// pos:Float32Array(3N), col?:Uint8Array(3N), nrm?:Float32Array(3N),
// attributes?: { name: TypedArray(N) } }. opts: { binary = true, color = true,
// normals = true, attributes = true }. Normals are emitted only when the cloud
// actually carries them (normals opt just lets a caller suppress). Each per-point
// attribute (a computed `distance`, imported intensity/classification, …) becomes
// one vertex property after the colour, in its own type (Float32 → float, Float64 →
// double, Uint8 → uchar, …), which CloudCompare/MeshLab/PDAL read as scalar fields.
// Binary returns a Uint8Array (little-endian body); ASCII returns a string.
export function cloudToPly(points, { binary = true, color = true, normals = true, attributes = true } = {}) {
  const flat = points && points.pos ? points : null
  const n = flat ? (flat.count ?? flat.pos.length / 3) : points.length
  const getX = flat ? (i) => flat.pos[i*3]   : (i) => points[i].x
  const getY = flat ? (i) => flat.pos[i*3+1] : (i) => points[i].y
  const getZ = flat ? (i) => flat.pos[i*3+2] : (i) => points[i].z
  const getC = flat
    ? (flat.col ? (i) => [flat.col[i*3], flat.col[i*3+1], flat.col[i*3+2]] : () => null)
    : (i) => points[i].color
  // Emit normals only when present (flat .nrm, or per-point .normal on the sample).
  const hasNrm = normals && (flat ? !!flat.nrm : (points.length > 0 && !!points[0].normal))
  const getN = flat
    ? (i) => [flat.nrm[i*3], flat.nrm[i*3+1], flat.nrm[i*3+2]]
    : (i) => points[i].normal || [0, 0, 0]
  const fields = attributes && flat ? plyAttributeFields(flat.attributes, n) : []
  const props = 'property float x\nproperty float y\nproperty float z\n' +
    (hasNrm ? 'property float nx\nproperty float ny\nproperty float nz\n' : '') +
    (color ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '') +
    fields.map((f) => `property ${f.type} ${f.name}\n`).join('')
  const header =
    'ply\n' +
    `format ${binary ? 'binary_little_endian' : 'ascii'} 1.0\n` +
    'comment generated by websfm\n' +
    `element vertex ${n}\n` + props + 'end_header\n'

  if (!binary) {
    const lines = new Array(n)
    for (let i = 0; i < n; i++) {
      let s = `${getX(i)} ${getY(i)} ${getZ(i)}`
      if (hasNrm) { const nn = getN(i); s += ` ${nn[0]} ${nn[1]} ${nn[2]}` }
      if (color) { const c = getC(i) || [200, 200, 200]; s += ` ${byte(c[0])} ${byte(c[1])} ${byte(c[2])}` }
      for (const f of fields) s += ` ${f.text(f.values[i])}`
      lines[i] = s
    }
    return header + lines.join('\n') + '\n'
  }

  const headerBytes = new TextEncoder().encode(header)
  // 3×f32 xyz (12) [+ 3×f32 normals (12)] [+ 3×u8 rgb (3)] [+ attributes].
  const NRM = hasNrm ? 12 : 0
  const ATTR = color ? 12 + NRM + 3 : 12 + NRM
  const STRIDE = ATTR + fields.reduce((sum, f) => sum + f.size, 0)
  const out = new Uint8Array(headerBytes.length + n * STRIDE)
  out.set(headerBytes, 0)
  const dv = new DataView(out.buffer, headerBytes.length)
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE
    dv.setFloat32(o, getX(i), true)
    dv.setFloat32(o + 4, getY(i), true)
    dv.setFloat32(o + 8, getZ(i), true)
    if (hasNrm) {
      const nn = getN(i)
      dv.setFloat32(o + 12, nn[0], true); dv.setFloat32(o + 16, nn[1], true); dv.setFloat32(o + 20, nn[2], true)
    }
    if (color) {
      const c = getC(i) || [200, 200, 200]
      dv.setUint8(o + 12 + NRM, byte(c[0])); dv.setUint8(o + 13 + NRM, byte(c[1])); dv.setUint8(o + 14 + NRM, byte(c[2]))
    }
    let a = o + ATTR
    for (const f of fields) { f.set(dv, a, f.values[i]); a += f.size }
  }
  return out
}

// PLY scalar type per attribute array type, with its byte size and writer.
const PLY_TYPES = {
  Uint8Array: ['uchar', 1, (dv, o, v) => dv.setUint8(o, v)],
  Int8Array: ['char', 1, (dv, o, v) => dv.setInt8(o, v)],
  Uint16Array: ['ushort', 2, (dv, o, v) => dv.setUint16(o, v, true)],
  Int16Array: ['short', 2, (dv, o, v) => dv.setInt16(o, v, true)],
  Uint32Array: ['uint', 4, (dv, o, v) => dv.setUint32(o, v, true)],
  Int32Array: ['int', 4, (dv, o, v) => dv.setInt32(o, v, true)],
  Float32Array: ['float', 4, (dv, o, v) => dv.setFloat32(o, v, true)],
  Float64Array: ['double', 8, (dv, o, v) => dv.setFloat64(o, v, true)],
}
// Names a PLY reader maps to geometry or colour; an attribute so named would be read
// back as one, so it is written as `scalar_<name>` (CloudCompare's own prefix).
const PLY_RESERVED = new Set(['x', 'y', 'z', 'nx', 'ny', 'nz', 'red', 'green', 'blue', 'alpha',
  'diffuse_red', 'diffuse_green', 'diffuse_blue', 'vertex_indices', 'vertex_index'])

// [{ name, type, size, set, text, values }] for each writable attribute. A PLY
// property name is one whitespace-free token; anything else becomes '_'.
function plyAttributeFields(attributes, n) {
  const fields = []
  const used = new Set()
  for (const [rawName, values] of Object.entries(attributes || {})) {
    const spec = PLY_TYPES[values?.constructor?.name]
    if (!spec || !(values.length >= n)) continue
    let name = String(rawName).replace(/[^A-Za-z0-9_.-]/g, '_') || 'attribute'
    if (PLY_RESERVED.has(name.toLowerCase())) name = `scalar_${name}`
    for (let k = 2; used.has(name); k++) name = `${name}_${k}`
    used.add(name)
    const [type, size, set] = spec
    // float: the shortest text that reads back to the same float32.
    const text = type === 'float' ? (v) => String(Number(v.toPrecision(9))) : (v) => String(v)
    fields.push({ name, type, size, set, text, values })
  }
  return fields
}

const byte = (v) => Math.max(0, Math.min(255, Math.round(v ?? 0)))

// ── Mesh → PLY (with faces) ──────────────────────────────────────────────────
// mesh: { nVerts, count /* triangles */, pos:Float32Array(3·nVerts),
// idx:Uint32Array(3·count), col?:Uint8Array(3·nVerts) }. Binary little-endian
// (a Uint8Array) by default; ASCII (a string) when binary:false. Faces are
// triangles (list: uchar count=3 + 3×int vertex indices).
export function meshToPly(mesh, { binary = true, color = true } = {}) {
  const nV = mesh.nVerts ?? (mesh.pos.length / 3)
  const nF = mesh.count ?? (mesh.idx.length / 3)
  const hasCol = color && !!mesh.col
  const vprops = 'property float x\nproperty float y\nproperty float z\n' +
    (hasCol ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '')
  const header =
    'ply\n' +
    `format ${binary ? 'binary_little_endian' : 'ascii'} 1.0\n` +
    'comment generated by websfm\n' +
    `element vertex ${nV}\n` + vprops +
    `element face ${nF}\n` +
    'property list uchar int vertex_indices\n' +
    'end_header\n'

  if (!binary) {
    const lines = [header.trimEnd()]
    for (let i = 0; i < nV; i++) {
      let s = `${mesh.pos[i*3]} ${mesh.pos[i*3+1]} ${mesh.pos[i*3+2]}`
      if (hasCol) s += ` ${byte(mesh.col[i*3])} ${byte(mesh.col[i*3+1])} ${byte(mesh.col[i*3+2])}`
      lines.push(s)
    }
    for (let f = 0; f < nF; f++) lines.push(`3 ${mesh.idx[f*3]} ${mesh.idx[f*3+1]} ${mesh.idx[f*3+2]}`)
    return lines.join('\n') + '\n'
  }

  const headerBytes = new TextEncoder().encode(header)
  const vStride = 12 + (hasCol ? 3 : 0)
  const fStride = 1 + 12 // uchar count + 3×int32
  const out = new Uint8Array(headerBytes.length + nV * vStride + nF * fStride)
  out.set(headerBytes, 0)
  const dv = new DataView(out.buffer)
  let o = headerBytes.length
  for (let i = 0; i < nV; i++) {
    dv.setFloat32(o, mesh.pos[i*3], true)
    dv.setFloat32(o + 4, mesh.pos[i*3+1], true)
    dv.setFloat32(o + 8, mesh.pos[i*3+2], true)
    if (hasCol) { dv.setUint8(o + 12, byte(mesh.col[i*3])); dv.setUint8(o + 13, byte(mesh.col[i*3+1])); dv.setUint8(o + 14, byte(mesh.col[i*3+2])) }
    o += vStride
  }
  for (let f = 0; f < nF; f++) {
    dv.setUint8(o, 3)
    dv.setInt32(o + 1, mesh.idx[f*3], true)
    dv.setInt32(o + 5, mesh.idx[f*3+1], true)
    dv.setInt32(o + 9, mesh.idx[f*3+2], true)
    o += fStride
  }
  return out
}

// ── Mesh → OBJ (Wavefront) ───────────────────────────────────────────────────
// mesh as in meshToPly. `v x y z [r g b]` (the MeshLab/CloudCompare vertex-colour
// extension, r/g/b in 0–1) + `f a b c` with **1-based** indices (the classic OBJ
// bug — OBJ counts vertices from 1). No MTL (no textures yet). Returns a string.
export function meshToObj(mesh, { color = true } = {}) {
  const nV = mesh.nVerts ?? (mesh.pos.length / 3)
  const nF = mesh.count ?? (mesh.idx.length / 3)
  const hasCol = color && !!mesh.col
  const lines = ['# generated by websfm']
  for (let i = 0; i < nV; i++) {
    let s = `v ${mesh.pos[i*3]} ${mesh.pos[i*3+1]} ${mesh.pos[i*3+2]}`
    if (hasCol) s += ` ${(byte(mesh.col[i*3])/255).toFixed(6)} ${(byte(mesh.col[i*3+1])/255).toFixed(6)} ${(byte(mesh.col[i*3+2])/255).toFixed(6)}`
    lines.push(s)
  }
  for (let f = 0; f < nF; f++) {
    // +1: OBJ vertex indices are 1-based.
    lines.push(`f ${mesh.idx[f*3]+1} ${mesh.idx[f*3+1]+1} ${mesh.idx[f*3+2]+1}`)
  }
  return lines.join('\n') + '\n'
}

// ── Mesh → STL (binary) ──────────────────────────────────────────────────────
// 80-byte header + u32 triangle count + per triangle: normal f32×3 (per-face,
// from the cross product), 3 vertices f32×3, u16 attribute (0). No colour (STL
// vertex colour is non-standard). A degenerate triangle yields a zero normal
// rather than NaN. Returns a Uint8Array.
export function meshToStl(mesh) {
  const nF = mesh.count ?? (mesh.idx.length / 3)
  const out = new Uint8Array(84 + nF * 50)
  const dv = new DataView(out.buffer)
  // 80-byte header (zeroed) then triangle count.
  new TextEncoder().encodeInto('websfm binary STL', out.subarray(0, 80))
  dv.setUint32(80, nF, true)
  let o = 84
  for (let f = 0; f < nF; f++) {
    const a = mesh.idx[f*3], b = mesh.idx[f*3+1], c = mesh.idx[f*3+2]
    const ax = mesh.pos[a*3], ay = mesh.pos[a*3+1], az = mesh.pos[a*3+2]
    const bx = mesh.pos[b*3], by = mesh.pos[b*3+1], bz = mesh.pos[b*3+2]
    const cx = mesh.pos[c*3], cy = mesh.pos[c*3+1], cz = mesh.pos[c*3+2]
    // Face normal = (b−a)×(c−a), normalized; (0,0,0) for a degenerate triangle.
    const ux = bx-ax, uy = by-ay, uz = bz-az
    const vx = cx-ax, vy = cy-ay, vz = cz-az
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) { nx /= len; ny /= len; nz /= len } else { nx = ny = nz = 0 }
    dv.setFloat32(o, nx, true); dv.setFloat32(o+4, ny, true); dv.setFloat32(o+8, nz, true)
    dv.setFloat32(o+12, ax, true); dv.setFloat32(o+16, ay, true); dv.setFloat32(o+20, az, true)
    dv.setFloat32(o+24, bx, true); dv.setFloat32(o+28, by, true); dv.setFloat32(o+32, bz, true)
    dv.setFloat32(o+36, cx, true); dv.setFloat32(o+40, cy, true); dv.setFloat32(o+44, cz, true)
    // attribute byte count u16 = 0 (o+48)
    o += 50
  }
  return out
}

// ── Mesh → GLB (binary glTF 2.0) ─────────────────────────────────────────────
// A minimal, dependency-free single-buffer GLB: one mesh, one primitive, with
// POSITION (f32 VEC3) + optional COLOR_0 (u8 VEC4 normalized) + indices (u32
// SCALAR). Correct 4-byte alignment; POSITION accessor carries min/max (required
// by the spec and by many viewers for framing). Returns a Uint8Array.
export function meshToGlb(mesh, { color = true } = {}) {
  const nV = mesh.nVerts ?? (mesh.pos.length / 3)
  const nIdx = mesh.idx.length
  const hasCol = color && !!mesh.col

  // Position bounds for the accessor min/max.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < nV; i++) {
    const x = mesh.pos[i*3], y = mesh.pos[i*3+1], z = mesh.pos[i*3+2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0 }

  // Build the binary buffer: [positions f32][colors u8×4?][indices u32], each
  // section 4-byte aligned (all already are: 12/4/4-byte elements).
  const align4 = (n) => (n + 3) & ~3
  const posBytes = nV * 12
  const colBytes = hasCol ? nV * 4 : 0
  const idxBytes = nIdx * 4
  const posOff = 0
  const colOff = posOff + align4(posBytes)
  const idxOff = colOff + align4(colBytes)
  const binLen = idxOff + align4(idxBytes)
  const bin = new Uint8Array(binLen)
  const bv = new DataView(bin.buffer)
  for (let i = 0; i < nV; i++) {
    bv.setFloat32(posOff + i*12, mesh.pos[i*3], true)
    bv.setFloat32(posOff + i*12 + 4, mesh.pos[i*3+1], true)
    bv.setFloat32(posOff + i*12 + 8, mesh.pos[i*3+2], true)
  }
  if (hasCol) {
    for (let i = 0; i < nV; i++) {
      bin[colOff + i*4] = byte(mesh.col[i*3]); bin[colOff + i*4+1] = byte(mesh.col[i*3+1])
      bin[colOff + i*4+2] = byte(mesh.col[i*3+2]); bin[colOff + i*4+3] = 255
    }
  }
  for (let i = 0; i < nIdx; i++) bv.setUint32(idxOff + i*4, mesh.idx[i], true)

  // Accessors: 0 POSITION, [1 COLOR_0], last = indices.
  const accessors = [
    { bufferView: 0, componentType: 5126, count: nV, type: 'VEC3',
      min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  ]
  const bufferViews = [{ buffer: 0, byteOffset: posOff, byteLength: posBytes, target: 34962 }]
  const attributes = { POSITION: 0 }
  if (hasCol) {
    attributes.COLOR_0 = accessors.length
    accessors.push({ bufferView: bufferViews.length, componentType: 5121, normalized: true, count: nV, type: 'VEC4' })
    bufferViews.push({ buffer: 0, byteOffset: colOff, byteLength: colBytes, target: 34962 })
  }
  const idxAccessor = accessors.length
  accessors.push({ bufferView: bufferViews.length, componentType: 5125, count: nIdx, type: 'SCALAR' })
  bufferViews.push({ buffer: 0, byteOffset: idxOff, byteLength: idxBytes, target: 34963 })

  const gltf = {
    asset: { version: '2.0', generator: 'websfm' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: idxAccessor, mode: 4 }] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLen }],
  }

  // JSON chunk (padded with spaces to 4 bytes), then BIN chunk (padded with 0).
  const enc = new TextEncoder()
  let jsonBytes = enc.encode(JSON.stringify(gltf))
  const jsonPad = (4 - (jsonBytes.length & 3)) & 3
  if (jsonPad) { const p = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20); p.set(jsonBytes); jsonBytes = p }
  // bin is already 4-aligned (binLen).
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)          // version
  dv.setUint32(8, total, true)      // total length
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(jsonBytes, 20)
  const binChunkOff = 20 + jsonBytes.length
  dv.setUint32(binChunkOff, bin.length, true)
  dv.setUint32(binChunkOff + 4, 0x004e4942, true) // 'BIN\0'
  out.set(bin, binChunkOff + 8)
  return out
}

// ── Reconstruction → JSON (cameras + tracks) ─────────────────────────────────
// cameras: [{ uuid, R, t, K? }], points: [{ x, y, z, color?, views? }]. Camera
// centres (C = −Rᵀt) are precomputed for convenience. Returns a plain object.
export function reconstructionToJson(cameras, points, crs = 'local') {
  return {
    format: 'websfm-model',
    version: 1,
    crs,
    cameras: cameras.map((c) => ({
      uuid: c.uuid,
      R: c.R,
      t: c.t,
      K: c.K ? { fx: c.K.fx, fy: c.K.fy, cx: c.K.cx, cy: c.K.cy } : null,
      center: cameraCenter(c.R, c.t),
    })),
    points: points.map((p) => ({
      x: p.x, y: p.y, z: p.z,
      color: p.color ?? null,
      views: p.views ?? [],
    })),
  }
}

// Camera centre in world coords: C = −Rᵀ·t (R row-major, t = [x,y,z]).
function cameraCenter(R, t) {
  if (!R || !t) return null
  return [
    -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
    -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
    -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
  ]
}

// ── DEM → ESRI ASCII grid (.asc) ─────────────────────────────────────────────
// dem: { width, height, gsd, originX (left), originY (top), data:Float32Array
// (row-major, top→bottom; NaN = nodata) }. Dependency-free, float-preserving, and
// read by QGIS/ArcGIS/GDAL. Pair with a .prj carrying the CRS.
export function demToAsciiGrid(dem, { nodata = -9999 } = {}) {
  const { width, height, gsd, originX, originY, data } = dem
  const yllcorner = originY - height * gsd
  const head =
    `ncols ${width}\n` +
    `nrows ${height}\n` +
    `xllcorner ${originX}\n` +
    `yllcorner ${yllcorner}\n` +
    `cellsize ${gsd}\n` +
    `NODATA_value ${nodata}\n`
  // Row 0 is the northernmost (top) row, which is exactly what ASCII grid wants.
  const rows = new Array(height)
  for (let r = 0; r < height; r++) {
    const row = new Array(width)
    for (let c = 0; c < width; c++) {
      const v = data[r * width + c]
      row[c] = Number.isFinite(v) ? v : nodata
    }
    rows[r] = row.join(' ')
  }
  return head + rows.join('\n') + '\n'
}

// ── DEM → GeoTIFF (single-band float32) ──────────────────────────────────────
// NaN holes are written as `nodata` and flagged via the GDAL_NODATA tag. crs:
// { code: number|null, geographic: boolean } — the EPSG code goes in the GeoKeys.
// `deflate` (optional, injected): an async (Uint8Array)→Uint8Array zlib
// compressor; when given, the strip is DEFLATE-compressed (TIFF Compression tag
// 8) — the compressor is injected because CompressionStream is DOM/worker-only,
// not this pure path (so demToGeoTiff becomes async only when compressing).
export async function demToGeoTiff(dem, { crs = {}, nodata = -9999, deflate = null } = {}) {
  const { width, height, gsd, originX, originY, data } = dem
  const buf = new Float32Array(width * height)
  for (let i = 0; i < buf.length; i++) buf[i] = Number.isFinite(data[i]) ? data[i] : nodata
  let strip = new Uint8Array(buf.buffer)
  let compression = 1
  if (deflate) { strip = await deflate(strip); compression = 8 }
  return writeGeoTiff({
    width, height,
    samples: [{ bits: 32, format: 3 }],
    photometric: 1, extraSamples: null,
    data: strip, compression,
    pixelScale: [gsd, gsd, 0],
    tiepoint: [0, 0, 0, originX, originY, 0],
    geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
    gdalNoData: nodata,
  })
}

// ── DEM → Cloud-Optimized GeoTIFF ────────────────────────────────────────────
// Same pixels, internally tiled with halving overviews, so a viewer can pull a
// preview (or one window) with a couple of range requests instead of the whole
// file. writeCogDeflate takes the SAME injected `deflate` callback as above —
// it just calls it once per tile per level rather than once for the image.
export async function demToCog(dem, { crs = {}, nodata = -9999, deflate = null, tileSize = 512 } = {}) {
  const { width, height, gsd, originX, originY, data } = dem
  const buf = new Float32Array(width * height)
  for (let i = 0; i < buf.length; i++) buf[i] = Number.isFinite(data[i]) ? data[i] : nodata
  return writeCogDeflate({
    width, height,
    samples: [{ bits: 32, format: 3 }],
    photometric: 1, extraSamples: null,
    // A COG writer needs the TypedArray, not packed bytes: it has to interpret
    // pixels to tile them and to box-average the overviews.
    data: buf, tileSize,
    pixelScale: [gsd, gsd, 0],
    tiepoint: [0, 0, 0, originX, originY, 0],
    geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
    gdalNoData: nodata,
  }, deflate)
}

// ── Ortho → GeoTIFF (RGBA) ───────────────────────────────────────────────────
// ortho: { width, height, rgba:Uint8Array (w·h·4) }. geo carries the DEM's
// geotransform (ortho shares the DEM grid). crs + deflate as in demToGeoTiff.
export async function orthoToGeoTiff(ortho, geo, { crs = {}, deflate = null } = {}) {
  const { width, height, rgba } = ortho
  const { gsd, originX, originY } = geo
  let strip = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  let compression = 1
  if (deflate) { strip = await deflate(strip); compression = 8 }
  return writeGeoTiff({
    width, height,
    samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })),
    photometric: 2, extraSamples: [2], // unassociated alpha
    data: strip, compression,
    pixelScale: [gsd, gsd, 0],
    tiepoint: [0, 0, 0, originX, originY, 0],
    geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
  })
}

// ── Ortho → Cloud-Optimized GeoTIFF ──────────────────────────────────────────
// Overviews box-average the RGBA; alpha averages with it, so a half-covered
// overview cell is half-transparent rather than snapping to opaque.
export async function orthoToCog(ortho, geo, { crs = {}, deflate = null, tileSize = 512 } = {}) {
  const { width, height, rgba } = ortho
  const { gsd, originX, originY } = geo
  const data = rgba instanceof Uint8Array
    ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  return writeCogDeflate({
    width, height,
    samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })),
    photometric: 2, extraSamples: [2], // unassociated alpha
    data, tileSize,
    pixelScale: [gsd, gsd, 0],
    tiepoint: [0, 0, 0, originX, originY, 0],
    geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
  }, deflate)
}

// ── Raster world file (.wld / .pgw) for a georeferenced image ─────────────────
// geo: { gsd, originX (left corner), originY (top corner) }. Six lines; lines 5–6
// are the CENTRE of the upper-left pixel (world-file convention).
export function rasterWorldFile(geo) {
  const { gsd, originX, originY } = geo
  return [
    gsd,               // A: x pixel size
    0,                 // D: rotation (y)
    0,                 // B: rotation (x)
    -gsd,              // E: y pixel size (negative: rows go south)
    originX + gsd / 2, // C: x of upper-left pixel centre
    originY - gsd / 2, // F: y of upper-left pixel centre
  ].join('\n') + '\n'
}

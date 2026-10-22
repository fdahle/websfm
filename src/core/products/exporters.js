// Pure exporters: turn reconstruction / product data into standard interchange
// formats. No DOM/Blob here. The writers whose output scales with points / faces /
// cells are generators of bounded PARTS (core/io/parts.js); the caller folds them
// into a Blob (utils/blobParts.js partsToBlob) and triggers the download.

import { flatAxes } from './flatAxes.js'
import { MAX_FLOAT64_XYZ_POINTS } from '../bufferLimit.js'
import { writeGeoTiff, writeCogDeflate, geoKeysForEpsg } from './geotiff.js'
import { bigSet } from '../bigCollections.js'
import { applySimilarity } from './georef.js'
import { createVoxelAccumulator } from '../dense/voxelAccumulator.js'
import { PART_BYTES, PART_CHARS, lineParts, recordParts, lazyArray } from '../io/parts.js'

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
    ? flat.col
      ? (i) => [flat.col[i * 3], flat.col[i * 3 + 1], flat.col[i * 3 + 2]]
      : () => null
    : (i) => points[i].color
  const hadNormals = flat ? !!flat.nrm : n > 0 && !!points[0]?.normal
  if (hadNormals) onLog?.('Export: normals dropped (georeference/downsample applied)', 'info', 'Export')
  const attrs = flat && flat.attributes && Object.keys(flat.attributes).length ? flat.attributes : null

  // Pass 1: the transformed bbox. No copy of the cloud: `at(i)` transforms one point
  // whenever it is needed, so a 95 M-point export does not build a 2.3 GB Float64
  // plane next to the cloud (the browser refuses one past 2 GiB, core/bufferLimit.js).
  const at = sim ? (i) => applySimilarity(sim, getP(i)) : getP
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const p = at(i)
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
    if (p[2] < minZ) minZ = p[2]
    if (p[2] > maxZ) maxZ = p[2]
  }
  if (!down) {
    // Every point is written, so its transformed position is a full plane: Float64 as
    // before when it fits one buffer, else Float32 relative to the bbox centre with
    // `origin` (core/products/flatAxes.js; sub-millimetre over a kilometre-sized survey).
    const relative = n > MAX_FLOAT64_XYZ_POINTS
    const origin = relative ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] : null
    const xyz = relative ? new Float32Array(n * 3) : new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      const p = at(i)
      if (relative) {
        xyz[i * 3] = p[0] - origin[0]
        xyz[i * 3 + 1] = p[1] - origin[1]
        xyz[i * 3 + 2] = p[2] - origin[2]
      } else {
        xyz[i * 3] = p[0]
        xyz[i * 3 + 1] = p[1]
        xyz[i * 3 + 2] = p[2]
      }
    }
    if (relative)
      onLog?.(
        `Export: ${n.toLocaleString()} points written relative to an origin (one Float64 plane would pass the 2 GiB buffer limit)`,
        'debug',
        'Export',
      )
    const col = hasCol ? new Uint8Array(n * 3) : null
    if (col)
      for (let i = 0; i < n; i++) {
        const c = getC(i) || [200, 200, 200]
        col.set(c.map(byte), i * 3)
      }
    // Shared, not copied: nothing downstream writes into them.
    const attributes = attrs ? Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, v.subarray(0, n)])) : null
    return {
      count: n,
      pos: xyz,
      ...(origin ? { origin } : {}),
      ...(col ? { col } : {}),
      ...(attributes ? { attributes } : {}),
    }
  }
  if (attrs)
    return firstPointPerCell({
      n,
      at,
      hasCol,
      getC,
      attrs,
      cell,
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      onLog,
    })

  // Pass 2: voxel downsample. Shift the frame to a cell-aligned origin near the
  // bbox so the accumulator's Float32 finalize keeps precision on CRS-sized
  // coordinates; the shift is added back into the Float64 output.
  const shift = [Math.floor(minX / cell) * cell, Math.floor(minY / cell) * cell, Math.floor(minZ / cell) * cell]
  const acc = createVoxelAccumulator(cell, {
    minX: minX - shift[0],
    minY: minY - shift[1],
    minZ: minZ - shift[2],
    maxX: maxX - shift[0],
    maxY: maxY - shift[1],
    maxZ: maxZ - shift[2],
  })
  for (let i = 0; i < n; i++) {
    const c = (hasCol && getC(i)) || [200, 200, 200]
    const p = at(i)
    acc.add(p[0] - shift[0], p[1] - shift[1], p[2] - shift[2], byte(c[0]), byte(c[1]), byte(c[2]))
  }
  const merged = acc.finalizeFlat() // [x,y,z,r,g,b] per cell
  const m = merged.length / 6
  // Past the buffer wall the cells stay relative to `shift` (their Float32 frame already).
  const relative = m > MAX_FLOAT64_XYZ_POINTS
  const pos = relative ? new Float32Array(m * 3) : new Float64Array(m * 3)
  const col = hasCol ? new Uint8Array(m * 3) : null
  for (let i = 0; i < m; i++) {
    const s = i * 6,
      d = i * 3
    if (relative) {
      pos[d] = merged[s]
      pos[d + 1] = merged[s + 1]
      pos[d + 2] = merged[s + 2]
    } else {
      pos[d] = merged[s] + shift[0]
      pos[d + 1] = merged[s + 1] + shift[1]
      pos[d + 2] = merged[s + 2] + shift[2]
    }
    if (col) {
      col[d] = merged[s + 3]
      col[d + 1] = merged[s + 4]
      col[d + 2] = merged[s + 5]
    }
  }
  onLog?.(
    `Export: voxel downsample ${cell} → ${m.toLocaleString()} of ${n.toLocaleString()} points kept`,
    'info',
    'Export',
  )
  return { count: m, pos, ...(relative ? { origin: shift } : {}), ...(col ? { col } : {}) }
}

// Voxel downsample that keeps the first point of each cell, whole: its (already
// transformed) position, colour and every attribute. Cell ids are packed into one
// number when the grid fits 2⁵³ cells (the usual case), else a string key — never a
// per-point object.
function firstPointPerCell({ n, at, hasCol, getC, attrs, cell, min, max, onLog }) {
  const dims = [0, 1, 2].map((a) => Math.floor((max[a] - min[a]) / cell) + 1)
  const packed = dims[0] * dims[1] * dims[2] <= Number.MAX_SAFE_INTEGER
  const seen = bigSet(n) // one key per occupied cell: past 2²⁴ a plain Set throws
  const keep = new Uint32Array(n)
  let m = 0
  for (let i = 0; i < n; i++) {
    const p = at(i)
    const ix = Math.floor((p[0] - min[0]) / cell)
    const iy = Math.floor((p[1] - min[1]) / cell)
    const iz = Math.floor((p[2] - min[2]) / cell)
    const key = packed ? ix + dims[0] * (iy + dims[1] * iz) : `${ix},${iy},${iz}`
    if (seen.has(key)) continue
    seen.add(key)
    keep[m++] = i
  }
  // Past the buffer wall the kept points are stored relative to the grid's corner.
  const origin = m > MAX_FLOAT64_XYZ_POINTS ? min : null
  const pos = origin ? new Float32Array(m * 3) : new Float64Array(m * 3)
  const col = hasCol ? new Uint8Array(m * 3) : null
  const attributes = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, new v.constructor(m)]))
  const lists = Object.entries(attrs).map(([k, v]) => [v, attributes[k]])
  for (let j = 0; j < m; j++) {
    const i = keep[j]
    const p = at(i)
    if (origin) {
      pos[j * 3] = p[0] - origin[0]
      pos[j * 3 + 1] = p[1] - origin[1]
      pos[j * 3 + 2] = p[2] - origin[2]
    } else {
      pos[j * 3] = p[0]
      pos[j * 3 + 1] = p[1]
      pos[j * 3 + 2] = p[2]
    }
    if (col) {
      const c = getC(i) || [200, 200, 200]
      col[j * 3] = byte(c[0])
      col[j * 3 + 1] = byte(c[1])
      col[j * 3 + 2] = byte(c[2])
    }
    for (const [src, dst] of lists) dst[j] = src[i]
  }
  onLog?.(
    `Export: voxel downsample ${cell} → ${m.toLocaleString()} of ${n.toLocaleString()} points kept ` +
      `(one real point per cell, so its attributes ${Object.keys(attrs).join(', ')} stay observed values)`,
    'info',
    'Export',
  )
  return { count: m, pos, ...(origin ? { origin } : {}), ...(col ? { col } : {}), attributes }
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
    pos[i * 3] = p[0]
    pos[i * 3 + 1] = p[1]
    pos[i * 3 + 2] = p[2]
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
// Yields parts: Uint8Arrays for binary (little-endian body), strings for ASCII.
export function* cloudToPlyParts(
  points,
  {
    binary = true,
    color = true,
    normals = true,
    attributes = true,
    partBytes = PART_BYTES,
    partChars = PART_CHARS,
  } = {},
) {
  const flat = points && points.pos ? points : null
  const n = flat ? (flat.count ?? flat.pos.length / 3) : points.length
  const [getX, getY, getZ] = flat ? flatAxes(flat) : [(i) => points[i].x, (i) => points[i].y, (i) => points[i].z]
  const getC = flat
    ? flat.col
      ? (i) => [flat.col[i * 3], flat.col[i * 3 + 1], flat.col[i * 3 + 2]]
      : () => null
    : (i) => points[i].color
  // Emit normals only when present (flat .nrm, or per-point .normal on the sample).
  const hasNrm = normals && (flat ? !!flat.nrm : points.length > 0 && !!points[0].normal)
  const getN = flat
    ? (i) => [flat.nrm[i * 3], flat.nrm[i * 3 + 1], flat.nrm[i * 3 + 2]]
    : (i) => points[i].normal || [0, 0, 0]
  const fields = attributes && flat ? plyAttributeFields(flat.attributes, n) : []
  const props =
    'property float x\nproperty float y\nproperty float z\n' +
    (hasNrm ? 'property float nx\nproperty float ny\nproperty float nz\n' : '') +
    (color ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '') +
    fields.map((f) => `property ${f.type} ${f.name}\n`).join('')
  const header =
    'ply\n' +
    `format ${binary ? 'binary_little_endian' : 'ascii'} 1.0\n` +
    'comment generated by websfm\n' +
    `element vertex ${n}\n` +
    props +
    'end_header\n'

  if (!binary) {
    // An empty cloud keeps the historical lone newline after the header.
    yield* lineParts(
      header,
      n,
      (i) => {
        let s = `${getX(i)} ${getY(i)} ${getZ(i)}`
        if (hasNrm) {
          const nn = getN(i)
          s += ` ${nn[0]} ${nn[1]} ${nn[2]}`
        }
        if (color) {
          const c = getC(i) || [200, 200, 200]
          s += ` ${byte(c[0])} ${byte(c[1])} ${byte(c[2])}`
        }
        for (const f of fields) s += ` ${f.text(f.values[i])}`
        return s
      },
      { emptyBody: '\n', partChars },
    )
    return
  }

  yield new TextEncoder().encode(header)
  // 3×f32 xyz (12) [+ 3×f32 normals (12)] [+ 3×u8 rgb (3)] [+ attributes].
  const NRM = hasNrm ? 12 : 0
  const ATTR = color ? 12 + NRM + 3 : 12 + NRM
  const STRIDE = ATTR + fields.reduce((sum, f) => sum + f.size, 0)
  yield* recordParts(
    n,
    STRIDE,
    (dv, o, i) => {
      dv.setFloat32(o, getX(i), true)
      dv.setFloat32(o + 4, getY(i), true)
      dv.setFloat32(o + 8, getZ(i), true)
      if (hasNrm) {
        const nn = getN(i)
        dv.setFloat32(o + 12, nn[0], true)
        dv.setFloat32(o + 16, nn[1], true)
        dv.setFloat32(o + 20, nn[2], true)
      }
      if (color) {
        const c = getC(i) || [200, 200, 200]
        dv.setUint8(o + 12 + NRM, byte(c[0]))
        dv.setUint8(o + 13 + NRM, byte(c[1]))
        dv.setUint8(o + 14 + NRM, byte(c[2]))
      }
      let a = o + ATTR
      for (const f of fields) {
        f.set(dv, a, f.values[i])
        a += f.size
      }
    },
    partBytes,
  )
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
const PLY_RESERVED = new Set([
  'x',
  'y',
  'z',
  'nx',
  'ny',
  'nz',
  'red',
  'green',
  'blue',
  'alpha',
  'diffuse_red',
  'diffuse_green',
  'diffuse_blue',
  'vertex_indices',
  'vertex_index',
])

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
// (Uint8Array parts) by default; ASCII (string parts) when binary:false. Faces are
// triangles (list: uchar count=3 + 3×int vertex indices).
export function* meshToPlyParts(
  mesh,
  { binary = true, color = true, partBytes = PART_BYTES, partChars = PART_CHARS } = {},
) {
  const nV = mesh.nVerts ?? mesh.pos.length / 3
  const nF = mesh.count ?? mesh.idx.length / 3
  const hasCol = color && !!mesh.col
  const vprops =
    'property float x\nproperty float y\nproperty float z\n' +
    (hasCol ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '')
  const header =
    'ply\n' +
    `format ${binary ? 'binary_little_endian' : 'ascii'} 1.0\n` +
    'comment generated by websfm\n' +
    `element vertex ${nV}\n` +
    vprops +
    `element face ${nF}\n` +
    'property list uchar int vertex_indices\n' +
    'end_header\n'

  if (!binary) {
    yield* lineParts(
      header,
      nV + nF,
      (k) => {
        if (k >= nV) {
          const f = k - nV
          return `3 ${mesh.idx[f * 3]} ${mesh.idx[f * 3 + 1]} ${mesh.idx[f * 3 + 2]}`
        }
        let s = `${mesh.pos[k * 3]} ${mesh.pos[k * 3 + 1]} ${mesh.pos[k * 3 + 2]}`
        if (hasCol) s += ` ${byte(mesh.col[k * 3])} ${byte(mesh.col[k * 3 + 1])} ${byte(mesh.col[k * 3 + 2])}`
        return s
      },
      { partChars },
    )
    return
  }

  yield new TextEncoder().encode(header)
  const vStride = 12 + (hasCol ? 3 : 0)
  yield* recordParts(
    nV,
    vStride,
    (dv, o, i) => {
      dv.setFloat32(o, mesh.pos[i * 3], true)
      dv.setFloat32(o + 4, mesh.pos[i * 3 + 1], true)
      dv.setFloat32(o + 8, mesh.pos[i * 3 + 2], true)
      if (hasCol) {
        dv.setUint8(o + 12, byte(mesh.col[i * 3]))
        dv.setUint8(o + 13, byte(mesh.col[i * 3 + 1]))
        dv.setUint8(o + 14, byte(mesh.col[i * 3 + 2]))
      }
    },
    partBytes,
  )
  // uchar count + 3×int32
  yield* recordParts(
    nF,
    13,
    (dv, o, f) => {
      dv.setUint8(o, 3)
      dv.setInt32(o + 1, mesh.idx[f * 3], true)
      dv.setInt32(o + 5, mesh.idx[f * 3 + 1], true)
      dv.setInt32(o + 9, mesh.idx[f * 3 + 2], true)
    },
    partBytes,
  )
}

// ── Mesh → OBJ (Wavefront) ───────────────────────────────────────────────────
// mesh as in meshToPlyParts. `v x y z [r g b]` (the MeshLab/CloudCompare
// vertex-colour extension, r/g/b in 0–1) + `f a b c` with **1-based** indices (the
// classic OBJ bug — OBJ counts vertices from 1). Yields string parts.
//
// A textured mesh (`texture` = { mtl, groups } with `mesh.uv`) instead writes
// `mtllib`, one `vt u v` per vertex (OBJ's v runs up from the bottom of the image, ours
// down from the top: v' = 1 − v), and its faces page by page under `usemtl atlas-k`, as
// `f a/a b/b c/c` (each vertex has exactly one UV, so the indices coincide). Vertex
// colour is left out: viewers that read it would tint the texture.
export function* meshToObjParts(mesh, { color = true, texture = null, partChars = PART_CHARS } = {}) {
  const nV = mesh.nVerts ?? mesh.pos.length / 3
  const nF = mesh.count ?? mesh.idx.length / 3
  const textured = !!(texture?.groups?.length && mesh.uv)
  const hasCol = color && !!mesh.col && !textured
  if (!textured) {
    yield* lineParts(
      '# generated by websfm\n',
      nV + nF,
      (k) => {
        // +1: OBJ vertex indices are 1-based.
        if (k >= nV) {
          const f = k - nV
          return `f ${mesh.idx[f * 3] + 1} ${mesh.idx[f * 3 + 1] + 1} ${mesh.idx[f * 3 + 2] + 1}`
        }
        let s = `v ${mesh.pos[k * 3]} ${mesh.pos[k * 3 + 1]} ${mesh.pos[k * 3 + 2]}`
        if (hasCol)
          s += ` ${(byte(mesh.col[k * 3]) / 255).toFixed(6)} ${(byte(mesh.col[k * 3 + 1]) / 255).toFixed(6)} ${(byte(mesh.col[k * 3 + 2]) / 255).toFixed(6)}`
        return s
      },
      { partChars },
    )
    return
  }
  // Face lines in page order, with a usemtl line opening each group.
  const groupOf = []
  let total = 0
  for (const g of texture.groups) {
    groupOf.push({ at: total, g })
    total += g.count + 1
  }
  let gi = 0 // lineParts asks for lines in order, so the group cursor only moves on
  yield* lineParts(
    `# generated by websfm\nmtllib ${texture.mtl}\n`,
    2 * nV + total,
    (k) => {
      if (k < nV) return `v ${mesh.pos[k * 3]} ${mesh.pos[k * 3 + 1]} ${mesh.pos[k * 3 + 2]}`
      if (k < 2 * nV) {
        const i = k - nV
        return `vt ${mesh.uv[i * 2].toFixed(6)} ${(1 - mesh.uv[i * 2 + 1]).toFixed(6)}`
      }
      const r = k - 2 * nV
      while (gi + 1 < groupOf.length && r >= groupOf[gi + 1].at) gi++
      const { at, g } = groupOf[gi]
      if (r === at) return `usemtl atlas-${g.page}`
      const f = g.start + (r - at - 1)
      const a = mesh.idx[f * 3] + 1,
        b = mesh.idx[f * 3 + 1] + 1,
        c = mesh.idx[f * 3 + 2] + 1
      return `f ${a}/${a} ${b}/${b} ${c}/${c}`
    },
    { partChars },
  )
}

// The MTL file of a textured OBJ: one unlit material per atlas page (illum 0 = colour
// only, no lighting model), its image named relative to the MTL.
export function objMaterialLibrary(pageFiles) {
  return (
    '# generated by websfm\n' +
    pageFiles
      .map((file, k) => `newmtl atlas-${k}\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nd 1\nillum 0\nmap_Kd ${file}\n`)
      .join('\n')
  )
}

// ── Mesh → STL (binary) ──────────────────────────────────────────────────────
// 80-byte header + u32 triangle count + per triangle: normal f32×3 (per-face,
// from the cross product), 3 vertices f32×3, u16 attribute (0). No colour (STL
// vertex colour is non-standard). A degenerate triangle yields a zero normal
// rather than NaN. Yields Uint8Array parts.
export function* meshToStlParts(mesh, { partBytes = PART_BYTES } = {}) {
  const nF = mesh.count ?? mesh.idx.length / 3
  const head = new Uint8Array(84)
  // 80-byte header (zeroed) then triangle count.
  new TextEncoder().encodeInto('websfm binary STL', head.subarray(0, 80))
  new DataView(head.buffer).setUint32(80, nF, true)
  yield head
  yield* recordParts(
    nF,
    50,
    (dv, o, f) => {
      const a = mesh.idx[f * 3],
        b = mesh.idx[f * 3 + 1],
        c = mesh.idx[f * 3 + 2]
      const ax = mesh.pos[a * 3],
        ay = mesh.pos[a * 3 + 1],
        az = mesh.pos[a * 3 + 2]
      const bx = mesh.pos[b * 3],
        by = mesh.pos[b * 3 + 1],
        bz = mesh.pos[b * 3 + 2]
      const cx = mesh.pos[c * 3],
        cy = mesh.pos[c * 3 + 1],
        cz = mesh.pos[c * 3 + 2]
      // Face normal = (b−a)×(c−a), normalized; (0,0,0) for a degenerate triangle.
      const ux = bx - ax,
        uy = by - ay,
        uz = bz - az
      const vx = cx - ax,
        vy = cy - ay,
        vz = cz - az
      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx
      const len = Math.hypot(nx, ny, nz)
      if (len > 0) {
        nx /= len
        ny /= len
        nz /= len
      } else {
        nx = ny = nz = 0
      }
      dv.setFloat32(o, nx, true)
      dv.setFloat32(o + 4, ny, true)
      dv.setFloat32(o + 8, nz, true)
      dv.setFloat32(o + 12, ax, true)
      dv.setFloat32(o + 16, ay, true)
      dv.setFloat32(o + 20, az, true)
      dv.setFloat32(o + 24, bx, true)
      dv.setFloat32(o + 28, by, true)
      dv.setFloat32(o + 32, bz, true)
      dv.setFloat32(o + 36, cx, true)
      dv.setFloat32(o + 40, cy, true)
      dv.setFloat32(o + 44, cz, true)
      // attribute byte count u16 = 0 (o+48)
    },
    partBytes,
  )
}

// ── Mesh → GLB (binary glTF 2.0) ─────────────────────────────────────────────
// A dependency-free single-buffer GLB: one mesh with POSITION (f32 VEC3) + optional
// COLOR_0 (u8 VEC4 normalized) + indices (u32 SCALAR). Correct 4-byte alignment;
// POSITION carries min/max (required by the spec, and many viewers frame on it).
//
// A textured mesh (`texture` = { pages: [{ bytes, type }], groups: [{ page, start,
// count }] } with `mesh.uv`, core/products/texture/) adds TEXCOORD_0 and one primitive
// per atlas page, each its own index range of the one index buffer, with an unlit
// material (KHR_materials_unlit: the photos already hold the light) whose base colour
// is that page, embedded as JPEG. COLOR_0 is then left out: glTF multiplies it into
// the texture, darkening it by the vertex colours.
//
// `origin` is subtracted from every position (a 3D Tiles payload is tile-local);
// `yUp` turns Z-up into glTF's Y-up (x, z, −y), which 3D Tiles content expects;
// `translation` (Z-up, like `origin`) becomes the node's translation, so a tile of a
// hierarchy stores Float32 positions around its own centre (see tiles3d.js).
// Yields Uint8Array parts: the container header + JSON chunk + BIN chunk header,
// then the BIN sections.
export function* meshToGlbParts(
  mesh,
  { color = true, texture = null, origin = null, yUp = false, translation = null, partBytes = PART_BYTES } = {},
) {
  const nV = mesh.nVerts ?? mesh.pos.length / 3
  const nIdx = mesh.idx.length
  const textured = !!(texture?.pages?.length && texture.groups?.length && mesh.uv)
  const hasCol = color && !!mesh.col && !textured
  const [ox, oy, oz] = origin ?? [0, 0, 0]
  // Position i in the file's frame.
  const P = [0, 0, 0]
  const at = (i) => {
    const x = mesh.pos[i * 3] - ox,
      y = mesh.pos[i * 3 + 1] - oy,
      z = mesh.pos[i * 3 + 2] - oz
    if (yUp) {
      P[0] = x
      P[1] = z
      P[2] = -y
    } else {
      P[0] = x
      P[1] = y
      P[2] = z
    }
    return P
  }

  // Position bounds for the accessor min/max.
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < nV; i++) {
    const p = at(i)
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a]
      if (p[a] > max[a]) max[a] = p[a]
    }
  }
  if (!Number.isFinite(min[0])) {
    min.fill(0)
    max.fill(0)
  }

  // The binary buffer: [positions f32][colors u8×4?][uvs f32×2?][indices u32][images?],
  // each section 4-byte aligned.
  const align4 = (n) => (n + 3) & ~3
  const sections = []
  let binLen = 0
  const section = (byteLength) => {
    const off = binLen
    sections.push({ off, byteLength })
    binLen += align4(byteLength)
    return off
  }
  const posOff = section(nV * 12)
  const colOff = hasCol ? section(nV * 4) : 0
  const uvOff = textured ? section(nV * 8) : 0
  const idxOff = section(nIdx * 4)
  // A page with a `uri` instead of `bytes` stays a file beside the .glb (3D Tiles tiles
  // share one set of atlas pages).
  const imgOffs = textured ? texture.pages.map((p) => (p.uri ? -1 : section(p.bytes.length))) : []

  const accessors = [{ bufferView: 0, componentType: 5126, count: nV, type: 'VEC3', min, max }]
  const bufferViews = [{ buffer: 0, byteOffset: posOff, byteLength: nV * 12, target: 34962 }]
  const attributes = { POSITION: 0 }
  if (hasCol) {
    attributes.COLOR_0 = accessors.length
    accessors.push({ bufferView: bufferViews.length, componentType: 5121, normalized: true, count: nV, type: 'VEC4' })
    bufferViews.push({ buffer: 0, byteOffset: colOff, byteLength: nV * 4, target: 34962 })
  }
  if (textured) {
    attributes.TEXCOORD_0 = accessors.length
    accessors.push({ bufferView: bufferViews.length, componentType: 5126, count: nV, type: 'VEC2' })
    bufferViews.push({ buffer: 0, byteOffset: uvOff, byteLength: nV * 8, target: 34962 })
  }
  const idxView = bufferViews.length
  bufferViews.push({ buffer: 0, byteOffset: idxOff, byteLength: nIdx * 4, target: 34963 })
  const gltf = {
    asset: { version: '2.0', generator: 'websfm' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      translation
        ? { mesh: 0, translation: yUp ? [translation[0], translation[2], -translation[1]] : [...translation] }
        : { mesh: 0 },
    ],
    meshes: [{ primitives: [] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLen }],
  }
  if (!textured) {
    gltf.meshes[0].primitives.push({ attributes, indices: accessors.length, mode: 4 })
    accessors.push({ bufferView: idxView, componentType: 5125, count: nIdx, type: 'SCALAR' })
  } else {
    gltf.extensionsUsed = ['KHR_materials_unlit']
    gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }] // linear, trilinear, clamp
    gltf.images = texture.pages.map((p, k) => {
      if (p.uri) return { uri: p.uri }
      bufferViews.push({ buffer: 0, byteOffset: imgOffs[k], byteLength: p.bytes.length })
      return { bufferView: bufferViews.length - 1, mimeType: p.type ?? 'image/jpeg' }
    })
    gltf.textures = texture.pages.map((_, k) => ({ sampler: 0, source: k }))
    gltf.materials = texture.pages.map((_, k) => ({
      name: `atlas-${k}`,
      doubleSided: true,
      pbrMetallicRoughness: { baseColorTexture: { index: k }, metallicFactor: 0, roughnessFactor: 1 },
      extensions: { KHR_materials_unlit: {} },
    }))
    for (const g of texture.groups) {
      if (!g.count) continue
      gltf.meshes[0].primitives.push({ attributes, indices: accessors.length, material: g.page, mode: 4 })
      accessors.push({
        bufferView: idxView,
        byteOffset: g.start * 12,
        componentType: 5125,
        count: g.count * 3,
        type: 'SCALAR',
      })
    }
  }

  // JSON chunk (padded with spaces to 4 bytes), then BIN chunk (padded with 0).
  const enc = new TextEncoder()
  let jsonBytes = enc.encode(JSON.stringify(gltf))
  const jsonPad = (4 - (jsonBytes.length & 3)) & 3
  if (jsonPad) {
    const p = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20)
    p.set(jsonBytes)
    jsonBytes = p
  }
  const total = 12 + 8 + jsonBytes.length + 8 + binLen
  const head = new Uint8Array(20 + jsonBytes.length + 8)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true) // version
  dv.setUint32(8, total, true) // total length
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  head.set(jsonBytes, 20)
  const binChunkOff = 20 + jsonBytes.length
  dv.setUint32(binChunkOff, binLen, true)
  dv.setUint32(binChunkOff + 4, 0x004e4942, true) // 'BIN\0'
  yield head

  const pad = (bytes) => (align4(bytes) > bytes ? [new Uint8Array(align4(bytes) - bytes)] : [])
  yield* recordParts(
    nV,
    12,
    (bv, o, i) => {
      const p = at(i)
      bv.setFloat32(o, p[0], true)
      bv.setFloat32(o + 4, p[1], true)
      bv.setFloat32(o + 8, p[2], true)
    },
    partBytes,
  )
  yield* pad(nV * 12)
  if (hasCol) {
    yield* recordParts(
      nV,
      4,
      (bv, o, i, bin) => {
        bin[o] = byte(mesh.col[i * 3])
        bin[o + 1] = byte(mesh.col[i * 3 + 1])
        bin[o + 2] = byte(mesh.col[i * 3 + 2])
        bin[o + 3] = 255
      },
      partBytes,
    )
    yield* pad(nV * 4)
  }
  if (textured) {
    yield* recordParts(
      nV,
      8,
      (bv, o, i) => {
        bv.setFloat32(o, mesh.uv[i * 2], true)
        bv.setFloat32(o + 4, mesh.uv[i * 2 + 1], true)
      },
      partBytes,
    )
    yield* pad(nV * 8)
  }
  yield* recordParts(nIdx, 4, (bv, o, i) => bv.setUint32(o, mesh.idx[i], true), partBytes)
  yield* pad(nIdx * 4)
  if (textured) {
    for (const p of texture.pages)
      if (!p.uri) {
        yield p.bytes
        yield* pad(p.bytes.length)
      }
  }
}

// ── Reconstruction → JSON (cameras + tracks) ─────────────────────────────────
// cameras: [{ uuid, R, t, K? }], points: SparsePoints — each point's views written
// as [[uuid, kpIdx], …]. Camera centres (C = −Rᵀt) are
// precomputed for convenience. Returns the document with `points` as a lazyArray
// (core/io/parts.js): serialize it with `jsonParts`, which writes one point at a
// time instead of materializing a copy of the cloud. `tracks: false` writes every
// point's views as [].
export function reconstructionToJson(cameras, points, crs = 'local', { tracks = true } = {}) {
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
    points: lazyArray(points.length, (i) => {
      const views = []
      if (tracks)
        points.forEachView(i, (uuid, kp) => {
          views.push([uuid, kp])
        })
      return { x: points.x(i), y: points.y(i), z: points.z(i), color: points.colorAt(i), views }
    }),
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
// read by QGIS/ArcGIS/GDAL. Pair with a .prj carrying the CRS. Yields string parts.
export function* demToAsciiGridParts(dem, { nodata = -9999, partChars = PART_CHARS } = {}) {
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
  const row = new Array(width)
  yield* lineParts(
    head,
    height,
    (r) => {
      for (let c = 0; c < width; c++) {
        const v = data[r * width + c]
        row[c] = Number.isFinite(v) ? v : nodata
      }
      return row.join(' ')
    },
    { emptyBody: '\n', partChars },
  )
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
  if (deflate) {
    strip = await deflate(strip)
    compression = 8
  }
  return writeGeoTiff({
    width,
    height,
    samples: [{ bits: 32, format: 3 }],
    photometric: 1,
    extraSamples: null,
    data: strip,
    compression,
    pixelScale: [gsd, gsd, 0],
    tiepoint: [0, 0, 0, originX, originY, 0],
    geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
    gdalNoData: nodata,
  })
}

// ── DEM support → GeoTIFF (single-band uint8) ────────────────────────────────
// The DEM's direct-support layer on its plane grid (a tiled DEM's overview): the
// percentage of each cell that points landed in, 0–100 (a single-plane DEM's cells
// are 0 or 100), and `SUPPORT_NODATA` where the DEM has no height. dem.support is
// the 0–255 share core/products/dem.js records.
export const SUPPORT_NODATA = 255
export async function demSupportToGeoTiff(dem, { crs = {}, deflate = null } = {}) {
  const { width, height, gsd, originX, originY, mask, support } = dem
  if (!support) throw new Error('This DEM has no support layer; rebuild it to record one')
  let strip = new Uint8Array(width * height)
  for (let i = 0; i < strip.length; i++) strip[i] = mask[i] ? Math.round((support[i] * 100) / 255) : SUPPORT_NODATA
  let compression = 1
  if (deflate) {
    strip = await deflate(strip)
    compression = 8
  }
  return writeGeoTiff({
    width,
    height,
    samples: [{ bits: 8, format: 1 }],
    photometric: 1,
    extraSamples: null,
    data: strip,
    compression,
    pixelScale: [gsd, gsd, 0],
    tiepoint: [0, 0, 0, originX, originY, 0],
    geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
    gdalNoData: SUPPORT_NODATA,
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
  return writeCogDeflate(
    {
      width,
      height,
      samples: [{ bits: 32, format: 3 }],
      photometric: 1,
      extraSamples: null,
      // A COG writer needs the TypedArray, not packed bytes: it has to interpret
      // pixels to tile them and to box-average the overviews.
      data: buf,
      tileSize,
      pixelScale: [gsd, gsd, 0],
      tiepoint: [0, 0, 0, originX, originY, 0],
      geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
      gdalNoData: nodata,
    },
    deflate,
  )
}

// ── Ortho → GeoTIFF (RGBA) ───────────────────────────────────────────────────
// ortho: { width, height, rgba:Uint8Array (w·h·4) }. geo carries the DEM's
// geotransform (ortho shares the DEM grid). crs + deflate as in demToGeoTiff.
export async function orthoToGeoTiff(ortho, geo, { crs = {}, deflate = null } = {}) {
  const { width, height, rgba } = ortho
  const { gsd, originX, originY } = geo
  let strip = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  let compression = 1
  if (deflate) {
    strip = await deflate(strip)
    compression = 8
  }
  return writeGeoTiff({
    width,
    height,
    samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })),
    photometric: 2,
    extraSamples: [2], // unassociated alpha
    data: strip,
    compression,
    pixelScale: [gsd, gsd, 0],
    tiepoint: [0, 0, 0, originX, originY, 0],
    geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
  })
}

// ── Ortho → Cloud-Optimized GeoTIFF ──────────────────────────────────────────
// Nothing to write: a computed orthophoto IS a COG (workers/ops/products.js
// generateOrtho), so the export copies the stored file. Its GeoTIFF / PNG / JPEG
// forms are streamed out of that file by workers/ops/export.js exportOrtho.
//
// The largest orthophoto exported as one PNG/JPEG (8,192² — a canvas and its encoder
// hold it whole, ~256 MB of RGBA). Larger ones export as a GeoTIFF.
export const MAX_ORTHO_IMAGE_CELLS = 8192 * 8192

// ── Raster world file (.wld / .pgw) for a georeferenced image ─────────────────
// geo: { gsd, originX (left corner), originY (top corner) }. Six lines; lines 5–6
// are the CENTRE of the upper-left pixel (world-file convention).
export function rasterWorldFile(geo) {
  const { gsd, originX, originY } = geo
  return (
    [
      gsd, // A: x pixel size
      0, // D: rotation (y)
      0, // B: rotation (x)
      -gsd, // E: y pixel size (negative: rows go south)
      originX + gsd / 2, // C: x of upper-left pixel centre
      originY - gsd / 2, // F: y of upper-left pixel centre
    ].join('\n') + '\n'
  )
}
